/**
 * Trae SOLO ↔ OpenAI relay translation.
 *
 * The layer that makes a Trae model answer an OpenAI client: it translates the
 * request envelope, then translates the answer back. `src/shim.ts` — which is
 * bound to the WorkBuddy pool, upstream client and catalog — is untouched by
 * this.
 */
import { randomUUID } from 'node:crypto'
import type { TraeStreamEvent } from './trae-sse'
import { SseDecoder, decodeTraeEvent } from './trae-sse'
import { prepareSoloBody } from './trae-upstream'

/** What the gateway must answer when Trae refuses inside the stream. */
export interface TraeFailure {
  code?: number
  message: string
  extra?: unknown
}

export type TraeRelayErrorKind = 'hard_credit' | 'client' | 'server'

/**
 * OpenAI request body → the Trae `llm_utils_chat` envelope.
 *
 * The per-model `function` is the one thing this adds over the plain envelope:
 * a model is only callable through the directory function that listed it
 * (`glm-5.3` exists solely under `solo_work_remote`), and sending it through
 * any other function answers `4001 param is invalid`. A model with no mapping
 * falls back to the caller's own value, then to `solo_work_lite`.
 */
export function traeRequestBody(
  openAiBody: string,
  functionForModel?: (model: string) => string | undefined,
): string {
  let model = ''
  try { model = (JSON.parse(openAiBody) as Record<string, unknown>)['model'] as string ?? '' } catch { model = '' }
  const stamped = typeof model === 'string' ? functionForModel?.(model) : undefined
  return prepareSoloBody(openAiBody, undefined, stamped)
}

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

/** Trae's tool calls arrive under either `function_call` or `function`. */
export function normalizeTraeToolCalls(value: unknown): OpenAIToolCallDelta[] {
  if (!Array.isArray(value)) return []
  const calls: OpenAIToolCallDelta[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const rawFunction = typeof record['function_call'] === 'object' && record['function_call'] !== null
      ? record['function_call'] as Record<string, unknown>
      : typeof record['function'] === 'object' && record['function'] !== null
        ? record['function'] as Record<string, unknown>
        : {}
    const fn: { name?: string; arguments?: string } = {
      ...typeof rawFunction['name'] === 'string' ? { name: rawFunction['name'] } : {},
      ...typeof rawFunction['arguments'] === 'string' ? { arguments: rawFunction['arguments'] } : {},
    }
    calls.push({
      index: typeof record['index'] === 'number' ? record['index'] : calls.length,
      ...typeof record['id'] === 'string' ? { id: record['id'] } : {},
      ...record['type'] === 'function' ? { type: 'function' as const } : {},
      ...Object.keys(fn).length === 0 ? {} : { function: fn },
    })
  }
  return calls
}

/** Recognise the failure Trae hides in an otherwise healthy stream. */
export function traeFailureOf(decoded: TraeStreamEvent): TraeFailure | undefined {
  if (decoded.type !== 'unknown') return undefined
  const payload = decoded.data as Record<string, unknown> | undefined
  const code = typeof payload?.['code'] === 'number' ? payload['code'] : undefined
  if (decoded.event !== 'error' && !(code !== undefined && code >= 4000)) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: typeof payload?.['message'] === 'string' ? payload['message'] : '',
    ...payload?.['extra'] === undefined ? {} : { extra: payload['extra'] },
  }
}

/**
 * A readable message for a failure. Trae's own text is often a generic apology
 * that contradicts the code, so it rides along as detail rather than becoming
 * the message.
 */
export function describeTraeFailure(failure: TraeFailure): string {
  const parts: string[] = []
  if (failure.code !== undefined) parts.push(`code ${failure.code}`)
  if (failure.extra !== undefined) {
    const extra = typeof failure.extra === 'string' ? failure.extra : JSON.stringify(failure.extra)
    if (extra !== '') parts.push(extra.slice(0, 200))
  }
  const detail = failure.message.trim()
  return detail === '' ? parts.join(' · ') : `${parts.join(' · ')} · upstream: ${detail}`
}

/**
 * HTTP status + error kind for an in-stream failure.
 *
 * `1005` is a subscription gate: 402 is what makes a client stop rather than
 * retry, and it is truthful.
 *
 * Everything else follows the class of Trae's own code. Trae reports its
 * outages inside the stream, on the same `event: error` frame a bad request
 * uses, so flattening all of them to 400 told a client that a dead upstream was
 * its own fault - and a client retries 5xx, never 400. The codes are >= 4000 on
 * the wire, so the leading digit is the class. A frame with no code at all is
 * upstream's fault too: there is no client mistake the gateway could name.
 */
