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
var trae_sse_exports = {};
__export(trae_sse_exports, {
  SseDecoder: () => SseDecoder,
  decodeTraeEvent: () => decodeTraeEvent
});
module.exports = __toCommonJS(trae_sse_exports);
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const MAX_DATA_CHARS = 4 * 1024 * 1024;
class SseDecoder {
  buffer = "";
  event;
  id;
  retry;
  data = [];
  dataChars = 0;
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    while (true) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null || match.index === void 0) break;
      if (match[0] === "\r" && match.index + 1 === this.buffer.length) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const emitted = this.consumeLine(line);
      if (emitted !== void 0) events.push(emitted);
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = "";
      throw new Error("sse line exceeded " + MAX_LINE_CHARS + " characters without a newline");
    }
    if (this.dataChars > MAX_DATA_CHARS) {
      this.data = [];
      this.dataChars = 0;
      throw new Error("sse event exceeded " + MAX_DATA_CHARS + " characters of data without a separator");
    }
    return events;
  }
  /** Flush a trailing event the upstream never terminated with a blank line. */
  finish() {
    const events = [];
    if (this.buffer !== "") {
      const tail = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      const emitted = this.consumeLine(tail);
      this.buffer = "";
      if (emitted !== void 0) events.push(emitted);
    }
    const final = this.dispatch();
    if (final !== void 0) events.push(final);
    return events;
  }
  consumeLine(line) {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return void 0;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") {
      this.data.push(value);
      this.dataChars += value.length + 1;
    } else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
    return void 0;
  }
  dispatch() {
    if (this.data.length === 0) {
      this.event = void 0;
      this.retry = void 0;
      return void 0;
    }
    const result = {
      ...this.event === void 0 || this.event === "" ? {} : { event: this.event },
      data: this.data.join("\n"),
      ...this.id === void 0 ? {} : { id: this.id },
      ...this.retry === void 0 ? {} : { retry: this.retry }
    };
    this.event = void 0;
    this.retry = void 0;
    this.data = [];
    this.dataChars = 0;
    return result;
  }
}
function decodeTraeEvent(event) {
  if (event.data === "[DONE]") return { type: "done", finishReason: "stop" };
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return { type: "unknown", ...event.event === void 0 ? {} : { event: event.event }, data: event.data };
  }
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  if (event.event === "request_wait_in_queue") {
    return { type: "queue", ...typeof record["position"] === "number" ? { position: record["position"] } : {} };
  }
  if (event.event === "progress_notice") return { type: "progress", notice: payload };
  if (event.event === "token_usage") {
    return {
      type: "usage",
      ...typeof record["prompt_tokens"] === "number" ? { inputTokens: record["prompt_tokens"] } : {},
      ...typeof record["completion_tokens"] === "number" ? { outputTokens: record["completion_tokens"] } : {},
      ...typeof record["total_tokens"] === "number" ? { totalTokens: record["total_tokens"] } : {},
      ...typeof record["reasoning_tokens"] === "number" ? { reasoningTokens: record["reasoning_tokens"] } : {},
      ...typeof record["cache_read_input_tokens"] === "number" ? { cacheReadTokens: record["cache_read_input_tokens"] } : {},
      ...typeof record["cache_creation_input_tokens"] === "number" ? { cacheWriteTokens: record["cache_creation_input_tokens"] } : {}
    };
  }
  const delta = {
    type: "delta",
    text: typeof record["response"] === "string" ? record["response"] : "",
    ...typeof record["reasoning_content"] === "string" ? { reasoning: record["reasoning_content"] } : {},
    ...record["tool_calls"] === void 0 || record["tool_calls"] === null ? {} : { toolCalls: record["tool_calls"] },
    ...typeof record["finish_reason"] === "string" ? { finishReason: record["finish_reason"] } : event.event === "done" ? { finishReason: "stop" } : {},
    // The frame as it arrived, kept so a refusal riding on an `output` or
    // `done` event name can still be recognised: the shape decoder files those
    // as an empty delta or a terminator, and the code and message it carried
    // would otherwise be invisible.
    raw: record,
    ...event.event === void 0 ? {} : { event: event.event }
  };
  if (delta.text !== "" || delta.reasoning !== void 0 && delta.reasoning !== "" || Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0) return delta;
  if (event.event === "done" || delta.finishReason !== void 0) {
    return { type: "done", finishReason: delta.finishReason ?? "stop", raw: record, ...event.event === void 0 ? {} : { event: event.event } };
  }
  if (event.event === "output" || record["response"] !== void 0 || record["reasoning_content"] !== void 0 || delta.toolCalls !== void 0) {
    return delta;
  }
  return { type: "unknown", ...event.event === void 0 ? {} : { event: event.event }, data: payload };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SseDecoder,
  decodeTraeEvent
});
