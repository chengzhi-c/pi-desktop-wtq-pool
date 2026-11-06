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
  isAcknowledgementCode: () => isAcknowledgementCode,
  retryAfterSecondsOf: () => retryAfterSecondsOf,
  unwrapFailure: () => unwrapFailure
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
function isAcknowledgementCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  if (typeof value === "string" && value.length === 0) return false;
  const code = Number(value);
  return Number.isFinite(code) && (code === 0 || code >= 200 && code < 300);
}
function unwrapFailure(frame) {
  let code = "";
  let detail = "";
  const signals = [];
  let node = frame;
  let descended = false;
  let codeFromPlainKey = false;
  let codeFromErrorSpelling = false;
  let arrivedViaContainer = false;
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node)) break;
    const errorSpelling = node["errorCode"] ?? node["errcode"];
    const levelCode = errorSpelling ?? node["code"];
    const acknowledgement = arrivedViaContainer && codeFromPlainKey && isAcknowledgementCode(levelCode);
    if (errorSpelling !== void 0 || !codeFromErrorSpelling && !acknowledgement) {
      if (typeof levelCode === "string" && levelCode.length > 0) {
        code = levelCode;
        codeFromPlainKey = errorSpelling === void 0;
        codeFromErrorSpelling = errorSpelling !== void 0;
      } else if (typeof levelCode === "number" && Number.isFinite(levelCode)) {
        code = String(levelCode);
        codeFromPlainKey = errorSpelling === void 0;
        codeFromErrorSpelling = errorSpelling !== void 0;
      }
    }
    const message = node["message"] ?? node["errorMessage"];
    if (typeof message === "string" && message.trim() !== "" && !signals.includes(message)) signals.push(message);
    if ((detail === "" || tryJsonObject(detail) !== void 0) && typeof message === "string" && message.length > 0) detail = message;
    const flat = typeof node["error"] === "string" ? node["error"] : typeof node["details"] === "string" ? node["details"] : void 0;
    if (flat !== void 0 && flat.trim() !== "" && !signals.includes(flat)) signals.push(flat);
    if (detail === "" && flat !== void 0 && flat.length > 0) detail = flat;
    const nested = isPlainObject(node["details"]) ? node["details"] : isPlainObject(node["error"]) ? node["error"] : void 0;
    const next = nested ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
    if (next === void 0) break;
    node = next;
    arrivedViaContainer = nested !== void 0;
    descended = true;
  }
  if (descended && detail === "" && isPlainObject(node)) {
    detail = JSON.stringify(node);
  }
  if (codeFromPlainKey && isAcknowledgementCode(code)) {
    code = "";
    detail = "";
  }
  return { code, detail, signals: signals.join("\n") };
}
function retryAfterSecondsOf(frame) {
  const seen = /* @__PURE__ */ new Set();
  let node = frame;
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node) || seen.has(node)) break;
    seen.add(node);
    const direct = node["retryAfterSeconds"];
    if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
    const message = node["message"] ?? node["errorMessage"];
    const nested = isPlainObject(node["details"]) ? node["details"] : isPlainObject(node["error"]) ? node["error"] : void 0;
    const next = nested ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
    if (next === void 0) break;
    node = next;
  }
  return 0;
}
function qoderFrameParts(payload) {
  const outer = tryJsonObject(payload);
  if (outer === void 0) return void 0;
  const body = outer["body"];
  const inner = typeof body === "string" ? tryJsonObject(body) : isPlainObject(body) ? body : void 0;
  return inner === void 0 ? { envelope: void 0, content: outer } : { envelope: outer, content: inner };
}
function decodeQoderFrame(payload) {
  const parts = qoderFrameParts(payload);
  if (parts === void 0) return { type: "unknown", reason: "unparseable", data: payload };
  const { envelope, content } = parts;
  const choices = content["choices"];
  const hasOutput = Array.isArray(choices) && choices.length > 0;
  const hasUsage = content["usage"] !== void 0 && content["usage"] !== null;
  if (hasOutput || hasUsage) {
    if (envelope !== void 0) {
      const outer = unwrapFailure(envelope);
      if (outer.code !== "" || outer.detail !== "") {
        return {
          type: "failure",
          code: outer.code,
          detail: outer.detail,
          signals: outer.signals,
          retryAfterSeconds: retryAfterSecondsOf(envelope)
        };
      }
    }
    return { type: "chunk", chunk: content };
  }
  for (const layer of envelope === void 0 ? [content] : [envelope, content]) {
    const { code, detail, signals } = unwrapFailure(layer);
    if (code === "" && detail === "") continue;
    return { type: "failure", code, detail, signals, retryAfterSeconds: retryAfterSecondsOf(layer) };
  }
  return { type: "unknown", reason: "unnamed", data: content };
}
const MAX_LINE_CHARS = 64 * 1024 * 1024;
class QoderFrameDecoder {
  buffer = "";
  done = false;
  /** Whether the wire has supplied its terminal marker, independent of TCP EOF. */
  get ended() {
    return this.done;
  }
  /** Payloads seen so far; `[DONE]` ends the stream and yields nothing. */
  push(chunk) {
    if (this.done) return [];
    this.buffer += chunk;
    const payloads = [];
    for (; ; ) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null || match.index === void 0) break;
      if (match[0] === "\r" && match.index + 1 === this.buffer.length) break;
      const line = this.buffer.slice(0, match.index).trim();
      this.buffer = this.buffer.slice(match.index + match[0].length);
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
  isAcknowledgementCode,
  retryAfterSecondsOf,
  unwrapFailure
});
