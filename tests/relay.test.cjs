/**
 * Regressions for the vendor relay seams.
 *
 * The cases that cost a turn each: a failure the client
 * could not finish on, a status that was thrown away, a credential echoed into a
 * response body, and a gateway left bound after the pass that started it had
 * already answered. Each one is stated as the observable the client sees.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')

/**
 * Copy the plugin manifest into a fixture directory with the runtime provider
 * declaration cleared, the same normalization the packaging step applies: a
 * local run of the plugin writes that declaration back into the repo copy, and
 * a test must not inherit whatever the last run published.
 */
function writeManifestFixture(target) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.contributes) manifest.contributes.providers = []
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}
const encoder = new TextEncoder()

/** A readable whose failure is whatever the fixture says it is. */
function failingSource(failure, opening) {
  const state = { cancelled: false }
  const stream = new ReadableStream({
    start(controller) {
      if (opening !== undefined) controller.enqueue(encoder.encode(opening))
      controller.error(failure)
    },
    cancel() { state.cancelled = true },
  })
  return { stream, state }
}

/**
 * The in-band error frame never carries a credential.
 *
 * A stream that has already sent its 200 cannot change the status, so a failure
 * after the first output is reported as an error frame inside the stream. That
 * frame is the one path a stream error's text takes to the client without
 * passing through `writeOpenAIError`, and an upstream that quotes the request it
 * was sent puts a live token in the text. A caller reading a failed stream is
 * exactly the reader who pastes it into a bug report.
 */
test('an in-band stream error never carries a credential', async () => {
  const { bridgeTraeStream } = require('../lib/trae-shim')
  const { bridgeQoderStream } = require('../lib/qoder-shim')
  const secret = 'abcDEF123+/=ghiJKL456.mnoPQR789'

  for (const [name, bridge, opening] of [
    ['trae', bridgeTraeStream, 'event: output\ndata: {"response":"hello"}\n\n'],
    ['qoder', bridgeQoderStream, 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'],
  ]) {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(opening))
        // Raised after the first output, so the bridge is past the point where
        // a status could still carry the failure.
        controller.error(new Error(`upstream said: X-Ide-Token ${secret}`))
      },
    })
    const failures = []
    const body = await new Response(
      bridge(source, 'fixture-model', { onFailure: (error) => failures.push(error) }),
    ).text()

    assert.equal(body.includes(secret), false, `${name}: a credential leaked into the in-band error frame`)
    // A missing terminator left the caller with a stream only a timeout could
    // end, which is the whole shape of the bug.
    assert.match(body, /"error":\{"message":/, `${name}: the failure must be reported in-band`)
    assert.match(body, /"finish_reason"/, `${name}: a finish chunk is required`)
    assert.ok(body.includes('data: [DONE]'), `${name}: the terminator is required`)
    assert.equal(failures.length, 1, `${name}: the real failure must reach the caller`)
  }
})

/**
 * A bridge that stops early releases the upstream it was reading.
 *
 * A caller that hangs up, and a decoder that gives up on an unterminated line,
 * both leave the bridge with a reader nobody will drain. Holding it keeps the
 * upstream socket open until its own idle timeout - once per turn, on a pool
 * whose whole purpose is the number of concurrent turns.
 */
test('a bridge that stops early releases its upstream reader', async () => {
  const { bridgeTraeStream } = require('../lib/trae-shim')
  const { bridgeQoderStream } = require('../lib/qoder-shim')

  for (const [name, bridge, opening] of [
    ['trae', bridgeTraeStream, 'event: output\ndata: {"response":"hello"}\n\n'],
    ['qoder', bridgeQoderStream, 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'],
  ]) {
    for (const stop of ['hangup', 'oversized line']) {
      let released = false
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(opening))
          if (stop === 'oversized line') {
            // One line with no newline in it: the decoder's own guard throws,
            // which is a bridge failure rather than an upstream one.
            controller.enqueue(encoder.encode('data: ' + 'x'.repeat(65 * 1024 * 1024)))
          }
        },
        pull() { return new Promise(() => {}) },
        cancel() { released = true },
      })
      const reader = bridge(source, 'fixture-model', {}).getReader()
      await reader.read()
      if (stop === 'hangup') await reader.cancel()
      else {
        // Drain until the decoder gives up, so its cleanup path is the one
        // under test rather than the caller's.
        for (let i = 0; i < 8; i++) {
          const next = await reader.read().catch(() => ({ done: true }))
          if (next.done) break
        }
      }
      assert.equal(released, true, `${name}/${stop}: the upstream reader must be released`)
    }
  }
})

