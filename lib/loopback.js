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
var loopback_exports = {};
__export(loopback_exports, {
  answerRequest: () => answerRequest,
  bearerAccepted: () => bearerAccepted,
  hostIsLoopback: () => hostIsLoopback,
  hostnameOfHost: () => hostnameOfHost,
  isJsonContentType: () => isJsonContentType,
  listedModels: () => listedModels,
  originIsLoopback: () => originIsLoopback,
  readRequestBody: () => readRequestBody,
  redactSecrets: () => redactSecrets,
  writeJson: () => writeJson,
  writeOpenAIError: () => writeOpenAIError
});
module.exports = __toCommonJS(loopback_exports);
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]"]);
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
  return hostname;
}
function hostIsLoopback(host) {
  if (host === void 0 || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback(origin) {
  if (origin === void 0 || origin.trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
  } catch {
    return false;
  }
}
function isJsonContentType(req) {
  const type = req.headers["content-type"];
  return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function bearerAccepted(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return true;
  return /^Bearer\s+(.+)$/i.test(header.trim());
}
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message: redactSecrets(message), type: kind, code: kind } });
}
const REDACTIONS = [
  [/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2}/g, "[redacted token]"],
  [/\b(qoder-oauth-token-)[A-Za-z0-9_-]+/g, "$1[redacted]"],
  [/\b(rt_)[A-Za-z0-9_-]+/g, "$1[redacted]"],
  // A header that carries the credential itself. Anchored on the scheme name, so
  // prose that merely says "bearer" is untouched.
  [/\b(Bearer|Cloud-IDE-JWT|X-Refresh-Token|Cosy-Key)\s*:?\s+\S+/gi, "$1 [redacted]"],
  /**
   * A field whose name says it is a credential. The value must be at least six
   * characters and carry a letter, which is what keeps this off an upstream
   * business code — `"code":6004` and `code=11115` are the actionable half of an
   * error, and a bare `code` is deliberately not a key here for the same reason
   * (`"code":"soft_rate"` is the classification, not a secret).
   */
  [/(["']?(?:access_?token|refresh_?token|id_?token|auth_?token|api_?key|secret|token)["']?\s*[:=]\s*["']?)(?=[A-Za-z0-9_-]{6,})(?=[A-Za-z0-9_-]*[A-Za-z_-])[A-Za-z0-9_-]+/gi, "$1[redacted]"],
  [/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, "[redacted path]"],
  [/\\\\[^\r\n"'<>|]+/g, "[redacted path]"],
  [/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, "$1[redacted path]$1"]
];
function redactSecrets(text) {
  let out = typeof text === "string" ? text : String(text);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}
function listedModels(directory, listedIds) {
  if (listedIds.length === 0) return directory;
  const allowed = new Set(listedIds);
  const picked = directory.filter((model) => allowed.has(model.id));
  return picked.length > 0 ? picked : directory;
}
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
class BodyTooLargeError extends Error {
}
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        reject(new BodyTooLargeError("request body too large"));
        setImmediate(() => {
          if (!req.destroyed) req.destroy();
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function answerRequest(res, handle, log) {
  res.on("error", (error) => {
    log?.warn?.("pi-desktop-xdpool: response socket closed mid-write", error);
  });
  try {
    await handle();
  } catch (error) {
    log?.warn?.("pi-desktop-xdpool: request failed", error);
    try {
      if (!res.headersSent) {
        if (error instanceof BodyTooLargeError) {
          writeOpenAIError(res, 413, "request_too_large", String(error.message));
          return;
        }
        writeOpenAIError(res, 500, "internal", String(error));
      } else res.end();
    } catch (writeError) {
      log?.warn?.("pi-desktop-xdpool: could not answer a failed request", writeError);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  answerRequest,
  bearerAccepted,
  hostIsLoopback,
  hostnameOfHost,
  isJsonContentType,
  listedModels,
  originIsLoopback,
  readRequestBody,
  redactSecrets,
  writeJson,
  writeOpenAIError
});
