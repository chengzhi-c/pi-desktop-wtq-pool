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
var qoder_shim_exports = {};
__export(qoder_shim_exports, {
  QoderDailyLimitRejection: () => QoderDailyLimitRejection,
  QoderQueueRejection: () => QoderQueueRejection,
  QoderSignInExpiredError: () => QoderSignInExpiredError,
  bridgeQoderStream: () => bridgeQoderStream,
  classifyQoderFailure: () => classifyQoderFailure,
  openQoderResponse: () => openQoderResponse,
  qoderRequestBody: () => qoderRequestBody,
  qoderWireEffort: () => qoderWireEffort
});
module.exports = __toCommonJS(qoder_shim_exports);
var import_node_crypto = require("node:crypto");
var import_qoder_client = require("./qoder-client");
var import_qoder_sse = require("./qoder-sse");
var import_loopback = require("./loopback");
class QoderQueueRejection extends Error {
  constructor(retryAfterSeconds, message) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "QoderQueueRejection";
  }
}
class QoderDailyLimitRejection extends Error {
  constructor(retryAfterSeconds, message) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "QoderDailyLimitRejection";
  }
}
class QoderSignInExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "QoderSignInExpiredError";
  }
}
const QUEUE_MARKERS = ['"queueType"', '"retryAfterSeconds"', '"isQueued"', '"serviceAvailable"'];
function queueMarkerCount(text) {
  let count = 0;
  for (const marker of QUEUE_MARKERS) {
    if (text.includes(marker)) count += 1;
  }
  return count;
}
function queueSeconds(frame) {
  if (Number.isFinite(frame.retryAfterSeconds) && frame.retryAfterSeconds > 0) return frame.retryAfterSeconds;
  let text = frame.detail;
  for (let depth = 0; depth < 4; depth++) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 0;
    }
    if (typeof parsed === "string") {
      text = parsed;
      continue;
    }
    if (parsed === null || typeof parsed !== "object") return 0;
    const record = parsed;
    const seconds = Number(record["retryAfterSeconds"]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
    if (typeof record["message"] !== "string" || record["message"] === text) return 0;
    text = record["message"];
  }
  return 0;
}
function classifyQoderFailure(failure) {
  const code = failure.code.trim();
  const text = `${code} ${failure.message}`;
  if (code === "110" || /daily.*(limit|quota)|quota.*daily|allowance.*spent/i.test(text)) {
    const retryAfter = queueSeconds({
      type: "failure",
      code,
      detail: failure.message,
      retryAfterSeconds: failure.retryAfterSeconds ?? 0
    });
    return {
      status: 429,
      kind: "hard_credit",
      error: new QoderDailyLimitRejection(Number.isFinite(retryAfter) ? retryAfter : 0, failure.message)
    };
  }
  if (code === "10605") {
    return {
      status: 429,
      kind: "soft_rate",
      error: new QoderQueueRejection(queueSeconds({ type: "failure", code, detail: failure.message, retryAfterSeconds: failure.retryAfterSeconds ?? 0 }), failure.message)
    };
  }
  if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || code === "105") {
    return { status: 401, kind: "authentication", error: new QoderSignInExpiredError(failure.message) };
  }
  if (code === "1210") {
    return { status: 400, kind: "client", error: new Error(failure.message) };
  }
  if (queueMarkerCount(failure.message) >= 2) {
    return {
      status: 429,
      kind: "soft_rate",
      error: new QoderQueueRejection(queueSeconds({ type: "failure", code, detail: failure.message, retryAfterSeconds: failure.retryAfterSeconds ?? 0 }), failure.message)
    };
  }
  if (code === "429") return { status: 429, kind: "soft_rate", error: new QoderQueueRejection(0, failure.message) };
  if (code === "402") return { status: 402, kind: "hard_credit", error: new Error(failure.message) };
  return { status: 502, kind: "client", error: new Error(failure.message) };
}
function qoderRequestBody(openAiBody, model, entry, options = {}) {
  const requested = readReasoningEffort(openAiBody);
  const off = requested === "off" || requested === "none";
  const wire = requested === void 0 || off ? void 0 : qoderWireEffort(requested, entry);
  return {
    body: openAiBody,
    model,
    options: {
      ...options,
      ...requested === void 0 ? {} : {
        enableThinking: !off,
        ...wire === void 0 ? {} : { reasoningEffort: wire }
      }
    }
  };
}
function qoderWireEffort(requested, entry) {
  const levels = entry?.effortLevels ?? [];
  if (levels.length === 0) return void 0;
  if (levels.includes(requested)) return requested;
  const rank = (level) => import_qoder_client.QODER_EFFORT_ORDER.indexOf(level);
  const want = rank(requested);
  if (want < 0) return entry?.defaultEffort ?? levels[0];
  const fallback = entry?.defaultEffort === void 0 ? want : rank(entry.defaultEffort);
  const distance = (level) => Math.abs(rank(level) - fallback);
  return [...levels].sort((a, b) => {
    const near = Math.abs(rank(a) - want) - Math.abs(rank(b) - want);
    return near !== 0 ? near : distance(a) - distance(b);
  })[0];
}
function readReasoningEffort(openAiBody) {
  let parsed;
  try {
    parsed = JSON.parse(openAiBody);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const effort = parsed["reasoning_effort"];
  return typeof effort === "string" && effort.trim() !== "" ? effort.trim() : void 0;
}
function bridgeQoderStream(source, model, options = {}) {
  const id = options.id ?? `chatcmpl-${(0, import_node_crypto.randomUUID)().replaceAll("-", "").slice(0, 24)}`;
  const created = options.created ?? Math.floor(Date.now() / 1e3);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const frames = new import_qoder_sse.QoderFrameDecoder();
  let sawToolCalls = false;
  let emittedFinishReason = false;
  let usage;
  const reader = source.getReader();
  let cancelled = false;
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
  const consume = (payload, controller) => {
    const decoded = (0, import_qoder_sse.decodeQoderFrame)(payload);
    if (decoded.type === "unknown") return;
    if (decoded.type === "failure") {
      const { error } = classifyQoderFailure({ code: decoded.code, message: decoded.detail, retryAfterSeconds: decoded.retryAfterSeconds });
      throw error;
    }
    const inner = decoded.chunk;
    const choices = inner["choices"];
    if (Array.isArray(choices)) {
      for (const raw of choices) {
        if (raw === null || typeof raw !== "object") continue;
        const choice = raw;
        const delta = choice["delta"];
        if (delta !== null && typeof delta === "object") {
          const out = { ...delta };
          const toolCalls = delta["tool_calls"];
          if (Array.isArray(toolCalls) && toolCalls.length > 0) sawToolCalls = true;
          if (Object.keys(out).length > 0) {
            roleChunk(controller);
            controller.enqueue(chunk(out));
          }
        }
        const finish = choice["finish_reason"];
        if (typeof finish === "string" && finish !== "" && finish !== "null") {
          if (!emittedFinishReason) {
            emittedFinishReason = true;
            controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : finish));
          }
        }
      }
    }
    if (inner["usage"] !== void 0 && inner["usage"] !== null && typeof inner["usage"] === "object") {
      usage = inner["usage"];
      controller.enqueue(chunk(null));
    }
  };
  return new ReadableStream({
    async start(controller) {
      try {
        while (!cancelled) {
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) break;
          for (const payload of frames.push(decoder.decode(next.value, { stream: true }))) consume(payload, controller);
          if (frames.ended) break;
        }
        if (cancelled) return;
        for (const payload of frames.finish()) consume(payload, controller);
        if (!emittedFinishReason) {
          emittedFinishReason = true;
          controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        if (cancelled) controller.error(error);
        else {
          if (!(error instanceof Error && error.name === "AbortError")) options.onFailure?.(error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            // Redacted here because this frame is the one place a stream error's
            // text reaches the client without passing through `writeOpenAIError`.
            error: { message: (0, import_loopback.redactSecrets)(error instanceof Error ? error.message : String(error)), type: "upstream_error" }
          })}

`));
          if (!emittedFinishReason) {
            emittedFinishReason = true;
            controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      } finally {
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    }
  });
}
const PEEK_MAX_CHUNKS = 64;
const PEEK_MAX_BYTES = 262144;
function replaySource(buffered, reader, ended) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      const bytes = buffered[index];
      if (bytes !== void 0) {
        index += 1;
        controller.enqueue(bytes);
        return;
      }
      if (ended) {
        controller.close();
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {
      });
    }
  });
}
async function openQoderResponse(response, model, options = {}) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 1024);
    return Response.json(
      {
        error: {
          message: detail === "" ? `Qoder returned HTTP ${response.status}` : detail,
          type: "upstream_error",
          code: response.status
        }
      },
      { status: response.status }
    );
  }
  const source = response.body;
  if (source === null) {
    return Response.json({ error: { message: `Qoder response ${response.status} carried no body`, type: "upstream_error", code: 502 } }, { status: 502 });
  }
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const frames = new import_qoder_sse.QoderFrameDecoder();
  const buffered = [];
  let bufferedBytes = 0;
  let sawOutput = false;
  let failure;
  let ended = false;
  const inspect = (payloads) => {
    for (const payload of payloads) {
      const decoded = (0, import_qoder_sse.decodeQoderFrame)(payload);
      if (decoded.type === "chunk") {
        const choices = decoded.chunk["choices"];
        if (Array.isArray(choices) && choices.length > 0) sawOutput = true;
        else if (decoded.chunk["usage"] !== void 0) sawOutput = true;
      } else if (decoded.type === "failure") {
        failure ??= { code: decoded.code, message: decoded.detail, retryAfterSeconds: decoded.retryAfterSeconds };
      }
      if (sawOutput || failure !== void 0) break;
    }
  };
  try {
    while (buffered.length < PEEK_MAX_CHUNKS && bufferedBytes < PEEK_MAX_BYTES) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        inspect(frames.finish());
        break;
      }
      buffered.push(next.value);
      bufferedBytes += next.value.byteLength;
      inspect(frames.push(decoder.decode(next.value, { stream: true })));
      if (sawOutput || failure !== void 0 || frames.ended) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    throw error;
  }
  if (failure !== void 0 && !sawOutput) {
    await reader.cancel().catch(() => {
    });
    const { status, error } = classifyQoderFailure(failure);
    const retryAfter = error instanceof QoderQueueRejection || error instanceof QoderDailyLimitRejection ? error.retryAfterSeconds : void 0;
    return Response.json(
      {
        error: {
          message: error.message === "" ? `Qoder refused the request (${failure.code})` : error.message.slice(0, 1024),
          type: "upstream_error",
          code: status,
          ...retryAfter === void 0 || !(retryAfter > 0) ? {} : { retryAfterSeconds: retryAfter }
        }
      },
      {
        status,
        ...retryAfter === void 0 || !(retryAfter > 0) ? {} : { headers: { "Retry-After": String(Math.ceil(retryAfter)) } }
      }
    );
  }
  const replayed = replaySource(buffered, reader, ended);
  return new Response(bridgeQoderStream(replayed, model, options), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QoderDailyLimitRejection,
  QoderQueueRejection,
  QoderSignInExpiredError,
  bridgeQoderStream,
  classifyQoderFailure,
  openQoderResponse,
  qoderRequestBody,
  qoderWireEffort
});
