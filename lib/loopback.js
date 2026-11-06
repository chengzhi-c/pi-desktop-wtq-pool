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
  BodyTooLargeError: () => BodyTooLargeError,
  PEEK_MAX_BYTES: () => PEEK_MAX_BYTES,
  PEEK_MAX_CHUNKS: () => PEEK_MAX_CHUNKS,
  RELAY_STREAM: () => RELAY_STREAM,
  answerRequest: () => answerRequest,
  bearerAccepted: () => bearerAccepted,
  boundedRetryAfterSeconds: () => boundedRetryAfterSeconds,
  channelCheckRefusal: () => channelCheckRefusal,
  createLoopbackServer: () => createLoopbackServer,
  guardsPass: () => guardsPass,
  hostIsLoopback: () => hostIsLoopback,
  isJsonContentType: () => isJsonContentType,
  liftUpstreamMessage: () => liftUpstreamMessage,
  listedModels: () => listedModels,
  openAIFinishReason: () => openAIFinishReason,
  originIsLoopback: () => originIsLoopback,
  pumpToResponse: () => pumpToResponse,
  readJsonBody: () => readJsonBody,
  readRequestBody: () => readRequestBody,
  redactSecrets: () => redactSecrets,
  relayStreamOf: () => relayStreamOf,
  replaySource: () => replaySource,
  requestPathname: () => requestPathname,
  retryAfterHeader: () => retryAfterHeader,
  safeMessage: () => safeMessage,
  unapprovedChannelRefusal: () => unapprovedChannelRefusal,
  withRelayStream: () => withRelayStream,
  writeChunk: () => writeChunk,
  writeJson: () => writeJson,
  writeOpenAIError: () => writeOpenAIError
});
module.exports = __toCommonJS(loopback_exports);
var import_node_http = require("node:http");
var import_log = require("./log");
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  if (hostname.split(":").length > 2) return hostname;
  const colon = hostname.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
  return hostname;
}
function hostIsLoopback(host) {
  if (host === void 0 || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function requestPathname(raw) {
  if (raw === void 0 || raw === "") return "/";
  try {
    return new URL(raw, "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}
function originIsLoopback(origin) {
  if (origin === void 0 || origin.trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname);
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
  res.writeHead(status, {
    "Content-Type": "application/json",
    // A client that sniffs the body instead of the header can be talked into
    // reading JSON as markup; every other writer here says so.
    "X-Content-Type-Options": "nosniff",
    // Nothing any of these routes answers is cacheable: a panel document, a
    // model list and an error are all reads of live state.
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function safeMessage(error) {
  const text = error && typeof error === "object" && "message" in error && error.message ? String(error.message) : String(error);
  return redactSecrets(text).slice(0, 500);
}
function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message: redactSecrets(message), type: kind, code: kind } });
}
const BARE_CREDENTIAL_KEYS = "access_?token|refresh_?token|id_?token|auth_?token|oauth_?token|api_?key|secret|token";
const CREDENTIAL_KEYS = `${BARE_CREDENTIAL_KEYS}|authorization|x-ide-token|x-refresh-token|x-api-key|x-cloudide-token|cloud-ide-jwt|cosy-key|cosy-machinetoken|cosy-machineid|cosy-user|x-user-id|x-device-id|x-machine-id|x-uid`;
const CREDENTIAL_KEY_PREFIX = `(?:\\\\{0,2}["']?)(?:${CREDENTIAL_KEYS})(?:\\\\{0,2}["']?\\s*[:=]\\s*)`;
const CREDENTIAL_ARRAY_OPEN = new RegExp(`(${CREDENTIAL_KEY_PREFIX})\\\\?\\[`, "gi");
const BARE_CREDENTIAL = new RegExp(
  `((?:\\\\{0,2}["']?)(?:${BARE_CREDENTIAL_KEYS})(?:\\\\{0,2}["']?\\s*[:=]\\s*\\\\{0,2}["']?))[A-Za-z0-9_+/.=-]{6,}`,
  "gi"
);
const REDACTIONS = [
  // A scheme that carries the credential itself, in either the `Bearer <value>`
  // header form or the `"Cosy-Key":"<value>"` form a quoted JSON echo takes. This
  // runs before the bare-JWT rule below: a JWT replaced first would leave the
  // scheme rule matching the replacement's own text and print a half-redaction.
  // The value is a bounded token run, not `\S+` - the greedy form ate the rest of
  // the line, destroying the fields after it and truncating the body mid-JSON -
  // and the eight-character floor is what keeps a prose word (`invalid Bearer
  // format`) from being taken for a credential.
  [/\b(Bearer|Basic|Digest|Negotiate|NTLM|Cosy-Key|Cosy-Machineid|Cosy-Machinetoken|Cosy-User|Cloud-IDE-JWT|X-Cloudide-Token|X-Ide-Token|X-Refresh-Token|X-Api-Key|X-User-Id|x-device-id|x-machine-id|x-uid)\b([\s:="'\\]{1,6})[A-Za-z0-9_+/.=~-]{8,}/gi, "$1$2[redacted]"],
  // `authorization` alone is not in BARE_CREDENTIAL_KEYS because that rule would
  // eat the scheme word and leave the value behind (`authorization: Bearer …`
  // became `authorization: [redacted] …`). The scheme rule above covers the
  // forms that carry one; this covers the rest - an opaque value sent without a
  // scheme, which is a real shape (`{"authorization":"<opaque>"}` or a raw
  // `Authorization: <opaque>` echo) and had no rule at all.
  //
  // The value must carry a digit: a bare 8+ letter run after this key is far
  // more often prose (`Authorization: required`) than a credential, and the
  // real ones - opaque base64 payloads - carry digits. The scheme rule keeps
  // its digit-free form, because there the scheme word already says it is a
  // credential.
  [/\b(authorization|proxy-authorization)\b([\s:="'\\]{1,6})(?!(?:Bearer|Basic|Digest|Negotiate|NTLM)\b)(?=[A-Za-z0-9_+/.=~-]{8,})(?=[A-Za-z0-9_+/.=~-]*[0-9])[A-Za-z0-9_+/.=~-]+/gi, "$1$2[redacted]"],
  [/\beyJ[A-Za-z0-9_+/.=-]+(?:\.[A-Za-z0-9_+/.=-]+){0,2}/g, "[redacted token]"],
  [/\b(qoder-oauth-token-)[A-Za-z0-9_+/.=-]+/g, "$1[redacted]"],
  [/\b(rt_)[A-Za-z0-9_+/.=-]+/g, "$1[redacted]"],
  [BARE_CREDENTIAL, "$1[redacted]"],
  // An address names an account as surely as its label does, and this text
  // reaches logs and client-facing errors. Mask it before the path rules below.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[account]"],
  [/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, "[redacted path]"],
  [/\\\\[^\r\n"'<>|]+/g, "[redacted path]"],
  [/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, "$1[redacted path]$1"],
  // An unquoted POSIX absolute path, for the same reason the Windows rule above
  // needs no quotes. It is deliberately narrower than "anything with a slash in
  // it": the extension is required, and a segment may carry spaces but not start
  // with one, so `POST /v1/chat/completions returned 4001` and `and/or` survive
  // intact - that is the actionable half of an error and destroying it would
  // trade a path disclosure for an undiagnosable one.
  [/(?<![\w./])\/(?:[\w.@-]+(?: [\w.@-]+)*\/)+[\w.@-]+(?: [\w.@-]+)*\.[A-Za-z][\w]*/g, "[redacted path]"],
  // The exception the rule above leaves open, named rather than generalised:
  // Trae keeps its credential in `~/.trae-cn/trae-jwt-token`, which has no
  // extension and so matched nothing. The home directory it sits in is the
  // disclosure. Listing the directory is what keeps this narrow enough that
  // ordinary prose stays readable.
  [/(?<![\w./])(?:\/[\w.@-]+)*\/(?:\.trae|\.trae-cn|\.workbuddy|\.qoder)(?:\/[\w.@-]+)*\/?[^\s"'<>|]*/g, "[redacted path]"]
];
const ARRAY_SCAN_LIMIT = 65536;
function arrayEnd(text, start) {
  const limit = Math.min(text.length, start + ARRAY_SCAN_LIMIT);
  let quote = "";
  let depth = 1;
  for (let i = start; i < limit; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function scanGiveUpEnd(text, start) {
  const limit = Math.min(text.length, start + ARRAY_SCAN_LIMIT);
  for (let i = limit; i < text.length; i += 1) {
    if (text[i] === "\n" || text[i] === "\r") return i + 1;
  }
  return text.length;
}
function redactCredentialArrays(text) {
  let out = "";
  let cursor = 0;
  CREDENTIAL_ARRAY_OPEN.lastIndex = 0;
  for (let match = CREDENTIAL_ARRAY_OPEN.exec(text); match !== null; match = CREDENTIAL_ARRAY_OPEN.exec(text)) {
    const key = match[1];
    const bodyStart = match.index + match[0].length;
    const closed = arrayEnd(text, bodyStart);
    if (closed === -1) {
      const stop = scanGiveUpEnd(text, bodyStart);
      if (stop === bodyStart) {
        CREDENTIAL_ARRAY_OPEN.lastIndex = bodyStart;
        continue;
      }
      out += text.slice(cursor, match.index) + key + "[redacted]";
      cursor = stop;
      CREDENTIAL_ARRAY_OPEN.lastIndex = stop;
      continue;
    }
    out += text.slice(cursor, match.index) + key + "[redacted]";
    cursor = closed;
    CREDENTIAL_ARRAY_OPEN.lastIndex = closed;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
function redactSecrets(text) {
  let out = typeof text === "string" ? text : String(text);
  out = redactCredentialArrays(out);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}
function unapprovedChannelRefusal(text) {
  if (!/"code"\s*:\s*"?11128\b/u.test(text) && !/\bcode 11128\b/u.test(text)) return void 0;
  return channelCheckRefusal();
}
function channelCheckRefusal() {
  return "the WorkBuddy host refused this conversation at its client check (11128). That screen reads system and assistant turns for wording that belongs to a client it does not serve, so remove client-identifying text from the conversation, start a new one, or use Trae or Qoder for this prompt.";
}
function openAIFinishReason(upstream, sawToolCalls) {
  const stated = upstream === void 0 || upstream === "" || upstream === "null" ? void 0 : upstream;
  if (stated !== void 0 && stated !== "stop") return stated;
  return sawToolCalls ? "tool_calls" : "stop";
}
function listedModels(directory, listedIds) {
  if (listedIds.length === 0) return directory;
  const allowed = new Set(listedIds);
  const picked = directory.filter((model) => allowed.has(model.id));
  return picked.length > 0 ? picked : directory;
}
function liftUpstreamMessage(text) {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return redactSecrets(text);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return redactSecrets(text);
  const record = parsed;
  const error = record["error"];
  if (typeof error === "string" && error.trim() !== "") return redactSecrets(error);
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = error["message"];
    if (typeof message === "string" && message.trim() !== "") return redactSecrets(message);
  }
  if (typeof record["message"] === "string" && record["message"].trim() !== "") {
    return redactSecrets(record["message"]);
  }
  return "";
}
const RETRY_AFTER_CEILING_SECONDS = 2 * 60 * 60;
function boundedRetryAfterSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return void 0;
  return Math.min(Math.ceil(seconds), RETRY_AFTER_CEILING_SECONDS);
}
function retryAfterHeader(value) {
  const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  const bounded = boundedRetryAfterSeconds(seconds);
  return bounded === void 0 ? void 0 : String(bounded);
}
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
const BODY_DRAIN_GRACE_MS = 1e4;
class BodyTooLargeError extends Error {
}
function readRequestBody(req, limitBytes = REQUEST_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new BodyTooLargeError("request body too large"));
      const grace = setTimeout(() => {
        if (!req.destroyed) req.destroy();
      }, BODY_DRAIN_GRACE_MS);
      grace.unref();
      const done = () => {
        clearTimeout(grace);
        if (!req.destroyed) req.destroy();
      };
      req.on("end", done);
      req.on("error", done);
      return;
    }
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        if (!refused) {
          refused = true;
          reject(new BodyTooLargeError("request body too large"));
          const grace = setTimeout(() => {
            if (!req.destroyed) req.destroy();
          }, BODY_DRAIN_GRACE_MS);
          grace.unref();
          const done = () => {
            clearTimeout(grace);
            if (!req.destroyed) req.destroy();
          };
          req.on("end", done);
          req.on("error", done);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function answerRequest(res, handle, log, answerFailure) {
  res.on?.("error", (error) => {
    log?.warn?.(import_log.LOG_PREFIX + ": response socket closed mid-write", error);
  });
  try {
    await handle();
  } catch (error) {
    log?.warn?.(import_log.LOG_PREFIX + ": request failed", error);
    const answer = answerFailure ?? ((target, caught) => {
      if (caught instanceof BodyTooLargeError) {
        writeOpenAIError(target, 413, "request_too_large", String(caught.message));
      } else {
        writeOpenAIError(target, 500, "internal", String(caught));
      }
    });
    try {
      if (!res.headersSent) answer(res, error);
      else res.end();
    } catch (writeError) {
      log?.warn?.(import_log.LOG_PREFIX + ": could not answer a failed request", writeError);
    }
  }
}
async function readJsonBody(req, limitBytes = REQUEST_BODY_LIMIT) {
  const raw = (await readRequestBody(req, limitBytes)).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
const PEEK_MAX_CHUNKS = 64;
const PEEK_MAX_BYTES = 262144;
const RELAY_STREAM = Symbol.for("wtq-pool.relay-stream");
function withRelayStream(response, stream) {
  Object.defineProperty(response, RELAY_STREAM, { value: stream, enumerable: false });
  return response;
}
function relayStreamOf(response) {
  const attached = response[RELAY_STREAM];
  if (attached !== void 0) return attached;
  if (response.body === null) throw new Error("response carries no body");
  return response.body;
}
async function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return;
  if (res.write(Buffer.from(chunk))) return;
  if (res.destroyed) return;
  await new Promise((resolve) => {
    const wake = () => {
      res.off("drain", wake);
      res.off("close", wake);
      resolve();
    };
    res.once("drain", wake);
    res.once("close", wake);
  });
}
async function pumpToResponse(source, res) {
  const reader = source.getReader();
  const releaseLock = () => {
    try {
      reader.releaseLock();
    } catch {
    }
  };
  if (res.destroyed || res.writableEnded) {
    await reader.cancel().catch(() => {
    });
    releaseLock();
    return;
  }
  const cancel = () => {
    void reader.cancel().catch(() => {
    });
  };
  res.once("close", cancel);
  try {
    for (; ; ) {
      const next = await reader.read();
      if (next.done) break;
      await writeChunk(res, next.value);
      if (res.destroyed || res.writableEnded) break;
    }
  } finally {
    res.off("close", cancel);
    releaseLock();
  }
  if (res.writable && !res.destroyed) res.end();
}
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
function guardsPass(req, res) {
  if (!hostIsLoopback(req.headers.host)) {
    writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
    return false;
  }
  if (!originIsLoopback(req.headers.origin)) {
    writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
    return false;
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "" && site !== "same-origin" && site !== "same-site" && site !== "none") {
    writeOpenAIError(res, 403, "origin_not_allowed", "cross-site request to a loopback gateway");
    return false;
  }
  if (!bearerAccepted(req)) {
    writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
    return false;
  }
  return true;
}
function createLoopbackServer(options) {
  const server = (0, import_node_http.createServer)((req, res) => {
    void answerRequest(res, () => options.handle(req, res), options.logger);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  server.on("error", (error) => {
    options.logger?.warn?.(import_log.LOG_PREFIX + ": " + options.label + " server error", safeMessage(error));
  });
  return {
    ready,
    /** The bound port, or 0 before `listening` (or after close). */
    port: () => {
      const address = server.address();
      return address === null || typeof address === "string" ? 0 : address.port;
    },
    baseUrl: () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error(options.label + " has no listening address");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BodyTooLargeError,
  PEEK_MAX_BYTES,
  PEEK_MAX_CHUNKS,
  RELAY_STREAM,
  answerRequest,
  bearerAccepted,
  boundedRetryAfterSeconds,
  channelCheckRefusal,
  createLoopbackServer,
  guardsPass,
  hostIsLoopback,
  isJsonContentType,
  liftUpstreamMessage,
  listedModels,
  openAIFinishReason,
  originIsLoopback,
  pumpToResponse,
  readJsonBody,
  readRequestBody,
  redactSecrets,
  relayStreamOf,
  replaySource,
  requestPathname,
  retryAfterHeader,
  safeMessage,
  unapprovedChannelRefusal,
  withRelayStream,
  writeChunk,
  writeJson,
  writeOpenAIError
});
