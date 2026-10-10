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
  createWorkBuddyShim: () => createWorkBuddyShim
});
module.exports = __toCommonJS(shim_exports);
var import_node_crypto = require("node:crypto");
var import_node_http = require("node:http");
var import_node_stream = require("node:stream");
var import_upstream = require("./upstream");
var import_loopback = require("./loopback");
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  waf_block: 502,
  not_found: 502,
  server: 502,
  client: 400
};
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
function isContextTooLong(body) {
  if (body.includes("context_length_exceeded")) return true;
  if (body.includes("input length too long")) return true;
  if (body.includes('"code":11115')) return true;
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
  return false;
}
function createWorkBuddyShim(options) {
  const { pool, client, catalog } = options;
  const region = options.region;
  const logger = options.logger;
  const maxAttempts = options.maxAttempts ?? 8;
  const server = (0, import_node_http.createServer)((req, res) => {
    void (0, import_loopback.answerRequest)(res, () => handle(req, res), logger);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  server.on("error", (error) => {
    logger?.warn?.("pi-desktop-xdpool: workbuddy shim server error", error);
  });
  const port = () => {
    const address = server.address();
    return address === null || typeof address === "string" ? 0 : address.port;
  };
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("workbuddy shim has no listening address");
    }
    return `http://127.0.0.1:${address.port}`;
  };
  async function handle(req, res) {
    if (!(0, import_loopback.hostIsLoopback)(req.headers.host)) {
      (0, import_loopback.writeOpenAIError)(res, 403, "host_not_allowed", "Host header must name the loopback interface");
      return;
    }
    if (!(0, import_loopback.originIsLoopback)(req.headers.origin)) {
      (0, import_loopback.writeOpenAIError)(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
      return;
    }
    if (!(0, import_loopback.bearerAccepted)(req)) {
      (0, import_loopback.writeOpenAIError)(res, 401, "unauthorized", "missing or invalid Authorization bearer");
      return;
    }
    const url = req.url ?? "/";
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
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return;
      const account = await pool.acquire(modelId, region, conversationKey);
      if (account === void 0) {
        if (exhaustedByRateLimit && last !== void 0) {
          const model = modelId === void 0 ? "" : ` for model ${modelId}`;
          const subject = last.kind === "waf_block" ? "every WorkBuddy account was blocked by the upstream gateway (WAF)" : last.kind === "hard_credit" ? `every WorkBuddy account is out of credits${model}` : last.kind === "session_dead" ? `every WorkBuddy sign-in is no longer accepted${model}` : `every account is rate-limited${model}`;
          const advice = last.kind === "soft_rate" ? "resets at the upstream window" : "sign in again in the desktop app";
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
          const resets = regionAccounts.filter((account2) => !pool.isDisabled(account2.id)).map((account2) => Math.max(account2.cooldownUntilMs, account2.modelCooldowns[modelId] ?? 0));
          if (resets.every((until) => until > now)) {
            res.setHeader("Retry-After", String(Math.max(1, Math.ceil((Math.min(...resets) - now) / 1e3))));
            (0, import_loopback.writeOpenAIError)(res, 429, "soft_rate", `every account is rate-limited for model ${modelId}`);
          } else {
            (0, import_loopback.writeOpenAIError)(res, 503, "accounts_unavailable", "no account is available within its configured credit reserve");
          }
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
        result = await client.chatStream(account.credential, prepared, controller.signal);
      }
      if (result.ok) {
        let closeWithoutDone = function() {
          if (sawDone || !res.writable) return;
          logger?.warn?.("pi-desktop-xdpool: upstream stream ended without [DONE]");
          res.end("data: [DONE]\n\n");
        };
        if (result.response.body === null) {
          (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", "workbuddy returned no stream");
          return;
        }
        logger?.info?.(`pi-desktop-xdpool: served by ${account.label}`);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        let sawDone = false;
        const body = import_node_stream.Readable.fromWeb(result.response.body);
        body.on("data", (chunk) => {
          if (chunk.includes("[DONE]")) sawDone = true;
        });
        body.on("error", (error) => {
          logger?.warn("pi-desktop-xdpool: upstream stream failed mid-flight", error);
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
        body.on("end", () => {
          closeWithoutDone();
        });
        body.pipe(res);
        return;
      }
      last = { kind: result.kind, status: result.status, message: result.message };
      if (result.kind !== "soft_rate" && result.kind !== "waf_block" && result.kind !== "hard_credit" && result.kind !== "session_dead") break;
      exhaustedByRateLimit = true;
      if (result.kind === "soft_rate") {
        pool.penalize(account.id, (0, import_upstream.parseRateLimitReset)(result.message), modelId);
      } else {
        pool.penalize(account.id);
      }
      logger?.warn(
        `pi-desktop-xdpool: ${account.label} ${result.kind} on ${modelId} (attempt ${attempt + 1}/${maxAttempts}); rotating`
      );
    }
    if (last === void 0) {
      (0, import_loopback.writeOpenAIError)(res, 500, "internal", "chat request exhausted without a result");
      return;
    }
    if (isContextTooLong(last.message)) {
      const subject = modelId === void 0 ? "the conversation exceeds this model's context window" : `the conversation exceeds ${modelId}'s context window`;
      (0, import_loopback.writeOpenAIError)(
        res,
        400,
        "context_length_exceeded",
        `${subject}. Shorten the conversation, start a new chat, or pick a model with a larger window (e.g. hy4-preview).`
      );
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
    port,
    baseUrl,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createWorkBuddyShim
});