export function classifyTraeFailure(failure: TraeFailure): { status: number; kind: TraeRelayErrorKind } {
  if (failure.code === 1005) return { status: 402, kind: 'hard_credit' }
  const code = failure.code
  if (code === undefined) return { status: 502, kind: 'server' }
  if (code >= 5000) return { status: 502, kind: 'server' }
  if (code >= 4290 && code < 4300) return { status: 429, kind: 'client' }
  return { status: 400, kind: 'client' }
}

export interface TraeRelayOptions {
  /** Injected for reproducible chunk ids. */
  id?: string
  created?: number
}

/**
 * Translate a Trae byte stream into an OpenAI chat-completion SSE stream.
 *
 * Terminal behaviour is the part worth stating: Trae may send both an `event:
 * done` and a trailing `[DONE]`, so exactly one finish chunk goes out; a clean
 * EOF with no done event still gets one, because a client waits for a non-null
 * `finish_reason` before it stops; and exactly one `data: [DONE]` closes it.
 */
export function bridgeTraeStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  options: TraeRelayOptions = {},
): ReadableStream<Uint8Array> {
  const id = options.id ?? `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const created = options.created ?? Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const sse = new SseDecoder()
  const reader = source.getReader()
  let cancelled = false
  let sawToolCalls = false
  let emittedFinishReason = false
  let upstreamError: Error | undefined
  // OpenAI-shaped usage, widened past `number` because the cache breakdown
  // nests under `prompt_tokens_details`.
  let usage: Record<string, number | Record<string, number>> | undefined

  const chunk = (delta: Record<string, unknown> | null, finishReason: string | null = null): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finishReason }],
      ...usage === undefined ? {} : { usage },
    })}\n\n`)
  // Clients that follow the OpenAI shape expect `role` on the first chunk.
  // Emitted lazily, right before the first real delta, so a stream that fails
  // immediately never carries a chunk that could read as output.
  let started = false
  const roleChunk = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (started) return
    started = true
    controller.enqueue(chunk({ role: 'assistant', content: '' }))
  }

  const consume = (event: ReturnType<SseDecoder['push']>[number], controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (cancelled) return
    const decoded = decodeTraeEvent(event)
    if (decoded.type === 'unknown') {
      const failure = traeFailureOf(decoded)
      if (failure !== undefined) upstreamError = new Error(describeTraeFailure(failure))
      return
    }
    if (decoded.type === 'delta') {
      const delta: Record<string, unknown> = {}
      if (decoded.text !== '') delta['content'] = decoded.text
      if (decoded.reasoning !== undefined && decoded.reasoning !== '') delta['reasoning_content'] = decoded.reasoning
      const toolCalls = normalizeTraeToolCalls(decoded.toolCalls)
      if (toolCalls.length > 0) {
        sawToolCalls = true
        delta['tool_calls'] = toolCalls
      }
      if (Object.keys(delta).length > 0) {
        roleChunk(controller)
        controller.enqueue(chunk(delta))
      }
      if (decoded.finishReason === undefined) return
    }
    if (decoded.type === 'usage') {
      // Trae's cache counters are a SUBSET of prompt_tokens (OpenAI convention),
      // so they forward under the canonical spelling; dropping them made every
      // session report "0 cache" even when Trae served a warm prefix.
      const details: Record<string, number> = {
        ...decoded.cacheReadTokens === undefined ? {} : { cached_tokens: decoded.cacheReadTokens },
        ...decoded.cacheWriteTokens === undefined ? {} : { cache_write_tokens: decoded.cacheWriteTokens },
      }
      usage = {
        ...decoded.inputTokens === undefined ? {} : { prompt_tokens: decoded.inputTokens },
        ...decoded.outputTokens === undefined ? {} : { completion_tokens: decoded.outputTokens },
        ...decoded.totalTokens === undefined ? {} : { total_tokens: decoded.totalTokens },
        // Omit the details object entirely when Trae sent neither field, so a
        // provider that never reports cache keeps its previous wire shape.
        ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details },
      }
      if (emittedFinishReason) controller.enqueue(chunk(null))
      return
    }
    if (decoded.type !== 'done' && decoded.type !== 'delta') return
    if (emittedFinishReason) return
    // Mark the terminal state before erroring the controller, so the post-loop
    // fallback never enqueues after `controller.error()`.
    emittedFinishReason = true
    if (upstreamError !== undefined) {
      controller.error(upstreamError)
      return
    }
    controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : decoded.finishReason || 'stop'))
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!cancelled) {
          const next = await reader.read()
          if (cancelled) return
          if (next.done) break
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller)
        }
        if (cancelled) return
        for (const event of sse.finish()) consume(event, controller)
        // An upstream failure ends the stream as an error, whether it arrived
        // before the `done` event (errored there) or only at EOF. Returning
        // here matters: the controller is already errored, so the enqueue
        // below would throw instead of closing cleanly.
        if (upstreamError !== undefined) {
          controller.error(upstreamError)
          return
        }
        // A clean EOF is a valid termination even without an explicit done
        // event; the client still needs a non-null finish_reason.
        if (!emittedFinishReason) {
          emittedFinishReason = true
          controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : 'stop'))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (error) {
        if (!cancelled) controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
    cancel(reason) { cancelled = true; return reader.cancel(reason) },
  })
}

