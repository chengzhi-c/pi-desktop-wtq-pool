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
  WorkBuddyUpstreamClient: () => WorkBuddyUpstreamClient,
  classifyUpstreamError: () => classifyUpstreamError,
  isBuddyThresholdIncomplete: () => isBuddyThresholdIncomplete,
  parseCreditMultiplier: () => parseCreditMultiplier,
  parseRateLimitReset: () => parseRateLimitReset,
  parseReasoning: () => parseReasoning,
  parseUpstreamModel: () => parseUpstreamModel,
  regionOf: () => regionOf
});
module.exports = __toCommonJS(upstream_exports);
var import_loopback = require("./loopback");
function isBuddyThresholdIncomplete(message) {
  return typeof message === "string" && message.toLowerCase().includes("first_buddy task not completed yet");
}
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA = "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1";
const DESKTOP_UA = "WorkBuddy/5.5.2";
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
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
const SESSION_DEAD_PATTERN = /Offline user session not found|"code"\s*:\s*"?12153\b/u;
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
    "X-CodeBuddy-Request": "1"
  };
}
function chatHeaders(credential) {
  return {
    ...commonHeaders(credential),
    "Content-Type": "application/json",
    "Authorization": `Bearer ${credential.accessToken}`,
    ...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
    ...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
    ...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
    "X-Product": "SaaS"
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
    "X-CodeBuddy-Request": "1"
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
async function readEnvelope(response) {
  const text = await response.text();
  if (isGatewayHtmlRejection(response.status, text)) {
    throw new Error(
      `the WorkBuddy gateway rejected this credential (http ${response.status}). This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run \`pi-desktop-xdpool doctor\` to list every credential found.`
    );
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
  const kind = classifyUpstreamError(status, envelope.msg);
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${(0, import_loopback.redactSecrets)(envelope.msg).slice(0, 160)}`);
}
function classifyUpstreamError(status, body) {
  if (status === 402) return "hard_credit";
  const aboutSignIn = status === 401 || status === 403;
  if (aboutSignIn && SESSION_DEAD_PATTERN.test(body)) return "session_dead";
  if (!aboutSignIn) {
    const lower = body.toLowerCase();
    for (const marker of HARD_CREDIT_MARKERS) {
      if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
    }
    if (SESSION_DEAD_PATTERN.test(body)) return "session_dead";
  }
  if (status === 429) return "soft_rate";
  if (body.includes("soft_rate") || body.includes('"code":6004') || body.includes("\u9891\u7387\u9650\u5236")) {
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
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
  if (epochMs !== null) return capRateReset(Number(epochMs[1]));
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
  return typeof record[key] === "number" ? record[key] : 0;
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
class WorkBuddyUpstreamClient {
  fetchImpl;
  clientVersion;
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.clientVersion = options.clientVersion ?? "2.0.4";
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
      } else {
        delete obj["tool_choice"];
      }
    }
    return JSON.stringify(obj);
  }
  /** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(credential, prepared, signal) {
    let response;
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        method: "POST",
        headers: chatHeaders(credential),
        body: prepared,
        ...signal === void 0 ? {} : { signal }
      });
    } catch (error) {
      return { ok: false, kind: "server", status: 0, message: `transport error: ${String(error)}` };
    }
    if (response.ok) return { ok: true, response };
    const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      message: text
    };
  }
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
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
      "Connection": "close",
      "User-Agent": DESKTOP_UA
    } : {
      "Authorization": `Bearer ${credential.accessToken}`,
      "Accept": "application/json",
      "Origin": billingBase(credential),
      "Referer": `${billingBase(credential)}/`,
      "User-Agent": CLIENT_UA
    };
    if (!global && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
      headers["X-Enterprise-Id"] = credential.enterpriseId;
    }
    const response = await this.fetchImpl(url, {
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
      if (typeof raw === "number" && raw > 1e12) return raw;
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
   */
  async reportChatActivity(credential, conversationId) {
    const uid = credential.uid ?? credential.uin ?? "";
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
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WorkBuddyUpstreamClient,
  classifyUpstreamError,
  isBuddyThresholdIncomplete,
  parseCreditMultiplier,
  parseRateLimitReset,
  parseReasoning,
  parseUpstreamModel,
  regionOf
});