/**
 * A bridge that ran to completion still releases its upstream.
 *
 * The release has to sit in a `finally`: a stream that reaches EOF closes its
 * controller instead of erroring, so that exit never runs the catch, and with
 * the cancel in the catch the upstream reader stayed locked for every normal
 * turn - the case the other two tests miss, because they all end in a hang-up
 * or a decode failure. A source that closed itself never runs its own `cancel`,
 * so the lock is the observable here, not the source's callback.
 */
test('a bridge that finishes normally releases its upstream reader', async () => {
  const { bridgeTraeStream } = require('../lib/trae-shim')
  const { bridgeQoderStream } = require('../lib/qoder-shim')

  for (const [name, bridge, wire] of [
    ['trae', bridgeTraeStream, 'event: output\ndata: {"response":"hello"}\n\nevent: done\ndata: {}\n\n'],
    ['qoder', bridgeQoderStream, 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
  ]) {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire))
        controller.close()
      },
    })
    const decoder = new TextDecoder()
    const reader = bridge(source, 'fixture-model', {}).getReader()
    let text = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value)
    }
    assert.match(text, /hello/, `${name}: the reply must reach the client`)
    // The bridge's `finally` runs after it closes its controller, so the
    // release lands a tick after the caller sees EOF.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(source.locked, false, `${name}: a finished turn must still release the upstream reader`)
  }
})

/**
 * A Trae failure frame never carries a credential to the client.
 *
 * `describeTraeFailure` assembles the text that the in-band frame sends
 * verbatim, so it is a second way out of the redaction that the catch-side
 * fix does not cover: Trae's own error frame quotes the request it was sent,
 * and `extra` is an opaque diagnostic object whose shape the vendor may change.
 */
test('a Trae failure frame is redacted before it leaves the gateway', () => {
  const { describeTraeFailure } = require('../lib/trae-shim')
  const secret = 'abcDEF123+/=ghiJKL456.mnoPQR789'
  for (const failure of [
    { code: 4001, message: 'Cloud-IDE-JWT ' + secret },
    { code: 4001, message: 'Login expired', extra: { 'accessToken': secret } },
    { code: 4001, message: '', extra: 'X-Ide-Token: ' + secret },
  ]) {
    const out = describeTraeFailure(failure)
    assert.equal(out.includes(secret), false, 'a credential leaked from: ' + JSON.stringify(failure))
    assert.match(out, /\[redacted\]/, 'the credential must be replaced, not merely dropped')
  }
})

/**
 * A peek that fails releases the upstream reader.
 *
 * `openTraeResponse`/`openQoderResponse` read ahead to learn whether the
 * upstream will fail before it starts producing. When that read itself throws -
 * a reset mid-peek, or the decoder's own over-long-line guard - a reader left
 * holding the connection kept the upstream socket open after the caller had
 * already been answered, once per turn, for a pool whose whole purpose is the
 * number of concurrent turns.
 */
test('a peek that fails releases the upstream reader', async () => {
  const { openTraeResponse } = require('../lib/trae-shim')
  const { openQoderResponse } = require('../lib/qoder-shim')

  for (const [name, open] of [['trae', openTraeResponse], ['qoder', openQoderResponse]]) {
    // A line with no newline in it makes the decoder throw on its own guard.
    // That is the way a peek fails while the stream is still live, and so the
    // one where releasing the reader is the plugin's responsibility: a stream
    // the upstream already errored is destroyed, and cancelling it reaches
    // nothing.
    let closed = false
    const endless = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: ' + 'x'.repeat(65 * 1024 * 1024))) },
      pull() { return new Promise(() => {}) },
      cancel() { closed = true },
    })
    await assert.rejects(
      () => open(new Response(endless, { status: 200 }), 'fixture-model'),
      /without a newline/,
      `${name}: an unterminated line must stop the peek`,
    )
    assert.equal(closed, true, `${name}: a peek the decoder gave up on must release the reader`)
  }
})
/**
 * A non-2xx answer whose body is cut off still carries its real status.
 *
 * Both vendors answer a refusal with a body the connection then drops before
 * handler that let the rejection decide the status reported a transport failure
 * instead of the rate limit the upstream had actually named - so a throttled
 * account was never rotated off, and every later turn met the same wall.
 */
