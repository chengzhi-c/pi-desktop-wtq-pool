var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var trae_shim_exports = {};
__export(trae_shim_exports, {
  bridgeTraeStream: () => bridgeTraeStream,
  classifyTraeFailure: () => classifyTraeFailure,
  describeTraeFailure: () => describeTraeFailure,
  normalizeTraeToolCalls: () => normalizeTraeToolCalls,
  openTraeResponse: () => openTraeResponse,
  traeFailureOf: () => traeFailureOf,
  traeRetryAfterSeconds: () => traeRetryAfterSeconds
});
module.exports = __toCommonJS(trae_shim_exports);
var import_node_crypto = require("node:crypto");
var import_trae_sse = require("./trae-sse");
var import_loopback = require("./loopback");
const TRAE_SIGN_IN_PATTERN = /login expired|not logged in|unauthori[sz]ed|invalid token|token.*(expire|invalid)|\b9095\b/i;
function normalizeTraeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  const calls = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw;
    const rawFunction = typeof record["function_call"] === "object" && record["function_call"] !== null ? record["function_call"] : typeof record["function"] === "object" && record["function"] !== null ? record["function"] : {};
    const fn = {
      ...typeof rawFunction["name"] === "string" ? { name: rawFunction["name"] } : {},
      ...typeof rawFunction["arguments"] === "string" ? { arguments: rawFunction["arguments"] } : {}
    };
    calls.push({
      index: typeof record["index"] === "number" ? record["index"] : calls.length,
      ...typeof record["id"] === "string" ? { id: record["id"] } : {},
      ...record["type"] === "function" ? { type: "function" } : {},
      ...Object.keys(fn).length === 0 ? {} : { function: fn }
    });
  }
  return calls;
}
function numericCodeOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return void 0;
}
function embeddedJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return void 0;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return void 0;
}
function traeFailureOf(decoded) {
  if (decoded.type === "usage" || decoded.type === "queue" || decoded.type === "progress") return void 0;
  if (decoded.type === "delta" && (decoded.text !== "" || decoded.reasoning !== void 0 && decoded.reasoning !== "" || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) return void 0;
  const payload = decoded.type === "unknown" ? decoded.data : decoded.raw;
  if (payload === void 0) return void 0;
  const eventName = decoded.event;
  let code = numericCodeOf(payload["code"]);
  let message = typeof payload["message"] === "string" ? payload["message"] : "";
  let extra = payload["extra"];
  let named = false;
  const flat = typeof payload["error"] === "string" ? payload["error"] : typeof payload["details"] === "string" ? payload["details"] : void 0;
  if (message === "" && flat !== void 0 && flat.length > 0) {
    message = flat;
    named = true;
  }
  if (code === void 0) {
    for (const container of [payload["error"], payload["details"]]) {
      if (typeof container !== "object" || container === null || Array.isArray(container)) continue;
      const record = container;
      const found = numericCodeOf(record["code"] ?? record["errorCode"]);
      if (found === void 0 && (message !== "" || typeof record["message"] !== "string")) continue;
      if (found !== void 0) code = found;
      if (message === "" && typeof record["message"] === "string") {
        message = record["message"];
        named = true;
      }
      if (extra === void 0) extra = record["extra"];
      if (found !== void 0) break;
    }
  }
  if (code === void 0 && message !== "") {
    const embedded = embeddedJson(message);
    if (embedded !== void 0) {
      code = numericCodeOf(embedded["code"] ?? embedded["errorCode"]);
      if (code === void 0) {
        const nested = typeof embedded["error"] === "string" ? embedded["error"] : typeof embedded["details"] === "string" ? embedded["details"] : void 0;
        if (nested !== void 0 && nested.length > 0) {
          message = nested;
          named = true;
        }
      }
      if (code !== void 0 && typeof embedded["message"] === "string") message = embedded["message"];
    }
  }
  if (code !== void 0 && code < 400) code = void 0;
  if (code !== void 0 && code < 1005 && message.trim() === "") code = void 0;
  if (eventName !== "error" && code === void 0 && !named) return void 0;
  return {
    ...code === void 0 ? {} : { code },
    message,
    ...extra === void 0 ? {} : { extra }
  };
}
function traeRetryAfterSeconds(failure) {
  const embedded = embeddedJson(failure.message);
  const direct = Number(embedded?.["retryAfterSeconds"]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const extra = typeof failure.extra === "object" && failure.extra !== null ? failure.extra : void 0;
  const nested = Number(extra?.["retryAfterSeconds"]);
  return Number.isFinite(nested) && nested > 0 ? nested : void 0;
}
function describeTraeFailure(failure) {
  const parts = [];
  if (failure.code !== void 0) parts.push(`code ${failure.code}`);
  if (failure.extra !== void 0) {
    const extra = typeof failure.extra === "string" ? failure.extra : JSON.stringify(failure.extra);
    if (extra !== "") parts.push(extra.slice(0, 200));
  }
  const detail = failure.message.trim();
  const head = parts.join(" \xB7 ");
  const text = detail === "" ? head : head === "" ? `upstream: ${detail}` : `${head} \xB7 upstream: ${detail}`;
  return (0, import_loopback.redactSecrets)(text === "" ? "Trae SOLO refused the request" : text);
}
function classifyTraeFailure(failure) {
  if (failure.code === 1005) return { status: 402, kind: "hard_credit" };
  const code = failure.code;
  const retryAfterSeconds = traeRetryAfterSeconds(failure);
  if (retryAfterSeconds !== void 0) return { status: 429, kind: "soft_rate", retryAfterSeconds };
  if (TRAE_SIGN_IN_PATTERN.test(`${code ?? ""} ${failure.message}`)) {
    return { status: 401, kind: "authentication" };
  }
  if (code === void 0) return { status: 502, kind: "server" };
  if (code >= 5e3) return { status: 502, kind: "server" };
  if (code >= 4290 && code < 4300) return { status: 429, kind: "client" };
  return { status: 400, kind: "client" };
}
function bridgeTraeStream(source, model, options = {}) {
  const id = options.id ?? `chatcmpl-${(0, import_node_crypto.randomUUID)().replaceAll("-", "").slice(0, 24)}`;
  const created = options.created ?? Math.floor(Date.now() / 1e3);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sse = new import_trae_sse.SseDecoder();
  const reader = source.getReader();
  let cancelled = false;
  let wakeRoom;
  const waitForRoom = () => new Promise((resolve) => {
    let settled = false;
    const wake = () => {
      if (settled) return;
      settled = true;
      wakeRoom = void 0;
      resolve();
    };
    wakeRoom = wake;
    setTimeout(wake, 50);
  });
  let sawToolCalls = false;
  let emittedFinishReason = false;
  let upstreamDone = false;
  let usage;
  let lastKeepaliveAt = 0;
  const keepalive = (controller) => {
    const now = Date.now();
    if (now - lastKeepaliveAt < 1e4) return;
    lastKeepaliveAt = now;
    controller.enqueue(encoder.encode(": keepalive\n\n"));
  };
  const chunk = (delta, finishReason = null) => encoder.encode(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finishReason }],
    ...usage === void 0 ? {} : { usage }
  })}

