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
var qoder_sse_exports = {};
__export(qoder_sse_exports, {
  QoderFrameDecoder: () => QoderFrameDecoder,
  decodeQoderFrame: () => decodeQoderFrame,
  retryAfterSecondsOf: () => retryAfterSecondsOf,
  unwrapFailure: () => unwrapFailure,
  unwrapQoderFrame: () => unwrapQoderFrame
});
module.exports = __toCommonJS(qoder_sse_exports);
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function tryJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function unwrapFailure(frame) {
  let code = "";
  let detail = "";
  let node = frame;
  let descended = false;
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node)) break;
    const levelCode = node["errorCode"] ?? node["code"];
    if (typeof levelCode === "string" && levelCode.length > 0) code = levelCode;
    else if (typeof levelCode === "number" && Number.isFinite(levelCode)) code = String(levelCode);
    const message = node["message"] ?? node["errorMessage"];
    if (typeof message === "string" && message.length > 0) detail = message;
    const nested = isPlainObject(node["details"]) ? node["details"] : isPlainObject(node["error"]) ? node["error"] : void 0;
    const next = nested ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
    if (next === void 0) break;
    node = next;
    descended = true;
  }
  if (descended && isPlainObject(node) && typeof node["message"] !== "string") {
    detail = JSON.stringify(node);
  }
  return { code, detail };
}
function retryAfterSecondsOf(frame) {
  if (!isPlainObject(frame)) return 0;
  const direct = frame["retryAfterSeconds"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
  const { detail } = unwrapFailure(frame);
  if (detail === "") return 0;
  const parsed = tryJsonObject(detail);
  const nested = parsed?.["retryAfterSeconds"];
  return typeof nested === "number" && Number.isFinite(nested) && nested > 0 ? nested : 0;
}
function unwrapQoderFrame(payload) {
  const envelope = tryJsonObject(payload);
  if (envelope === void 0) return void 0;
  const body = envelope["body"];
  if (typeof body === "string") return tryJsonObject(body);
  if (isPlainObject(body)) return body;
  return envelope;
}
function decodeQoderFrame(payload) {
  const chunk = unwrapQoderFrame(payload);
  if (chunk === void 0) return { type: "unknown", reason: "unparseable", data: payload };
  if (chunk["choices"] !== void 0 || chunk["usage"] !== void 0 && chunk["usage"] !== null) {
    return { type: "chunk", chunk };
  }
  const { code, detail } = unwrapFailure(chunk);
  if (code === "" && detail === "") return { type: "unknown", reason: "unnamed", data: chunk };
  return { type: "failure", code, detail, retryAfterSeconds: retryAfterSecondsOf(chunk) };
}
const MAX_LINE_CHARS = 8 * 1024 * 1024;
class QoderFrameDecoder {
  buffer = "";
  done = false;
  /** Payloads seen so far; `[DONE]` ends the stream and yields nothing. */
  push(chunk) {
    if (this.done) return [];
    this.buffer += chunk;
    const payloads = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0) continue;
      if (payload === "[DONE]") {
        this.done = true;
        return payloads;
      }
      payloads.push(payload);
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = "";
      throw new Error("sse line exceeded " + MAX_LINE_CHARS + " characters without a newline");
    }
    return payloads;
  }
  /** Flush a final payload the upstream left without a trailing newline. */
  finish() {
    if (this.done) return [];
    this.done = true;
    const line = this.buffer.trim();
    this.buffer = "";
    if (!line.startsWith("data:")) return [];
    const payload = line.slice(5).trim();
    return payload.length === 0 || payload === "[DONE]" ? [] : [payload];
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QoderFrameDecoder,
  decodeQoderFrame,
  retryAfterSecondsOf,
  unwrapFailure,
  unwrapQoderFrame
});