test('a truncated refusal body keeps the status the upstream chose', async () => {
  const { openTraeResponse } = require('../lib/trae-shim')
  const { openQoderResponse } = require('../lib/qoder-shim')

  for (const [name, open, message] of [
    ['trae', openTraeResponse, 'Trae SOLO returned HTTP 429'],
    ['qoder', openQoderResponse, 'Qoder returned HTTP 429'],
  ]) {
    const { stream } = failingSource(new Error('socket reset'), '{"error":{"message":"rate limited"')
    const relayed = await open(new Response(stream, { status: 429 }), 'fixture-model')
    assert.equal(relayed.status, 429, `${name}: the upstream status must survive a truncated body`)
    const body = await relayed.json()
    assert.ok(body.error.message.includes(message), `${name}: the status text must survive too`)
  }
})

/**
 * A login-expired frame buried under a details object still reads as one.
 *
 * Qoder nests the real message below `details`/`error`. Unwrapping walked into
 * that object and replaced the message with a dump of it, so a frame saying
 * `Login expired` described itself as `{"reqId":1}`, the sign-in-expired branch
 * stopped matching, and the turn answered 502 instead of 401 - the client was
 * never told to re-authenticate, and the user re-ran the same request against
 * the same dead sign-in.
 */
test('a Qoder failure nested under details keeps the message a user can act on', () => {
  const { unwrapFailure } = require('../lib/qoder-sse')
  const nested = unwrapFailure({ errorCode: '10605', message: 'Login expired', details: { reqId: 1 } })
  assert.equal(nested.code, '10605')
  assert.equal(nested.detail, 'Login expired')
  // With no message anywhere on the way down, the object is still a better
  // description than an empty string.
  assert.equal(unwrapFailure({ code: '1', details: { reqId: 7 } }).detail, '{"reqId":7}')
})

/**
 * A daily-limit frame's retry hint is read from wherever the frame carries it.
 *
 * The quota branch reads the hint, and a frame that reports the wait only
 * inside its message - how Qoder writes a daily-limit refusal - came back with
 * none, so the pool retried at once and collected the same refusal from every
 * account in turn.
 */
test('a Qoder retry hint is read from wherever the frame carries it', () => {
  const { retryAfterSecondsOf } = require('../lib/qoder-sse')
  assert.equal(retryAfterSecondsOf({ retryAfterSeconds: 120 }), 120)
  assert.equal(retryAfterSecondsOf({ message: JSON.stringify({ retryAfterSeconds: 45 }) }), 45)
  // A carried zero is the decoder's "no hint" placeholder, not a zero-second
  // wait, so the nested answer must still be consulted.
  assert.equal(retryAfterSecondsOf({
    retryAfterSeconds: 0, message: JSON.stringify({ retryAfterSeconds: 45 }),
  }), 45)
  assert.equal(retryAfterSecondsOf({ message: 'no hint here' }), 0)
})


/**
 * A pass that runs out of budget mid-start releases what it already bound.
 *
 * `createRuntime` reserves a port and binds a shim before it returns, so a
 * refresh pass that timed out while awaiting one left the late runtime holding
 * both with nobody to close them: the port stayed taken by this plugin for the
 * rest of the process, and the endpoint the manifest names went dead. The
 * observable is that the declared port is bindable again after a load whose
 * first panel answer went out before its gateways had finished coming up.
 */
