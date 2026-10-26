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
var shim_exports = {};
__export(shim_exports, {
  createWorkBuddyShim: () => createWorkBuddyShim,
  unavailableAnswer: () => unavailableAnswer
});
module.exports = __toCommonJS(shim_exports);
var import_node_crypto = require("node:crypto");
var import_accounts = require("./accounts");
var import_upstream = require("./upstream");
var import_trae_sse = require("./trae-sse");
var import_loopback = require("./loopback");
var import_log = require("./log");
function carriesFinishReason(data) {
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed.choices) && parsed.choices.some((choice) => typeof choice?.finish_reason === "string" && choice.finish_reason !== "");
  } catch {
    return false;
  }
}
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  waf_block: 502,
  not_found: 502,
  server: 502,
  client: 400,
  model_tier: 400,
  account_restricted: 403,
  transport: 502,
  aborted: 499
};
const MODEL_TIER_HOLD_MS = 24 * 60 * 60 * 1e3;
function classifyEnvelopeCode(code, text) {
  if (code === "6004") return "soft_rate";
  if (code === "11158") return "model_tier";
  if (code === "11140") return "account_restricted";
  if (code === "12153") return "session_dead";
  if ((0, import_upstream.isHardCreditText)(text)) return "hard_credit";
  return void 0;
}
function conversationKeyOf(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.messages)) return void 0;
    for (const entry of parsed.messages) {
      if (typeof entry !== "object" || entry === null) continue;
      const message = entry;
      if (message["role"] !== "user") continue;
      const content = typeof message["content"] === "string" ? message["content"] : JSON.stringify(message["content"] ?? "");
      return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex").slice(0, 32);
    }
  } catch {
    return void 0;
  }
  return void 0;
}
async function peekAnswerHead(reader) {
  const head = [];
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let ended = false;
  let jsonLooking = false;
  for (; ; ) {
    const next = await reader.read();
    if (next.done) {
      ended = true;
      break;
    }
    head.push(next.value);
    bytes += next.value.byteLength;
    text += decoder.decode(next.value, { stream: true });
    const trimmed2 = text.replace(/^\uFEFF/, "").trimStart();
    if (trimmed2 === "") {
      if (bytes >= import_loopback.PEEK_MAX_BYTES || head.length >= import_loopback.PEEK_MAX_CHUNKS) break;
      continue;
    }
    jsonLooking = trimmed2.startsWith("{") || trimmed2.startsWith("[");
    if (!jsonLooking) break;
    if (ended || bytes >= import_loopback.PEEK_MAX_BYTES / 8 || head.length >= import_loopback.PEEK_MAX_CHUNKS) break;
  }
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "" && ended) {
    return { head, ended, refusal: "workbuddy returned an empty answer stream" };
  }
  if (!jsonLooking) return { head, ended };
  try {
    const parsed = JSON.parse(trimmed);
    const code = parsed["code"] ?? parsed["errCode"] ?? parsed["errorCode"];
    const msg = parsed["msg"] ?? parsed["message"] ?? parsed["error"];
    const detail = typeof msg === "string" && msg.trim() !== "" ? msg.trim() : "";
    const named = code === void 0 || code === null || code === 0 || code === "0" ? "" : `code ${String(code)}`;
    const sentence = [named, detail].filter((part) => part !== "").join(" \xB7 ");
    return {
      head,
      ended,
      refusal: sentence === "" ? "workbuddy answered 200 with a JSON body where a stream was expected" : `workbuddy answered 200 with ${sentence}`,
      ...named === "" ? {} : { code: String(code) }
    };
  } catch {
    return { head, ended, refusal: `workbuddy answered 200 with a body that is neither a stream nor an envelope: ${(0, import_loopback.safeMessage)(trimmed.slice(0, 200))}` };
  }
}
function declaredEffortOf(catalog, modelId) {
  const model = rosterFor(catalog).find((entry) => entry.id === modelId);
  const effort = model?.defaultThinkingLevel;
  if (effort === void 0 || effort === "") return void 0;
  const supported = model?.supportedEfforts;
  if (supported !== void 0 && supported.length > 0 && !supported.includes(effort)) return void 0;
  return effort;
}
function rosterFor(catalog) {
  const visible = typeof catalog.visible === "function" ? catalog.visible() : [];
  if (visible.length > 0) return visible;
  return typeof catalog.current === "function" ? catalog.current() : [];
}
function withReasoningEffort(prepared, effort) {
  let body;
  try {
    body = JSON.parse(prepared);
  } catch {
    return void 0;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
  const request = body;
  const named = request["reasoning_effort"];
  if (typeof named === "string" && named !== "") return void 0;
  request["reasoning_effort"] = effort;
  return JSON.stringify(request);
}
const PARAMETER_REJECTION = /"code"\s*:\s*"?11133\b/;
function isContextTooLong(body) {
  if (body.includes("context_length_exceeded")) return true;
  if (body.includes("input length too long")) return true;
  if (body.includes('"code":11115')) return true;
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
  return false;
}
const holdUntil = () => Date.now() + import_accounts.POOL_HOLD_MS;
function resetFromRetryAfter(seconds) {
  if (seconds === void 0) return void 0;
  return Date.now() + seconds * 1e3;
}
function unavailableAnswer(pool, live, now, modelId) {
  const reasons = live.map((account) => pool.unavailableReason(account.id, now, modelId));
  const only = new Set(reasons).size === 1 ? reasons[0] : null;
  const limited = live.filter((_, index) => reasons[index] === "rate-limited");
  const retryAfterSeconds = limited.length === 0 ? void 0 : (0, import_loopback.boundedRetryAfterSeconds)(Math.ceil((Math.min(...limited.map((account) => Math.max(
    account.cooldownUntilMs,
    account.modelCooldowns[modelId] ?? 0
  ))) - now) / 1e3));
  if (only === "rate-limited") {
    return { status: 429, code: "soft_rate", detail: `every account is rate-limited for model ${modelId}`, retryAfterSeconds };
  }
  if (only === "plan") {
    return {
      status: 400,
      code: "model_tier",
      detail: `no WorkBuddy account has model ${modelId} in its plan; pick another model, or add an account whose plan includes it`
    };
  }
  if (only === "restricted by the upstream") {
    return {
      status: 403,
      code: "account_restricted",
      detail: "every WorkBuddy account was restricted by the upstream; appeal the restriction in the WorkBuddy console, or add another account"
    };
  }
  const detail = only === "sign-in expired" ? "every WorkBuddy sign-in for this gateway has expired; sign in again in the desktop app" : only === "sign-in refused" ? "every WorkBuddy sign-in was refused by the upstream; sign in again in the desktop app" : only === "on hold" ? `every WorkBuddy account is out of credits or otherwise on hold for model ${modelId}` : only === "under its credit reserve" ? "no account is available within its configured credit reserve" : `no WorkBuddy account is available for model ${modelId}`;
  return { status: 503, code: "accounts_unavailable", detail, retryAfterSeconds };
}
function createWorkBuddyShim(options) {
  const { pool, client, catalog } = options;
  const region = options.region;
  const logger = options.logger;
  const maxAttempts = 8;
  const server = (0, import_loopback.createLoopbackServer)({ port: options.port, label: "workbuddy shim", handle, logger });
  const ready = server.ready;
  async function handle(req, res) {
    if (!(0, import_loopback.guardsPass)(req, res)) return;
    const url = (0, import_loopback.requestPathname)(req.url);
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      (0, import_loopback.writeJson)(res, 200, { ok: true, pool: pool.status() });
      return;
    }
    if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
      const selected = catalog.visible();
      const directory = selected.length > 0 ? selected : catalog.current();
      const ids = options.listedIds?.();
      const served = ids === void 0 ? directory : (0, import_loopback.listedModels)(directory, ids);
      (0, import_loopback.writeJson)(res, 200, {
        object: "list",
        data: served.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "workbuddy"
        }))
      });
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
      await chatCompletions(req, res);
      return;
    }
    (0, import_loopback.writeOpenAIError)(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  }
  async function chatCompletions(req, res) {
    if (!(0, import_loopback.isJsonContentType)(req)) {
      (0, import_loopback.writeOpenAIError)(res, 415, "unsupported_media_type", "Content-Type must be application/json");
      return;
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const raw = (await (0, import_loopback.readRequestBody)(req)).toString("utf8");
    const prepared = client.prepareChatBody(raw);
    const conversationKey = conversationKeyOf(raw);
    let modelId;
    try {
      const parsed = JSON.parse(raw);
      modelId = typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
    } catch {
      modelId = void 0;
    }
    if (modelId === void 0) {
      (0, import_loopback.writeOpenAIError)(res, 400, "invalid_request_error", "model is required");
      return;
    }
    const tried = [];
    let last;
    let exhaustedByRateLimit = false;
    let effortFallback;
    let effortFallbackBuilt = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return;
      const account = await pool.acquire(modelId, region, conversationKey);
      if (account === void 0) {
        if (exhaustedByRateLimit && last !== void 0) {
          const model = ` for model ${modelId}`;
          const subject = last.kind === "waf_block" ? "every WorkBuddy account was blocked by the upstream gateway (WAF)" : last.kind === "hard_credit" ? `every WorkBuddy account is out of credits${model}` : last.kind === "session_dead" ? `every WorkBuddy sign-in is no longer accepted${model}` : last.kind === "model_tier" ? `no WorkBuddy account can use model ${modelId}` : last.kind === "account_restricted" ? "every WorkBuddy account was restricted by the upstream" : last.kind === "transport" ? `the upstream host could not be reached on any account${model}` : `every account is rate-limited${model}`;
          const advice = last.kind === "soft_rate" ? "resets at the upstream window" : last.kind === "model_tier" ? "pick another model, or add an account whose plan includes it" : last.kind === "account_restricted" ? "appeal the restriction in the WorkBuddy console, or add another account" : last.kind === "transport" ? "check the connection to the upstream host" : "sign in again in the desktop app";
          (0, import_loopback.writeOpenAIError)(
            res,
            KIND_STATUS[last.kind],
            last.kind,
            `${subject} (tried ${tried.length}: ${tried.join(", ")}); ${advice} \u2014 ${last.message.slice(0, 200)}`
          );
          return;
        }
        const regionAccounts = pool.list(region);
        const switchedOff = regionAccounts.filter((account2) => pool.isDisabled(account2.id));
        if (regionAccounts.length > 0 && switchedOff.length === regionAccounts.length) {
          (0, import_loopback.writeOpenAIError)(
            res,
            403,
            "accounts_switched_off",
            `every account for this gateway is switched off in the plugin panel (${switchedOff.map((account2) => account2.label).join(", ")}); switch one back on`
          );
          return;
        }
        if (regionAccounts.length > 0) {
          const now = Date.now();
          const live = regionAccounts.filter((account2) => !pool.isDisabled(account2.id));
          const answer = unavailableAnswer(pool, live, now, modelId);
          if (answer.retryAfterSeconds !== void 0) {
            res.setHeader("Retry-After", String(answer.retryAfterSeconds));
          }
          (0, import_loopback.writeOpenAIError)(res, answer.status, answer.code, answer.detail);
          return;
        }
        (0, import_loopback.writeOpenAIError)(
          res,
          401,
          "not_signed_in",
          "no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)"
        );
        return;
      }
      tried.push(account.label);
      let result = await client.chatStream(account.credential, prepared, controller.signal);
      if (!result.ok && result.kind === "session_dead" && await pool.refreshAccount(account.id)) {
        if (controller.signal.aborted) return;
        result = await client.chatStream(account.credential, prepared, controller.signal);
      }
      if (!result.ok && result.kind === "client" && PARAMETER_REJECTION.test(result.message) && !controller.signal.aborted) {
        if (!effortFallbackBuilt) {
          effortFallbackBuilt = true;
          const effort = declaredEffortOf(catalog, modelId);
          effortFallback = effort === void 0 ? void 0 : withReasoningEffort(prepared, effort);
        }
        if (effortFallback !== void 0) {
          logger?.info?.(`${import_log.LOG_PREFIX}: ${modelId} refused a request that named no effort; retrying with the model's declared default`);
          result = await client.chatStream(account.credential, effortFallback, controller.signal);
        }
      }
      if (result.ok) {
        let closeWithoutDone = function() {
          if (sawDone || !res.writable) return;
          logger?.warn?.(import_log.LOG_PREFIX + ": upstream stream ended without [DONE]");
          if (!sawFinish) {
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}

`);
          }
          res.end("data: [DONE]\n\n");
        };
        const reader = (0, import_loopback.relayStreamOf)(result.response).getReader();
        let sawDone = false;
        let sawFinish = false;
        let envelopeFailure;
        const decoder = new TextDecoder();
        const sse = new import_trae_sse.SseDecoder();
        const startStream = () => {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
          });
          res.flushHeaders();
        };
        const failInBand = (error) => {
          if (controller.signal.aborted || !res.writable) return;
          logger?.warn?.(import_log.LOG_PREFIX + ": upstream stream failed mid-flight", (0, import_loopback.safeMessage)(error));
          try {
            res.write(`data: ${JSON.stringify({
              error: { message: (0, import_loopback.safeMessage)(error), type: "upstream_error" }
            })}

`);
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}

`);
            res.end("data: [DONE]\n\n");
          } catch {
          }
        };
        const relayLoop = (async () => {
          let head = [];
          let ended = false;
          try {
            const peeked = await peekAnswerHead(reader);
            head = peeked.head;
            ended = peeked.ended;
            if (peeked.refusal !== void 0) {
              await reader.cancel().catch(() => {
              });
              logger?.warn?.(`${import_log.LOG_PREFIX}: ${account.label} answered 200 with no stream: ${peeked.refusal}`);
              const envelopeKind = classifyEnvelopeCode(peeked.code, peeked.refusal);
              if (envelopeKind === "soft_rate" || envelopeKind === "hard_credit" || envelopeKind === "session_dead" || envelopeKind === "account_restricted" || envelopeKind === "model_tier") {
                last = { kind: envelopeKind, status: 200, message: peeked.refusal };
                exhaustedByRateLimit = true;
                envelopeFailure = envelopeKind;
                if (envelopeKind === "soft_rate") {
                  pool.penalize(account.id, void 0, modelId);
                } else if (envelopeKind === "model_tier") {
                  pool.blockModel(account.id, modelId, Date.now() + MODEL_TIER_HOLD_MS);
                } else if (envelopeKind === "session_dead" && await pool.refreshAccount(account.id)) {
                } else {
                  pool.penalize(
                    account.id,
                    holdUntil(),
                    void 0,
                    envelopeKind === "hard_credit" ? "spent" : envelopeKind === "session_dead" ? "session" : "restricted"
                  );
                }
                return;
              }
              (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", peeked.refusal);
              return;
            }
          } catch (error) {
            startStream();
            failInBand(error);
            return;
          }
          logger?.info?.(`${import_log.LOG_PREFIX}: served by ${account.label}`);
          startStream();
          let headIndex = 0;
          try {
            for (; ; ) {
              const replayed = headIndex < head.length ? head[headIndex++] : void 0;
              const { done, value } = replayed !== void 0 ? { done: false, value: replayed } : ended ? { done: true, value: void 0 } : await reader.read();
              if (done || value === void 0) break;
              if (!res.writable) return;
              await (0, import_loopback.writeChunk)(res, value);
              try {
                const decoded = decoder.decode(value, { stream: true });
                const events = sse.push(decoded);
                if (!sawFinish && events.some((event) => carriesFinishReason(event.data))) sawFinish = true;
                if (events.some((event) => event.data === "[DONE]")) {
                  if (!sawFinish && res.writable) {
                    res.write(`data: ${JSON.stringify({
                      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                    })}

`);
                    sawFinish = true;
                  }
                  sawDone = true;
                  if (res.writable) res.end();
                  await reader.cancel().catch(() => {
                  });
                  return;
                }
              } catch {
              }
            }
            if (!sawDone) {
              try {
                const rest = decoder.decode();
                const events = rest === "" ? sse.finish() : [...sse.push(rest), ...sse.finish()];
                if (events.some((event) => event.data === "[DONE]")) sawDone = true;
                if (events.some((event) => carriesFinishReason(event.data))) sawFinish = true;
              } catch {
              }
            }
            closeWithoutDone();
          } catch (error) {
            failInBand(error);
          } finally {
            try {
              reader.releaseLock();
            } catch {
            }
          }
        })();
        await relayLoop;
        if (envelopeFailure === void 0) return;
        continue;
      }
      last = { kind: result.kind, status: result.status, message: result.message };
      if (result.kind === "aborted") break;
      if (result.kind === "transport") {
        last = { kind: result.kind, status: result.status, message: result.message };
        exhaustedByRateLimit = true;
        break;
      }
      if (result.kind !== "soft_rate" && result.kind !== "waf_block" && result.kind !== "hard_credit" && result.kind !== "session_dead" && result.kind !== "model_tier" && result.kind !== "account_restricted") break;
      exhaustedByRateLimit = true;
      if (result.kind === "soft_rate") {
        const bodyReset = (0, import_upstream.parseRateLimitReset)(result.message);
        const resetAtMs = bodyReset !== void 0 && bodyReset > Date.now() ? bodyReset : resetFromRetryAfter(result.retryAfter);
        pool.penalize(account.id, resetAtMs, modelId);
      } else if (result.kind === "model_tier") {
        pool.blockModel(account.id, modelId, Date.now() + MODEL_TIER_HOLD_MS);
      } else if (result.kind === "account_restricted") {
        pool.penalize(account.id, holdUntil(), void 0, "restricted");
      } else if (result.kind === "hard_credit" || result.kind === "session_dead") {
        pool.penalize(
          account.id,
          holdUntil(),
          void 0,
          result.kind === "hard_credit" ? "spent" : "session"
        );
      } else {
        pool.penalize(account.id);
      }
      logger?.warn(
        `${import_log.LOG_PREFIX}: ${account.label} ${result.kind} on ${modelId} (attempt ${attempt + 1}/${maxAttempts}); rotating`
      );
    }
    if (last === void 0) {
      (0, import_loopback.writeOpenAIError)(res, 500, "internal", "chat request exhausted without a result");
      return;
    }
    if (isContextTooLong(last.message)) {
      const subject = `the conversation exceeds ${modelId}'s context window`;
      (0, import_loopback.writeOpenAIError)(
        res,
        400,
        "context_length_exceeded",
        `${subject}. Shorten the conversation, start a new chat, or pick a model with a larger window (e.g. hy4-preview).`
      );
      return;
    }
    const unapproved = (0, import_loopback.unapprovedChannelRefusal)(last.message);
    if (unapproved !== void 0) {
      (0, import_loopback.writeOpenAIError)(res, 400, "upstream_channel_check", unapproved);
      return;
    }
    (0, import_loopback.writeOpenAIError)(
      res,
      KIND_STATUS[last.kind],
      last.kind,
      `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(" \u2192 ")}]: ${last.message.slice(0, 400)}`
    );
  }
  return {
    ready,
    port: server.port,
    baseUrl: server.baseUrl,
    close: server.close
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createWorkBuddyShim,
  unavailableAnswer
});
