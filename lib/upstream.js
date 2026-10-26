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
var upstream_exports = {};
__export(upstream_exports, {
  ERROR_BODY_TIMEOUT_MS: () => ERROR_BODY_TIMEOUT_MS,
  WorkBuddyUpstreamClient: () => WorkBuddyUpstreamClient,
  classifyUpstreamError: () => classifyUpstreamError,
  headersDeadline: () => headersDeadline,
  isBuddyThresholdIncomplete: () => isBuddyThresholdIncomplete,
  isHardCreditText: () => isHardCreditText,
  parseRateLimitReset: () => parseRateLimitReset,
  readErrorBody: () => readErrorBody,
  regionOf: () => regionOf,
  retryAfterSeconds: () => retryAfterSeconds,
  tokenExpiryMs: () => tokenExpiryMs,
  upstreamErrorKind: () => upstreamErrorKind,
  withIdleWatchdog: () => withIdleWatchdog
});
module.exports = __toCommonJS(upstream_exports);
var import_node_crypto = require("node:crypto");
var import_checkin_time = require("./checkin-time");
var import_loopback = require("./loopback");
function isBuddyThresholdIncomplete(message) {
  return typeof message === "string" && message.toLowerCase().includes("first_buddy task not completed yet");
}
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_VERSION = "5.8.4";
const CLI_VERSION = "2.161.0";
const CLIENT_UA = `WorkBuddy/${CLIENT_VERSION} WorkBuddy/${CLIENT_VERSION} CLI/${CLI_VERSION}`;
const GLOBAL_CHAT_UA = `WorkBuddy/${CLIENT_VERSION} workbuddy-ai/${CLIENT_VERSION} CLI/${CLI_VERSION}`;
const DESKTOP_UA = `WorkBuddy/${CLIENT_VERSION}`;
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
const ERROR_BODY_TIMEOUT_MS = 1e4;
const STREAM_HEADERS_TIMEOUT_MS = 6e4;
const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1e3;
const ASSUMED_TOKEN_LIFETIME_MS = 60 * 60 * 1e3;
const MAX_EXPIRY_MS = 41024448e5;
function tokenExpiryMs(expiresInSec) {
  const assumed = () => Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
  if (typeof expiresInSec !== "number" || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    return assumed();
  }
  const at = Date.now() + expiresInSec * 1e3;
  if (!Number.isFinite(at) || at > MAX_EXPIRY_MS) return assumed();
  return at;
}
function retryAfterSeconds(headers) {
  const raw = headers.get("retry-after");
  if (raw === null || raw.trim() === "") return void 0;
  return (0, import_loopback.boundedRetryAfterSeconds)(Number(raw.trim()));
}
function withIdleWatchdog(body, idleMs = STREAM_IDLE_TIMEOUT_MS, signal) {
  const reader = body.getReader();
  let timer;
  let idle;
  const disarm = () => {
    if (timer !== void 0) clearTimeout(timer);
    timer = void 0;
  };
  const stop = (reason) => {
    if (idle !== void 0) return;
    idle = reason;
    void reader.cancel(reason).catch(() => {
    });
    disarm();
    detach();
  };
  const onAbort = () => {
    stop(signal?.reason instanceof Error ? signal.reason : new Error("upstream stream cancelled by the caller"));
  };
  const detach = () => {
    signal?.removeEventListener("abort", onAbort);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort);
  const finish = () => {
    disarm();
    detach();
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      stop(new Error("upstream stream went idle"));
    }, idleMs);
    timer.unref?.();
  };
  return new ReadableStream({
    start() {
      arm();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (idle !== void 0) {
          finish();
          controller.error(idle);
          return;
        }
        arm();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    }
  });
}
function headersDeadline(caller, ms) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller?.aborted === true) controller.abort(caller.reason);
  else caller?.addEventListener("abort", onCallerAbort);
  const timer = setTimeout(() => {
    controller.abort(new Error(`upstream did not send response headers within ${ms}ms`));
  }, ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    arrived: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  };
}
const HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "\u79EF\u5206\u4E0D\u8DB3",
  "\u989D\u5EA6\u4E0D\u8DB3",
  "\u4F59\u989D\u4E0D\u8DB3",
  "\u79EF\u5206\u7528\u5B8C",
  "\u989D\u5EA6\u7528\u5C3D",
  "\u6CA1\u6709\u79EF\u5206"
];
function isHardCreditText(body) {
  const lower = body.toLowerCase();
  return HARD_CREDIT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()) || body.includes(marker));
}
const SESSION_DEAD_PATTERN = /Offline user session not found|"code"\s*:\s*"?12153\b/u;
const MODEL_TIER_PATTERN = /"code"\s*:\s*"?11158\b/u;
const ACCOUNT_RESTRICTED_PATTERN = /"code"\s*:\s*"?11140\b/u;
const GLOBAL_HOSTS = ["workbuddy.ai", "workbuddy.cc", "codebuddy.ai"];
function regionOf(domain) {
  const lowered = domain.trim().toLowerCase();
  for (const host of GLOBAL_HOSTS) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return "global";
  }
  return "cn";
}
function globalBase(credential) {
  const lowered = credential.domain.trim().toLowerCase();
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
  return GLOBAL_BASE;
}
function chatBase(credential) {
  return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_CHAT_BASE;
}
function billingBase(credential) {
  return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
function commonHeaders(credential) {
  return {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": billingBase(credential),
    "Referer": `${billingBase(credential)}/`,
    "User-Agent": CLIENT_UA,
    // The official client's gate header, on every API request. Missing it
    // marks the caller as something other than the client.
    "X-CodeBuddy-Request": "1",
    // One connection per request. undici's global pool would otherwise hand a
    // socket that just carried another account's Authorization to the next
    // account, and two credentials seen on one connection is a correlation
    // clue the connection itself carries. fetch exposes no per-request agent,
    // so the socket is closed instead; a turn pays one handshake for it.
    "Connection": "close"
  };
}
function conversationHeaders() {
  const turn = (0, import_node_crypto.randomUUID)().replace(/-/g, "");
  const message = (0, import_node_crypto.randomUUID)().replace(/-/g, "");
  const traceId = (0, import_node_crypto.randomUUID)().replace(/-/g, "");
  const spanId = (0, import_node_crypto.randomBytes)(8).toString("hex");
  return {
    "X-Conversation-ID": (0, import_node_crypto.randomUUID)(),
    "X-Conversation-Request-ID": turn,
    "X-Root-Request-ID": turn,
    "X-Conversation-Message-ID": message,
    "X-Request-ID": message,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Version": CLIENT_VERSION,
    "X-Private-Data": "true",
    "X-Trace-ID": traceId,
    "traceparent": `00-${traceId}-${spanId}-01`,
    "b3": `${traceId}-${spanId}-1`,
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1"
  };
}
function chatHeaders(credential) {
  return {
    ...commonHeaders(credential),
    ...conversationHeaders(),
    "Content-Type": "application/json",
    "Authorization": `Bearer ${credential.accessToken}`,
    ...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
    ...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
    ...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
    "X-Product": "SaaS",
    // The international gateway answers the CN spelling of the UA with the
    // roster it gives the CLI, so the captured desktop one is used there.
    ...regionOf(credential.domain) === "global" ? { "User-Agent": GLOBAL_CHAT_UA } : {}
  };
}
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    "X-Refresh-Token": credential.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy"
  };
  if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  }
  return headers;
}
function billingHeaders(credential) {
  const headers = {
    "Authorization": `Bearer ${credential.accessToken}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
    // Billing does not go through commonHeaders, so the gate header lands here.
    "X-CodeBuddy-Request": "1",
    // A request with no UA at all is its own kind of fingerprint: every client
    // sends one, and leaving it out made the billing family look unlike the
    // desktop app the rest of the calls imitate.
    "User-Agent": CLIENT_UA,
    // Same reason as commonHeaders: one connection, one account.
    "Connection": "close"
  };
  if (credential.uid !== "" && credential.uid !== void 0) headers["X-User-Id"] = credential.uid;
  if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
  }
  if (credential.domain !== "") headers["X-Domain"] = credential.domain;
  return headers;
}
function isGatewayHtmlRejection(status, text) {
  if (status !== 401 && status !== 403) return false;
  const head = text.slice(0, 512).toLowerCase();
  return head.includes("<html") || head.includes("openresty") || head.includes("apisix");
}
function gatewayRejectionText(status) {
  return `the WorkBuddy gateway rejected this credential (http ${status}). This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run the WTQ Pool connection check (the panel's connection tab) to list every credential found.`;
}
async function readErrorBody(response, limitBytes, signal, timeoutMs = ERROR_BODY_TIMEOUT_MS) {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const abandon = (reason) => {
    void reader.cancel(new Error(reason)).catch(() => {
    });
  };
  const deadline = setTimeout(() => {
    abandon("upstream error body read timed out");
  }, timeoutMs);
  deadline.unref?.();
  const onAbort = () => {
    abandon("upstream error body read cancelled by the caller");
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort);
  let done = false;
  try {
    for (; ; ) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      text += decoder.decode(next.value, { stream: true });
      if (text.length >= limitBytes) break;
    }
  } catch {
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    if (!done) abandon("upstream error body size limit reached");
    reader.releaseLock();
  }
  return text.length > limitBytes ? text.slice(0, limitBytes) : text;
}
async function readEnvelope(response) {
  const text = await response.text();
  if (isGatewayHtmlRejection(response.status, text)) {
    throw Object.assign(new Error(gatewayRejectionText(response.status)), {
      kind: classifyUpstreamError(response.status, text)
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${(0, import_loopback.redactSecrets)(text).slice(0, 160)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
  }
  const document = parsed;
  return {
    code: typeof document["code"] === "number" ? document["code"] : 0,
    msg: typeof document["msg"] === "string" ? document["msg"] : "",
    data: "data" in document ? document["data"] : void 0
  };
}
function envelopeError(status, envelope) {
  const document = JSON.stringify({ code: envelope.code, msg: envelope.msg });
  const kind = classifyUpstreamError(status, document);
  return Object.assign(
    new Error(`workbuddy upstream ${kind} (http ${status}): ${(0, import_loopback.redactSecrets)(envelope.msg).slice(0, 160)}`),
    { kind }
  );
}
function upstreamErrorKind(error) {
  const kind = error?.kind;
  return typeof kind === "string" ? kind : void 0;
}
function classifyUpstreamError(status, body) {
  if (status === 402) return "hard_credit";
  if (status === 429) return "soft_rate";
  if ((status === 400 || status === 403 || status === 422) && ACCOUNT_RESTRICTED_PATTERN.test(body)) {
    return "account_restricted";
  }
  if ((status === 400 || status === 403 || status === 422) && MODEL_TIER_PATTERN.test(body)) {
    return "model_tier";
  }
  const aboutSignIn = status === 401 || status === 403;
  if (aboutSignIn && SESSION_DEAD_PATTERN.test(body)) return "session_dead";
  if (status === 401) return "session_dead";
  if (status === 403) {
    if (isHardCreditText(body)) return "hard_credit";
  }
  if (status === 503 && (body.includes("soft_rate") || body.includes('"code":6004') || body.includes("\u9891\u7387\u9650\u5236"))) {
    return "soft_rate";
  }
  if (status === 403 && !body.includes('"code":') && !body.includes('"msg":')) return "waf_block";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}
const UPSTREAM_CLOCK_OFFSET_MS = 8 * 60 * 60 * 1e3;
const RATE_RESET_CAP_MS = 2 * 60 * 60 * 1e3;
function capRateReset(value) {
  const now = Date.now();
  if (value <= now) return value;
  return Math.min(value, now + RATE_RESET_CAP_MS);
}
function parseRateLimitReset(body) {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*["']?(\d{10,13})["']?/.exec(body);
  if (epochMs !== null) {
    const raw = Number(epochMs[1]);
    return capRateReset(raw < 1e12 ? raw * 1e3 : raw);
  }
  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
  if (localized !== null) {
    const asUtc = Date.parse(localized[1].replace(" ", "T") + "Z");
    if (!Number.isNaN(asUtc)) return capRateReset(asUtc - UPSTREAM_CLOCK_OFFSET_MS);
  }
  return void 0;
}
function parseCreditMultiplier(value) {
  if (typeof value !== "string") return void 0;
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
  if (match === null) return void 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
const SINGULAR_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
function isSingularEffortForm(raw) {
  return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
function singularEffortLadder(raw) {
  const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
  if (effort === void 0) return void 0;
  return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}
function parseReasoning(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const raw = value;
  const singularForm = isSingularEffortForm(raw);
  const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
  const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string") : singularEffortLadder(raw);
  const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
  const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : singularForm ? true : void 0;
  if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) {
    return void 0;
  }
  return {
    ...supportedEfforts === void 0 || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === void 0 ? {} : { defaultEffort },
    ...canDisableThinking === void 0 ? {} : { canDisableThinking }
  };
}
function numberField(record, key) {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function parseUpstreamModel(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  if (id === "" || raw["disabled"] === true) return void 0;
  const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
  const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
  if (input <= 0 || output <= 0) return void 0;
  const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
  const creditMultiplier = parseCreditMultiplier(raw["credits"]);
  const reasoning = parseReasoning(raw["reasoning"]);
  const supportsImages = typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : void 0;
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === void 0 ? {} : { creditMultiplier },
    ...reasoning === void 0 ? {} : { reasoning },
    ...supportsImages === void 0 ? {} : { supportsImages }
  };
}
function withLeadingSystemPrompt(prepared) {
  let body;
  try {
    body = JSON.parse(prepared);
  } catch {
    return prepared;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return prepared;
  const obj = body;
  const messages = obj["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return prepared;
  const first = messages[0];
  if (typeof first === "object" && first !== null && first["role"] === "system") {
    return prepared;
  }
  obj["messages"] = [{ role: "system", content: "" }, ...messages];
  return JSON.stringify(obj);
}
class WorkBuddyUpstreamClient {
  fetchImpl;
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  /**
   * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
   * force `stream: true` (the upstream rejects non-streaming), convert the
   * DSH `developer` role into `system` (upstream rejects `developer` with
   * business code 11128), and flatten `tool_choice` into its string form.
   */
  prepareChatBody(raw) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return raw;
    const obj = body;
    obj["stream"] = true;
    delete obj["stream_options"];
    if (Array.isArray(obj["messages"])) {
      for (const value of obj["messages"]) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const message = value;
        if (message["role"] === "developer") message["role"] = "system";
      }
    }
    const choice = obj["tool_choice"];
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete obj["tool_choice"];
        delete obj["tools"];
        delete obj["functions"];
      }
    } else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice;
      const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
      if (type === "none") {
        delete obj["tool_choice"];
        delete obj["tools"];
        delete obj["functions"];
      } else if (type === "auto" || type === "required") {
        obj["tool_choice"] = type;
      } else if (type === "function") {
        const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
        let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
        if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
        obj["tool_choice"] = name.trim() !== "" ? name.trim() : "auto";
      }
    }
    return JSON.stringify(obj);
  }
  /** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(credential, prepared, signal, timeouts) {
    let response;
    const deadline = headersDeadline(signal, timeouts?.headersMs ?? STREAM_HEADERS_TIMEOUT_MS);
    const body = regionOf(credential.domain) === "global" ? withLeadingSystemPrompt(prepared) : prepared;
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        redirect: "error",
        method: "POST",
        headers: chatHeaders(credential),
        body,
        signal: deadline.signal
      });
    } catch (error) {
      if (signal?.aborted === true) {
        return { ok: false, kind: "aborted", status: 0, message: "cancelled by the caller" };
      }
      return { ok: false, kind: "transport", status: 0, message: `transport error: ${String(error)}` };
    } finally {
      deadline.arrived();
    }
    if (response.ok) {
      if (response.body === null) {
        return { ok: false, kind: "server", status: 502, message: "upstream returned 200 without a stream" };
      }
      const relayed = withIdleWatchdog(response.body, timeouts?.idleMs, signal);
      return {
        ok: true,
        response: (0, import_loopback.withRelayStream)(new Response(relayed, {
          status: response.status,
          headers: response.headers
        }), relayed)
      };
    }
    const text = await readErrorBody(response, ERROR_BODY_LIMIT, signal);
    const retryAfter = retryAfterSeconds(response.headers);
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      // A gateway page is answered with the sentence that says what to do
      // about it. The page itself is the other half of the same refusal, and
      // relaying it put a screenful of openresty HTML in front of the user
      // where one instruction belonged.
      message: isGatewayHtmlRejection(response.status, text) ? gatewayRejectionText(response.status) : text,
      // The upstream states the wait in the standard header as well as in the
      // body, and the body parse only covers the spellings it knows. Handing
      // the header through lets the shim honour the upstream's own window
      // instead of guessing `cooldownSeconds` for every 429.
      ...retryAfter === void 0 ? {} : { retryAfter }
    };
  }
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      redirect: "error",
      method: "POST",
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
    if (accessToken === "") {
      throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
    }
    const outcome = { accessToken };
    if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
    if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
    if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
    return outcome;
  }
  /**
   * Fetch the model catalog, keeping the `cli` agent's models only.
   *
   * The two gateways are read differently, because they answer differently:
   *
   * - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
   *   the CLI client spelling.
   * - **Global** serves it as part of the product config at `/v3/config`, and
   *   only to the DESKTOP client channel. Asking the global host with the CLI UA
   *   yields a truncated roster, and the CN path answers HTTP 500 there — which
   *   is what left the international provider on its static fallback.
   *
   * Both documents share the `{ models, agents }` entry shape, so the parsing
   * below is common to the two branches.
   */
  async fetchModels(credential, signal) {
    const global = regionOf(credential.domain) === "global";
    const url = global ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}` : `${chatBase(credential)}${MODELS_CATALOG_PATH}`;
    const headers = global ? {
      "Authorization": `Bearer ${credential.accessToken}`,
      "Accept": "application/json",
      ...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
      ...credential.domain === "" ? {} : { "X-Domain": credential.domain },
      "X-Product": "SaaS",
      "X-Requested-With": "XMLHttpRequest",
      // The gate header every API request carries, the global roster included.
      "X-CodeBuddy-Request": "1",
      "Connection": "close",
      "User-Agent": DESKTOP_UA
    } : {
      // Built from commonHeaders rather than spelled out: the hand-written
      // copy was the one WorkBuddy request that missed the gate header and
      // the per-request connection close, so a roster call could hand a
      // socket with one account's Authorization to the next account.
      ...commonHeaders(credential),
      "Authorization": `Bearer ${credential.accessToken}`,
      "Accept": "application/json"
    };
    if (!global && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
      headers["X-Enterprise-Id"] = credential.enterpriseId;
    }
    const response = await this.fetchImpl(url, {
      redirect: "error",
      headers,
      ...signal === void 0 ? {} : { signal }
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
    const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
    let cliIds;
    for (const agent of agents) {
      if (typeof agent === "object" && agent !== null) {
        const wrapped = agent;
        if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
          cliIds = wrapped["models"].filter((id) => typeof id === "string");
          break;
        }
      }
    }
    const byId = /* @__PURE__ */ new Map();
    for (const model of rawModels) {
      const parsed = parseUpstreamModel(model);
      if (parsed !== void 0) byId.set(parsed.id, parsed);
    }
    const ids = cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()];
    const models = ids.map((id) => byId.get(id)).filter((model) => model !== void 0);
    if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
    return models;
  }
  /** Read-only credits query, aggregated by package. Does not consume credits. */
  async fetchCredits(credential) {
    const now = /* @__PURE__ */ new Date();
    const fmt = (date) => {
      const p = (n) => n.toString().padStart(2, "0");
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
    };
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1e3))
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const data = typeof wrapper["Response"] === "object" && wrapper["Response"] !== null ? wrapper["Response"] : {};
    const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
    const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
    let total = 0;
    let expiringSoon = 0;
    let nearestExpiryMs;
    const SOON_MS = 3 * 24 * 60 * 60 * 1e3;
    const parseDate = (raw) => {
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw > 1e12 ? raw : raw > 1e9 ? raw * 1e3 : void 0;
      }
      if (typeof raw === "string" && raw !== "") {
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return void 0;
    };
    const packages = [];
    for (const raw of rawAccounts) {
      if (typeof raw !== "object" || raw === null) continue;
      const account = raw;
      const monthly = numberField(account, "CapacityType") === 4;
      const size = monthly ? numberField(account, "CycleCapacitySize") : numberField(account, "CapacitySize");
      const remain = monthly ? numberField(account, "CycleCapacityRemain") : numberField(account, "CapacityRemain");
      const capped = remain < 0 ? 0 : remain;
      const cycleEndMs = parseDate(account["CycleEndTime"]);
      const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
      const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
      if (capped <= 0 || !monthly && expiresAtMs !== void 0 && expiresAtMs <= Date.now()) continue;
      total += capped;
      if (expiresAtMs !== void 0 && expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped;
      if (expiresAtMs !== void 0 && (nearestExpiryMs === void 0 || expiresAtMs < nearestExpiryMs)) {
        nearestExpiryMs = expiresAtMs;
      }
      packages.push({
        packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
        remain: capped,
        size,
        monthly,
        ...refreshAtMs === void 0 ? {} : { refreshAtMs },
        ...expiresAtMs === void 0 ? {} : { expiresAtMs }
      });
    }
    return {
      total,
      packages,
      expiringSoon,
      ...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
    };
  }
  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential) {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    return {
      active: data["active"] === true,
      todayCheckedIn: data["today_checked_in"] === true,
      streakDays: numberField(data, "streak_days"),
      dailyCredit: numberField(data, "daily_credit"),
      todayCredit: numberField(data, "today_credit"),
      isStreakDay: data["is_streak_day"] === true,
      nextStreakDay: numberField(data, "next_streak_day"),
      streakBonusCredit: numberField(data, "streak_bonus_credit")
    };
  }
  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential) {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    return {
      credit: numberField(data, "credit"),
      streakDays: numberField(data, "streak_days"),
      isStreakDay: data["is_streak_day"] === true
    };
  }
  /**
   * Query the account's buddy profile; null means no buddy yet.
   *
   * Null, missing and empty-object shapes all read as "no buddy" — the
   * upstream answers whichever it feels like, and the caller adopts in all
   * three cases.
   */
  async fetchBuddyInfo(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/info`, {
      redirect: "error",
      headers: billingHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const raw = data["buddy"];
    if (raw === null || raw === void 0) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    const profile = raw;
    return {
      id: typeof profile["id"] === "number" ? profile["id"] : 0,
      name: typeof profile["name"] === "string" ? profile["name"] : ""
    };
  }
  /** Query the cat-travel state for one account. */
  async fetchTravelStatus(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/status`, {
      redirect: "error",
      headers: billingHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    return {
      state: typeof data["state"] === "string" ? data["state"] : "",
      dailyLimitReached: data["daily_limit_reached"] === true,
      recordId: numberField(data, "record_id")
    };
  }
  /**
   * Dispatch the buddy to travel. Location 4 (ancient-town inn): the four
   * locations share the same reward/duration range, so there is no optimum —
   * the number just has to be one the upstream accepts.
   */
  async departTravel(credential, locationId = 4) {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/depart`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify({ location_id: locationId }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  }
  /**
   * Claim the arrival reward. A missing reward field is not a failure — the
   * caller logs 0 and moves on, matching the upstream's own tolerance.
   */
  async claimTravelReward(credential, recordId) {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/claim`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify({ record_id: recordId }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    return numberField(data, "reward_credit");
  }
  /** Accept the buddy agreement. Idempotent: safe to repeat. */
  async agreeBuddy(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/agreement`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify({ agree: true }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  }
  /** Adopt the first buddy. Throws the threshold refusal when unqualified. */
  async adoptBuddy(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/first`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  }
  /**
   * Report one chat activity. The full event shape, not a minimal subset: the
   * upstream lights growth streak and unlocks the first-buddy task on this,
   * and a trimmed event risks a future tightening. `userId` is the account
   * uid — without it the upstream answers 200 yet silently drops the report.
   *
   * The uid is not optional and is not substituted: the `uin` is a different
   * identifier, and sending it produced exactly the silent drop the comment
   * above warns about, with a 200 to show for it. An account that carries no
   * uid fails loudly instead.
   */
  async reportChatActivity(credential, conversationId) {
    const uid = credential.uid ?? "";
    if (uid === "") throw new Error("workbuddy report needs a uid-bearing credential");
    const now = Date.now();
    const event = {
      eventCode: "chat_request_send",
      timestamp: now,
      reportDelay: 0,
      mode: "craft",
      conversationId,
      requestId: conversationId,
      inputLength: 12,
      requestModelId: "deepseek-v4-flash",
      requestModelName: "DeepSeek V4 Flash",
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: "",
      mentionContextCount: 0,
      command: "",
      expertId: "",
      recommendId: "",
      skillId: "",
      skillCount: 0,
      totalCount: 0,
      fileUri: "",
      presentAt: now,
      traceId: "",
      rootRequestId: conversationId,
      parentConversationId: conversationId,
      agentName: "default",
      agentType: "conversation",
      userId: uid
    };
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/report`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  }
  /**
   * Call a growth-domain endpoint and return its unwrapped `data`.
   *
   * These endpoints live on the chat host with the billing header set, and
   * carry the same envelope as everything else. Centralised here because every
   * growth call needs the identical envelope check. The path carries NO `/v2`
   * prefix: asking for the `/v2` form does not 404, it answers with a body that
   * has no streak object at all.
   */
  async growthJson(credential, method, path, body) {
    const response = await this.fetchImpl(`${chatBase(credential)}${path}`, {
      redirect: "error",
      method,
      headers: billingHeaders(credential),
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    return asRecord(envelope.data);
  }
  /**
   * The full streak picture: days, tier unlock state, and what each tier pays.
   *
   * Read before redeeming, because the tier state is the only honest answer to
   * "is there anything to claim": the redeem endpoint answers 403 for a locked
   * tier, which is indistinguishable from a real failure once the response is
   * just an error. The counter is nested as `data.streak.days`, not `data.days`.
   */
  async growthStreakFull(credential) {
    const data = await this.growthJson(credential, "GET", "/activity/growth/streak");
    const streak = asRecord(data["streak"]);
    const redemption = asRecord(data["redemption_status"]);
    const tiers = [];
    if (Array.isArray(redemption["tiers"])) {
      for (const entry of redemption["tiers"]) {
        const tier = asRecord(entry);
        const name = typeof tier["tier"] === "string" ? tier["tier"] : "";
        if (name === "") continue;
        tiers.push({
          tier: name,
          days: numberField(tier, "days"),
          credit: numberField(tier, "credit"),
          energy: numberField(tier, "energy"),
          // The flat status fields are the authoritative unlock state; the
          // per-tier entry does not carry one of its own.
          status: String(redemption[`tier_${name}_status`] ?? "").toLowerCase()
        });
      }
    }
    return {
      days: numberField(streak, "days"),
      nextTier: typeof streak["next_tier"] === "string" ? streak["next_tier"] : "",
      nextTierRemaining: numberField(streak, "next_tier_remaining"),
      makeupCards: numberField(asRecord(data["makeup_cards"]), "balance"),
      tiers
    };
  }
  /**
   * Redeem one unlocked streak tier.
   *
   * A locked tier answers 403 ("连续登录天数不足"); callers check the status from
   * {@link growthStreakFull} first, so this only throws for genuine failures.
   * The client token is the upstream's idempotency key — a fresh one per attempt
   * keeps a retry from being read as a duplicate of the last one.
   */
  async redeemStreakTier(credential, tier) {
    await this.growthJson(credential, "POST", "/activity/growth/redeem", {
      tier,
      client_token: (0, import_node_crypto.randomUUID)()
    });
  }
  /**
   * Call a billing-domain endpoint and return its unwrapped `data`.
   *
   * Counterpart of {@link growthJson}: same envelope, but these paths carry the
   * `/v2/billing/meter` prefix and the billing host. Kept separate because the
   * prefix is part of the path, not something the caller should remember.
   */
  async billingJson(credential, path, body) {
    const response = await this.fetchImpl(`${billingBase(credential)}${path}`, {
      redirect: "error",
      method: "POST",
      headers: billingHeaders(credential),
      body: body === void 0 ? "{}" : JSON.stringify(body),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    return asRecord(envelope.data);
  }
  /**
   * The one-off starter gift. Once per account; a second claim is a business
   * error, which the caller treats as "nothing to collect".
   *
   * No `/v2` prefix: that form answers a 404 route miss, while the bare path is
   * the one the console itself posts to.
   */
  async claimGift(credential) {
    return numberField(await this.billingJson(credential, "/billing/meter/claim-gift"), "credit");
  }
  /** Campaign compensation, when the account has any waiting. */
  async claimCompensation(credential) {
    return numberField(await this.billingJson(credential, "/billing/meter/claim-compensation"), "credit");
  }
  /**
   * Whether yesterday is still empty on the streak heatmap.
   *
   * A missed day breaks the run, and the run is what unlocks the 7/14/28-day
   * tiers, so this is read before deciding to spend a make-up card on it.
   */
  async missedYesterday(credential) {
    const data = await this.growthJson(credential, "GET", "/activity/growth/heatmap");
    const cells = Array.isArray(data["cells"]) ? data["cells"] : [];
    const yesterday = (0, import_checkin_time.zonedDay)(-1);
    for (const entry of cells) {
      const cell = asRecord(entry);
      const date = typeof cell["date"] === "string" ? cell["date"].slice(0, 10) : "";
      if (date === yesterday) return numberField(cell, "score") === 0;
    }
    return false;
  }
  /** Spend one make-up card on a past day (`YYYY-MM-DD`). */
  async useMakeupCard(credential, date) {
    await this.growthJson(credential, "POST", "/activity/growth/makeup-cards/use", { target_date: date });
  }
  /** Make-up cards in hand; the streak is only repairable while this is above zero. */
  async makeupCards(credential) {
    const data = await this.growthJson(credential, "GET", "/activity/growth/streak");
    return numberField(asRecord(data["makeup_cards"]), "balance");
  }
  /** Draws available from redeemed streak tiers. */
  async lotteryChances(credential) {
    const data = await this.growthJson(credential, "GET", "/activity/growth/lottery/summary");
    return numberField(data, "chances");
  }
  /** Spend one draw; the prize payload is passed through as-is. */
  async drawLottery(credential) {
    return await this.growthJson(credential, "POST", "/activity/growth/lottery/draw", {
      client_token: (0, import_node_crypto.randomUUID)()
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ERROR_BODY_TIMEOUT_MS,
  WorkBuddyUpstreamClient,
  classifyUpstreamError,
  headersDeadline,
  isBuddyThresholdIncomplete,
  isHardCreditText,
  parseRateLimitReset,
  readErrorBody,
  regionOf,
  retryAfterSeconds,
  tokenExpiryMs,
  upstreamErrorKind,
  withIdleWatchdog
});