`);
  let started = false;
  const roleChunk = (controller) => {
    if (started) return;
    started = true;
    controller.enqueue(chunk({ role: "assistant", content: "" }));
  };
  const consume = (event, controller) => {
    if (cancelled) return;
    const decoded = (0, import_trae_sse.decodeTraeEvent)(event);
    if (decoded.type === "done" || event.event === "done") upstreamDone = true;
    const failure = traeFailureOf(decoded);
    if (failure !== void 0) throw new Error(describeTraeFailure(failure));
    if (decoded.type === "unknown") {
      keepalive(controller);
      return;
    }
    if (decoded.type === "delta") {
      const delta = {};
      if (decoded.text !== "") delta["content"] = decoded.text;
      if (decoded.reasoning !== void 0 && decoded.reasoning !== "") delta["reasoning_content"] = decoded.reasoning;
      const toolCalls = normalizeTraeToolCalls(decoded.toolCalls);
      if (toolCalls.length > 0) {
        sawToolCalls = true;
        delta["tool_calls"] = toolCalls;
      }
      if (Object.keys(delta).length > 0) {
        roleChunk(controller);
        controller.enqueue(chunk(delta));
      }
      if (decoded.finishReason === void 0) {
        keepalive(controller);
        return;
      }
    }
    if (decoded.type === "usage") {
      const details = {
        ...decoded.cacheReadTokens === void 0 ? {} : { cached_tokens: decoded.cacheReadTokens },
        ...decoded.cacheWriteTokens === void 0 ? {} : { cache_write_tokens: decoded.cacheWriteTokens }
      };
      usage = {
        ...decoded.inputTokens === void 0 ? {} : { prompt_tokens: decoded.inputTokens },
        ...decoded.outputTokens === void 0 ? {} : { completion_tokens: decoded.outputTokens },
        ...decoded.totalTokens === void 0 ? {} : { total_tokens: decoded.totalTokens },
        // Omit the details object entirely when Trae sent neither field, so a
        // provider that never reports cache keeps its previous wire shape.
        ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details }
      };
      if (emittedFinishReason) controller.enqueue(chunk(null));
      return;
    }
    if (decoded.type !== "done" && decoded.type !== "delta") {
      keepalive(controller);
      return;
    }
    if (emittedFinishReason) return;
    emittedFinishReason = true;
    controller.enqueue(chunk({}, (0, import_loopback.openAIFinishReason)(decoded.finishReason, sawToolCalls)));
  };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await reader.cancel().catch(() => {
    });
    try {
      reader.releaseLock();
    } catch {
    }
  };
  return new ReadableStream({
    /**
     * Push from one loop rather than pull one chunk at a time.
     *
     * The pull-driven version asked the host to call back for every upstream
     * chunk, and in the plugin process those callbacks stopped arriving after a
     * few kilobytes, leaving a turn that had started and then went silent. A
     * single loop owns the read side; `desiredSize` is the only backpressure, so
     * at most a chunk or two is held ahead of the client.
     */
    start(controller) {
      void (async () => {
        try {
          for (; ; ) {
            const next = await reader.read();
            if (cancelled) return;
            if (!next.done) {
              for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller);
              if (!upstreamDone) {
                while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
                  await waitForRoom();
                }
                continue;
              }
            }
            const rest = decoder.decode();
            const events = rest === "" ? sse.finish() : [...sse.push(rest), ...sse.finish()];
            for (const event of events) consume(event, controller);
            if (!emittedFinishReason) {
              emittedFinishReason = true;
              controller.enqueue(chunk({}, (0, import_loopback.openAIFinishReason)(void 0, sawToolCalls)));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
        } catch (error) {
          if (cancelled) controller.error(error);
          else {
            if (!(error instanceof Error && error.name === "AbortError")) {
              try {
                options.onFailure?.(error);
              } catch {
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              error: { message: (0, import_loopback.redactSecrets)(error instanceof Error ? error.message : String(error)), type: "upstream_error" }
            })}

`));
            if (!emittedFinishReason) {
              emittedFinishReason = true;
              controller.enqueue(chunk({}, (0, import_loopback.openAIFinishReason)(void 0, sawToolCalls)));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        } finally {
          await release();
        }
      })();
    },
    pull() {
      wakeRoom?.();
    },
    cancel(reason) {
      cancelled = true;
      wakeRoom?.();
      return reader.cancel(reason);
    }
  });
}
async function openTraeResponse(response, model, options = {}) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 1024);
    return Response.json(
      {
        error: {
          message: detail === "" ? `Trae SOLO returned HTTP ${response.status}` : detail,
          type: "upstream_error",
          code: response.status
        }
      },
      { status: response.status }
    );
  }
  const source = response.body;
  if (source === null) {
    return Response.json({ error: { message: `Trae SOLO response ${response.status} carried no body`, type: "upstream_error", code: 502 } }, { status: 502 });
  }
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const sse = new import_trae_sse.SseDecoder();
  const buffered = [];
  let bufferedBytes = 0;
  let sawOutput = false;
  let failure;
  let ended = false;
  let terminal = false;
  const inspect = (events) => {
    for (const event of events) {
      const decoded = (0, import_trae_sse.decodeTraeEvent)(event);
      terminal ||= decoded.type === "done" || event.event === "done";
      if (decoded.type === "delta" && (decoded.text !== "" || decoded.reasoning !== void 0 && decoded.reasoning !== "" || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) sawOutput = true;
      failure ??= traeFailureOf(decoded);
      if (sawOutput || failure !== void 0 || terminal) break;
    }
  };
  try {
    while (buffered.length < import_loopback.PEEK_MAX_CHUNKS && bufferedBytes < import_loopback.PEEK_MAX_BYTES) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        const rest = decoder.decode();
        inspect(rest === "" ? sse.finish() : [...sse.push(rest), ...sse.finish()]);
        break;
      }
      buffered.push(next.value);
      bufferedBytes += next.value.byteLength;
      inspect(sse.push(decoder.decode(next.value, { stream: true })));
      if (sawOutput || failure !== void 0 || terminal) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    throw error;
  }
  if (failure !== void 0 && !sawOutput) {
    await reader.cancel().catch(() => {
    });
    const { status, kind, retryAfterSeconds } = classifyTraeFailure(failure);
    const wait = (0, import_loopback.retryAfterHeader)(retryAfterSeconds);
    return Response.json(
      { error: { message: describeTraeFailure(failure), type: "upstream_error", code: kind === "hard_credit" ? 402 : status } },
      { status, ...wait === void 0 ? {} : { headers: { "Retry-After": wait } } }
    );
  }
  const replayed = (0, import_loopback.replaySource)(buffered, reader, ended);
  const relay = bridgeTraeStream(replayed, model, options);
  return (0, import_loopback.withRelayStream)(new Response(relay, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  }), relay);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bridgeTraeStream,
  classifyTraeFailure,
  describeTraeFailure,
  normalizeTraeToolCalls,
  openTraeResponse,
  traeFailureOf,
  traeRetryAfterSeconds
});