test('a timed-out gateway start is released instead of abandoned', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-leak-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({
    auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'leak-user' },
  }))
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  // Slow enough that the panel budget expires while the gateway is still
  // binding, which is the only way the abandoned path is reachable.
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => {
    await new Promise((resolve) => setTimeout(resolve, 120))
    return []
  })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const context = vm.createContext({
    require: createRequire(path.join(root, 'main.js')),
    module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    pi: {
      plugin: { getSettings: async () => ({ ...settings }), getDataPath: async () => path.join(temporary, 'data') },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: () => {} },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    const state = await plugin.onPanelInvoke('xd.state')
    const endpoint = state.shims.cn.baseUrl.replace(/\/v1$/, '')
    const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))
    // Late enough that a runtime the first pass abandoned has finished binding,
    // and so has whatever handler was going to release it.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await plugin.onUnload()
    // The whole point: unload plus the abandoned pass must both have released
    // the port, so the next boot can take the address the manifest names.
    const server = require('node:http').createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    await new Promise((resolve) => server.close(resolve))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
/**
 * A vendor that finishes the text and keeps the socket open still ends the turn.
 *
 * Qoder sends its finish chunk and then nothing: no `[DONE]`, no close. The
 * relay used to wait for the upstream read to end, which the vendor never does,
 * so the client held a reply that was complete but was never marked finished.
 * The bridge must close itself inside the tail grace.
 */
test('the qoder relay ends a turn whose upstream never closes', async () => {
  const { bridgeQoderStream } = require('../lib/qoder-shim')
  const encoder = new TextEncoder()
  let upstreamCancelled = false
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ))
      // Intentionally never closed: this is the vendor's behaviour.
    },
    cancel() { upstreamCancelled = true },
  })
  const started = Date.now()
  const body = await new Response(bridgeQoderStream(source, 'fixture-model')).text()
  const elapsed = Date.now() - started
  assert.match(body, /"finish_reason":"stop"/)
  assert.match(body, /data: \[DONE\]/)
  assert.ok(elapsed < 5000, `the turn must close on its own, took ${elapsed}ms`)
  assert.ok(upstreamCancelled, 'the upstream socket must be released')
})
/**
 * A turn cut off by the output budget is still reported as truncated.
 *
 * Both bridges answered `tool_calls` whenever the turn had emitted one, so an
 * upstream `length` disappeared: the client read a truncated reply as a finished
 * one and acted on tool arguments that were themselves cut off. Only the verdict
 * that carries nothing of its own may be replaced.
 */
test('a truncated tool-call turn keeps the upstream finish_reason', async () => {
  const { bridgeQoderStream } = require('../lib/qoder-shim')
  const { bridgeTraeStream } = require('../lib/trae-shim')
  const encoder = new TextEncoder()
  const toolCall = { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }

  const qoderBody = await new Response(bridgeQoderStream(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
      ))
      controller.close()
    },
  }), 'fixture-model')).text()
  assert.match(qoderBody, /"finish_reason":"length"/, 'qoder must not turn a truncated turn into a tool-call turn')
  assert.match(qoderBody, /"tool_calls"/, 'the tool call itself still reaches the client')

  const traeBody = await new Response(bridgeTraeStream(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ response: '', tool_calls: [toolCall], finish_reason: 'length' })}\n\n`,
      ))
      controller.close()
    },
  }), 'fixture-model')).text()
  assert.match(traeBody, /"finish_reason":"length"/, 'trae must not turn a truncated turn into a tool-call turn')
})
/**
 * The rule itself: only `stop` and silence lose to the tool-call verdict.
 */
test('only a stop verdict is replaced by tool_calls', () => {
  const { openAIFinishReason } = require('../lib/loopback')
  assert.equal(openAIFinishReason('stop', true), 'tool_calls')
  assert.equal(openAIFinishReason(undefined, true), 'tool_calls')
  assert.equal(openAIFinishReason('', true), 'tool_calls')
  assert.equal(openAIFinishReason('length', true), 'length')
  assert.equal(openAIFinishReason('content_filter', true), 'content_filter')
  assert.equal(openAIFinishReason('stop', false), 'stop')
  assert.equal(openAIFinishReason(undefined, false), 'stop')
})
