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
  traeFailureOf: () => traeFailureOf
});
module.exports = __toCommonJS(trae_shim_exports);
var import_node_crypto = require("node:crypto");
var import_trae_sse = require("./trae-sse");
var import_loopback = require("./loopback");
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
function traeFailureOf(decoded) {
  if (decoded.type !== "unknown") return void 0;
  const payload = decoded.data;
  const code = typeof payload?.["code"] === "number" ? payload["code"] : void 0;
  if (decoded.event !== "error" && !(code !== void 0 && code >= 4e3)) return void 0;
  return {
    ...code === void 0 ? {} : { code },
    message: typeof payload?.["message"] === "string" ? payload["message"] : "",
    ...payload?.["extra"] === void 0 ? {} : { extra: payload["extra"] }
  };
}
function describeTraeFailure(failure) {
  const parts = [];
  if (failure.code !== void 0) parts.push(`code ${failure.code}`);
  if (failure.extra !== void 0) {
    const extra = typeof failure.extra === "string" ? failure.extra : JSON.stringify(failure.extra);
    if (extra !== "") parts.push(extra.slice(0, 200));
  }
  const detail = failure.message.trim();
  return (0, import_loopback.redactSecrets)(detail === "" ? parts.join(" \xB7 ") : `${parts.join(" \xB7 ")} \xB7 upstream: ${detail}`);
}
function classifyTraeFailure(failure) {
  if (failure.code === 1005) return { status: 402, kind: "hard_credit" };
  const code = failure.code;
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
  let sawToolCalls = false;
  let emittedFinishReason = false;
  let upstreamDone = false;
  let usage;
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
    if (decoded.type === "unknown") {
      const failure = traeFailureOf(decoded);
      if (failure !== void 0) throw new Error(describeTraeFailure(failure));
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
      if (decoded.finishReason === void 0) return;
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
    if (decoded.type !== "done" && decoded.type !== "delta") return;
    if (emittedFinishReason) return;
    emittedFinishReason = true;
    controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : decoded.finishReason || "stop"));
  };
  return new ReadableStream({
    async start(controller) {
      try {
        while (!cancelled) {
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) break;
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller);
          if (upstreamDone) break;
        }
        if (cancelled) return;
        for (const event of sse.finish()) consume(event, controller);
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
      const chunk = buffered[index];
      if (chunk !== void 0) {
        index += 1;
        controller.enqueue(chunk);
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
    while (buffered.length < PEEK_MAX_CHUNKS && bufferedBytes < PEEK_MAX_BYTES) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        inspect(sse.finish());
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
    const { status, kind } = classifyTraeFailure(failure);
    return Response.json(
      { error: { message: describeTraeFailure(failure), type: "upstream_error", code: kind === "hard_credit" ? 402 : status } },
      { status }
    );
  }
  const replayed = replaySource(buffered, reader, ended);
  return new Response(bridgeTraeStream(replayed, model, options), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bridgeTraeStream,
  classifyTraeFailure,
  describeTraeFailure,
  normalizeTraeToolCalls,
  openTraeResponse,
  traeFailureOf
});