/** How far {@link openTraeResponse} reads before giving up on finding a failure. */
const PEEK_MAX_CHUNKS = 64
const PEEK_MAX_BYTES = 262_144

/** Replay the bytes the peek consumed, then drain the rest of the upstream. */
function replaySource(
  buffered: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = buffered[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(chunk)
        return
      }
      if (ended) {
        controller.close()
        return
      }
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  })
}

/**
 * Turn one gateway response into something an OpenAI client can consume.
 *
 * A non-2xx answer becomes a JSON error. A 2xx answer is peeked briefly: a
 * failure that arrives before any output is turned into a real HTTP error
 * rather than a 200 stream that ends empty, and everything peeked is replayed
 * so no output is lost.
 */
export async function openTraeResponse(
  response: Response,
  model: string,
  options: TraeRelayOptions = {},
): Promise<Response> {
  if (!response.ok) {
    // The upstream's own HTTP status is already meaningful (401 means the
    // sign-in died, 429 a rate limit) and flattening it through the in-stream
    // code classifier would throw that away.
    const detail = (await response.text().catch(() => '')).slice(0, 1024)
    return Response.json(
      {
        error: {
          message: detail === '' ? `Trae SOLO returned HTTP ${response.status}` : detail,
          type: 'upstream_error',
          code: response.status,
        },
      },
      { status: response.status },
    )
  }
  const source = response.body
  if (source === null) {
    return Response.json({ error: { message: `Trae SOLO response ${response.status} carried no body`, type: 'upstream_error', code: 502 } }, { status: 502 })
  }
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const sse = new SseDecoder()
  const buffered: Uint8Array[] = []
  let bufferedBytes = 0
  let sawOutput = false
  let failure: TraeFailure | undefined
  let ended = false
  const inspect = (events: ReturnType<SseDecoder['push']>): void => {
    for (const event of events) {
      const decoded = decodeTraeEvent(event)
      if (decoded.type === 'delta' && (decoded.text !== ''
        || (decoded.reasoning !== undefined && decoded.reasoning !== '')
        || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) sawOutput = true
      failure ??= traeFailureOf(decoded)
      if (sawOutput || failure !== undefined) break
    }
  }
  while (buffered.length < PEEK_MAX_CHUNKS && bufferedBytes < PEEK_MAX_BYTES) {
    const next = await reader.read()
    if (next.done) {
      ended = true
      // Flush the tail: a stream cut off before its blank line holds exactly
      // the failure this peek exists to catch, and `push` alone never
      // dispatches it.
      inspect(sse.finish())
      break
    }
    buffered.push(next.value)
    bufferedBytes += next.value.byteLength
    inspect(sse.push(decoder.decode(next.value, { stream: true })))
    if (sawOutput || failure !== undefined) break
  }
  // Nothing has been forwarded yet, so a failure found here can still become a
  // real status code. Once output has started, the stream is already committed.
  if (failure !== undefined && !sawOutput) {
    await reader.cancel().catch(() => {})
    const { status, kind } = classifyTraeFailure(failure)
    return Response.json(
      { error: { message: describeTraeFailure(failure), type: 'upstream_error', code: kind === 'hard_credit' ? 402 : status } },
      { status },
    )
  }
  const replayed = replaySource(buffered, reader, ended)
  // The peeked events were already decoded; the bridge must see them once.
  return new Response(bridgeTraeStream(replayed, model, options), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
