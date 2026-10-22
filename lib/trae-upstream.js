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
var trae_upstream_exports = {};
__export(trae_upstream_exports, {
  TRAE_CHECKIN_CLAIM_PATH: () => TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_DEVICE_CLAIMED: () => TRAE_CHECKIN_DEVICE_CLAIMED,
  TRAE_CHECKIN_STATUS_PATH: () => TRAE_CHECKIN_STATUS_PATH,
  TRAE_PAY_STATUS_PATH: () => TRAE_PAY_STATUS_PATH,
  TRAE_USAGE_PATH: () => TRAE_USAGE_PATH,
  TraeSoloUpstreamClient: () => TraeSoloUpstreamClient,
  classifyTraeUpstreamError: () => classifyTraeUpstreamError,
  collectTraeSoloModels: () => collectTraeSoloModels,
  mergeTraeDirectory: () => mergeTraeDirectory,
  prepareSoloBody: () => prepareSoloBody,
  traeVariantFor: () => traeVariantFor
});
module.exports = __toCommonJS(trae_upstream_exports);
var import_node_crypto = require("node:crypto");
var import_trae_discovery = require("./trae-discovery");
var import_upstream = require("./upstream");
const REGION_GATEWAYS = {
  cn: {
    chat: "https://trae-api-cn.mchost.guru",
    remote: "https://solo.trae.cn/api/remote/v1",
    pay: "https://api.trae.cn"
  },
  ai: {
    chat: "https://coresg-normal.trae.ai",
    remote: "https://coresg-normal.trae.ai/api/remote/v1",
    pay: "https://growsg-normal.trae.ai"
  }
};
const TRAE_SOLO_FUNCTION = "solo_work_lite";
const TRAE_DIRECTORY_FUNCTIONS = {
  cn: ["solo_work_remote", TRAE_SOLO_FUNCTION, "solo_agent_remote", "chat_v3", "solo_coder"],
  ai: ["solo_work_remote", TRAE_SOLO_FUNCTION, "solo_agent_remote", "chat_v3"]
};
const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
const TRAE_MAX_CONTEXT_WINDOW = 1e6;
const TRAE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const TRAE_WIRE_EFFORTS = {
  minimal: "high",
  low: "light",
  medium: "high",
  high: "high",
  xhigh: "extra_high"
};
function traeWireEffort(requested, capability) {
  if (capability === void 0) return requested;
  const level = TRAE_REASONING_EFFORTS.find((entry) => entry === requested);
  if (level === void 0 || !capability.supported.includes(level)) return void 0;
  return TRAE_WIRE_EFFORTS[level];
}
const TRAE_HOST_FROM_WIRE = {
  light: "low",
  high: "high",
  extra_high: "xhigh"
};
function asTraeEffort(value) {
  if (typeof value !== "string") return void 0;
  if (TRAE_REASONING_EFFORTS.includes(value)) return value;
  return TRAE_HOST_FROM_WIRE[value];
}
function parseTraeReasoningCapability(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const record = value;
  const config = typeof record["reasoning_effort_config"] === "object" && record["reasoning_effort_config"] !== null && !Array.isArray(record["reasoning_effort_config"]) ? record["reasoning_effort_config"] : void 0;
  const rawOptions = [
    ...Array.isArray(record["reasoning_effort_options"]) ? record["reasoning_effort_options"] : [],
    ...Array.isArray(config?.["options"]) ? config["options"] : []
  ];
  const supported = [];
  for (const item of rawOptions) {
    const effort = asTraeEffort(item);
    if (effort !== void 0 && !supported.includes(effort)) supported.push(effort);
  }
  const defaultEffort = asTraeEffort(record["default_reasoning_effort"] ?? config?.["default_level"]);
  const resolvedDefault = defaultEffort !== void 0 && supported.includes(defaultEffort) ? defaultEffort : void 0;
  if (supported.length === 0) return void 0;
  return { supported, ...resolvedDefault === void 0 ? {} : { defaultEffort: resolvedDefault } };
}
function collectTraeRemoteReasoning(groups) {
  const byId = /* @__PURE__ */ new Map();
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const models = group["models"];
    if (!Array.isArray(models)) continue;
    for (const raw of models) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw;
      const id = typeof record["name"] === "string" ? record["name"] : "";
      if (id === "" || byId.has(id)) continue;
      const reasoning = parseTraeReasoningCapability(record);
      if (reasoning !== void 0) byId.set(id, reasoning);
    }
  }
  return byId;
}
const TRAE_VERSION_CODE_FALLBACK = "20260716";
function normalizeTraeVersionCode(buildVersion) {
  if (buildVersion === void 0 || buildVersion.trim() === "") return TRAE_VERSION_CODE_FALLBACK;
  const trimmed = buildVersion.trim();
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}
function traeEndpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
function traeIdentityHeaders(identity) {
  return {
    "x-machine-id": identity.machineId,
    "x-device-id": identity.deviceId,
    "x-device-type": identity.platform === "darwin" ? "mac" : identity.platform === "win32" ? "windows" : identity.platform,
    ...identity.deviceBrand === void 0 ? {} : { "x-device-brand": identity.deviceBrand },
    ...identity.deviceCpu === void 0 ? {} : { "x-device-cpu": identity.deviceCpu },
    ...identity.osVersion === void 0 ? {} : { "x-os-version": identity.osVersion },
    ...identity.appVersion === void 0 ? {} : { "x-app-version": identity.appVersion, "x-ide-version": identity.appVersion },
    ...identity.buildVersion === void 0 ? {} : { "x-app-version-code": identity.buildVersion, "x-ide-version-code": identity.buildVersion },
    "x-ide-version-type": "stable"
  };
}
function buildTraeHeaders(credential, identity, options = {}) {
  const requestId = options.requestId ?? (0, import_node_crypto.randomUUID)();
  const traceId = requestId.replaceAll("-", "").slice(0, 32);
  return {
    "Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
    "X-Ide-Token": credential.accessToken,
    "x-plugin-channel": "icube-ai",
    "User-Agent": `Trae/${identity.appVersion ?? identity.buildVersion ?? "unknown"}`,
    "x-app-id": options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ...traeIdentityHeaders(identity),
    // The upstream binds these as numbers; a dotted build string is rejected.
    "x-app-version-code": normalizeTraeVersionCode(identity.buildVersion),
    "x-ide-version-code": normalizeTraeVersionCode(identity.buildVersion),
    "x-custom-trace-id": traceId,
    "x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
    "request-traffic-type": "prod",
    "Content-Type": "application/json",
    "X-Cloudide-Token": credential.accessToken,
    "x-uid": credential.userId,
    "x-request-id": requestId,
    "x-trae-request-id": requestId,
    "Accept": "text/event-stream"
  };
}
function prepareSoloBody(source, defaultModel = "glm-5.2", functionName, capability, maxMode = false) {
  const input = JSON.parse(source);
  const model = typeof input["model"] === "string" && input["model"].trim() !== "" ? input["model"].trim() : defaultModel;
  const wireEffort = typeof input["reasoning_effort"] === "string" ? traeWireEffort(input["reasoning_effort"], capability) : void 0;
  const body = {
    ...Array.isArray(input["messages"]) ? { messages: input["messages"] } : {},
    model,
    config_name: model,
    function: functionName ?? TRAE_SOLO_FUNCTION,
    stream: true,
    ...Array.isArray(input["tools"]) ? { tools: input["tools"] } : {},
    ...wireEffort === void 0 ? {} : { reasoning_effort: wireEffort },
    // Max mode is a separate window the upstream only serves when the request
    // asks for it (`v2_max_mode_enabled`, the flag Trae's own client sends when
    // the Max switch is on). Declaring the larger window without sending it
    // would size the host's budget for room the gateway then refuses.
    ...maxMode ? { extra_info: { v2_max_mode_enabled: true } } : {}
  };
  if (Array.isArray(body["messages"])) {
    for (const raw of body["messages"]) {
      if (typeof raw !== "object" || raw === null) continue;
      const message = raw;
      if (message["role"] === "developer") message["role"] = "system";
      if (typeof message["content"] === "string") message["content"] = [{ type: "text", text: message["content"] }];
      if (message["role"] === "assistant" && Array.isArray(message["tool_calls"])) {
        for (const rawCall of message["tool_calls"]) {
          if (typeof rawCall !== "object" || rawCall === null) continue;
          const call = rawCall;
          if (typeof call["function"] === "object" && call["function"] !== null) {
            call["function_call"] = call["function"];
            delete call["function"];
          }
        }
      }
      if (message["role"] === "tool") {
        if (typeof message["tool_call_id"] !== "string" || message["tool_call_id"] === "") {
          throw new Error("Trae SOLO tool message requires tool_call_id");
        }
      }
    }
  }
  if (Array.isArray(body["tools"])) {
    for (const raw of body["tools"]) {
      if (typeof raw !== "object" || raw === null) continue;
      const fn = raw["function"];
      if (typeof fn !== "object" || fn === null) continue;
      const record = fn;
      if (typeof record["parameters"] === "object" && record["parameters"] !== null) record["parameters"] = JSON.stringify(record["parameters"]);
    }
  }
  return JSON.stringify(body);
}
function classifyTraeUpstreamError(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "hard_credit";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}
function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function wireCreditMultiplier(config) {
  const raw = config["display_contact_config"];
  if (typeof raw !== "string" || raw === "") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const consumption = parsed["consumption_rate"];
  if (typeof consumption !== "object" || consumption === null) return void 0;
  const entry = consumption;
  if (entry["enable"] !== true) return void 0;
  const data = entry["data"];
  if (typeof data !== "object" || data === null) return void 0;
  return finitePositive(data["rate"]);
}
function variantReach(variant) {
  return Math.max(variant.contextWindow ?? 0, variant.maxContextWindow ?? 0);
}
function traeVariantFor(model, window) {
  const variants = model.variants ?? [];
  if (variants.length === 0) return void 0;
  const wanted = window !== void 0 && window > 0 ? window : model.contextWindow ?? 0;
  const own = variants.filter((variant) => (variant.contextWindow ?? 0) >= wanted);
  const reaching = own.length > 0 ? own : variants.filter((variant) => variantReach(variant) >= wanted);
  const exhausted = reaching.length === 0;
  const pool = exhausted ? variants : reaching;
  let best;
  for (const variant of pool) {
    if (best === void 0) {
      best = variant;
      continue;
    }
    const out = variant.maxTokens ?? 0;
    const bestOut = best.maxTokens ?? 0;
    if (exhausted) {
      const tier = variant.contextWindow ?? 0;
      const bestTier = best.contextWindow ?? 0;
      if (tier > bestTier) best = variant;
      else if (tier === bestTier && out > bestOut) best = variant;
      continue;
    }
    if (out > bestOut) best = variant;
    else if (out === bestOut && variantReach(variant) < variantReach(best)) best = variant;
  }
  return best;
}
function figuresFrom(variants) {
  const windows = variants.map((v) => v.contextWindow ?? 0);
  const defaultWindow = Math.max(0, ...windows);
  const declaredCeiling = Math.max(0, ...variants.map(variantReach));
  const ceiling = defaultWindow <= 0 ? declaredCeiling : declaredCeiling > defaultWindow ? declaredCeiling : TRAE_MAX_CONTEXT_WINDOW;
  const serving = traeVariantFor({ id: "", name: "", variants }, defaultWindow);
  return {
    contextWindow: defaultWindow > 0 ? defaultWindow : void 0,
    maxContextWindow: ceiling > defaultWindow ? ceiling : void 0,
    maxTokens: serving?.maxTokens,
    function: serving?.function
  };
}
function collectTraeSoloModels(list, directoryFunction, byId) {
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const config = raw;
    const id = typeof config["config_name"] === "string" ? config["config_name"] : "";
    if (id === "") continue;
    const display = typeof config["display_config"] === "object" && config["display_config"] !== null ? config["display_config"] : {};
    const details = Array.isArray(config["model_detail_list"]) ? config["model_detail_list"] : [];
    const detail = typeof details[0] === "object" && details[0] !== null ? details[0] : {};
    const contextTokens = typeof config["context_window_tokens"] === "object" && config["context_window_tokens"] !== null ? config["context_window_tokens"] : {};
    const contextWindow = finitePositive(contextTokens["dev"]) ?? finitePositive(detail["prompt_max_tokens"]);
    const maxContextWindow = finitePositive(contextTokens["max"]);
    const maxTokens = finitePositive(detail["max_tokens"]);
    const reasoning = parseTraeReasoningCapability({ ...config, ...detail });
    const creditMultiplier = wireCreditMultiplier(config);
    const multimodal = display["multimodal"];
    const variant = {
      function: directoryFunction,
      ...contextWindow === void 0 ? {} : { contextWindow },
      ...maxContextWindow === void 0 ? {} : { maxContextWindow },
      ...maxTokens === void 0 ? {} : { maxTokens }
    };
    const existing = byId.get(id);
    const variants = [...existing?.variants ?? []];
    const known = variants.findIndex((entry) => entry.function === directoryFunction);
    const previous = known === -1 ? void 0 : variants[known];
    if (previous === void 0) variants.push(variant);
    else if (variantReach(variant) > variantReach(previous) || (variant.maxTokens ?? 0) > (previous.maxTokens ?? 0)) {
      variants[known] = variant;
    }
    if (existing !== void 0) {
      byId.set(id, { ...existing, ...figuresFrom(variants), variants });
      continue;
    }
    byId.set(id, {
      id,
      name: typeof display["display_name"] === "string" && display["display_name"] !== "" ? display["display_name"] : id,
      ...reasoning === void 0 ? {} : { reasoning },
      ...creditMultiplier === void 0 ? {} : { creditMultiplier },
      ...typeof multimodal === "boolean" ? { supportsImages: multimodal } : {},
      ...figuresFrom(variants),
      variants
    });
  }
}
function mergeTraeDirectory(previous, next) {
  const merged = new Map(next.map((model) => [model.id, model]));
  for (const model of next) {
    const before = previous.find((entry) => entry.id === model.id);
    if (before === void 0) continue;
    const variants = [...model.variants ?? []];
    for (const variant of before.variants ?? []) {
      if (!variants.some((entry) => entry.function === variant.function)) variants.push(variant);
    }
    if (variants.length === (model.variants ?? []).length) continue;
    merged.set(model.id, { ...model, ...figuresFrom(variants), variants });
  }
  for (const model of previous) {
    if (!merged.has(model.id)) merged.set(model.id, model);
  }
  return [...merged.values()];
}
const TRAE_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const TRAE_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
const TRAE_HEADERS_TIMEOUT_MS = 6e4;
function traeCheckinHeaders(credential, identity, region = "cn") {
  return {
    "Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
    "X-User-Region": region,
    "x-device-id": identity.deviceId,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}
const TRAE_PAY_STATUS_PATH = "/trae/api/v1/pay/ide_user_pay_status";
const TRAE_CHECKIN_DEVICE_CLAIMED = 9095;
function traePayStatusOf(payload) {
  const record = payload !== null && typeof payload === "object" ? payload : {};
  const identity = typeof record["user_pay_identity"] === "number" && Number.isFinite(record["user_pay_identity"]) ? record["user_pay_identity"] : -1;
  const named = typeof record["user_pay_identity_str"] === "string" ? record["user_pay_identity_str"].trim() : "";
  const trial = record["trial_status"] !== null && typeof record["trial_status"] === "object" ? record["trial_status"] : {};
  return {
    plan: named !== "" ? named : identity === 0 ? "Free" : identity > 0 ? `Plan ${identity}` : "",
    inTrial: trial["is_in_trial"] === true
  };
}
const TRAE_USAGE_PATH = "/trae/api/v2/pay/web_user_ent_usage";
function traeCreditLimitOf(record) {
  const base = record["entitlement_base_info"];
  if (base === null || typeof base !== "object" || Array.isArray(base)) return void 0;
  const info = base;
  const quota = info["quota"];
  const limit = quota !== null && typeof quota === "object" && !Array.isArray(quota) ? traeNumber(quota["credits_limit"], NaN) : NaN;
  return Number.isFinite(limit) && limit > 0 ? limit : void 0;
}
function traePackNameOf(pack, base) {
  const group = typeof pack["group_name"] === "string" ? pack["group_name"].trim() : "";
  if (group !== "") return group;
  const extra = base["product_extra"];
  const named = extra !== null && typeof extra === "object" && !Array.isArray(extra) ? extra["package_extra"] : void 0;
  const packageName = named !== null && typeof named === "object" && !Array.isArray(named) ? named["package_name"] : void 0;
  if (typeof packageName === "string" && packageName.trim() !== "") return packageName.trim();
  const described = typeof pack["display_desc"] === "string" ? pack["display_desc"].trim() : "";
  return described === "" ? "credits" : described;
}
function traeCreditPacksOf(payload) {
  const envelope = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const list = envelope["user_entitlement_pack_list"];
  if (!Array.isArray(list)) return [];
  const packs = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const pack = entry;
    if (pack["is_hide"] === true) continue;
    const total = traeCreditLimitOf(pack);
    if (total === void 0) continue;
    const usage = pack["usage"];
    const consumed = usage !== null && typeof usage === "object" && !Array.isArray(usage) ? traeNumber(usage["credits_amount"], 0) : 0;
    const remaining = Math.max(0, total - consumed);
    if (remaining <= 0) continue;
    const base = pack["entitlement_base_info"];
    const expiresAt = traeNumber(pack["expire_time"], 0);
    packs.push({
      name: traePackNameOf(pack, base),
      remaining,
      total,
      ...expiresAt > 0 ? { expiresAtMs: expiresAt * 1e3 } : {}
    });
  }
  return packs;
}
function traeUsageSummaryOf(payload) {
  const envelope = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const summary = envelope["usage_summary"];
  const record = summary !== null && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
  const total = traeNumber(record["total_amount"], NaN);
  const consumed = traeNumber(record["consumed_amount"], NaN);
  if (!Number.isFinite(total) || !Number.isFinite(consumed)) {
    throw new Error("Trae usage answer has no usable totals");
  }
  return {
    remainingAmount: Math.max(0, total - consumed),
    packs: traeCreditPacksOf(payload)
  };
}
function traeNumber(value, fallback) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function traeFlag(value) {
  return value === true || value === "true";
}
function traeEnabled(value) {
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return text !== "false" && text !== "0";
  }
  return true;
}
function traeCheckinStatusOf(payload) {
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return {
    enable: traeEnabled(record["enable"]),
    checkedIn: traeFlag(record["checked_in"]),
    didCheckedIn: traeFlag(record["did_checked_in"]),
    credits: traeNumber(record["credits"], 0),
    code: traeNumber(record["code"], -1),
    ...typeof record["message"] === "string" ? { message: record["message"] } : {}
  };
}
class TraeSoloUpstreamClient {
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  fetchImpl;
  /**
   * Read the callable roster for this credential's region. Every function in
   * `TRAE_DIRECTORY_FUNCTIONS` is asked in order and their answers unioned;
   * one function failing never hides the others' rosters.
   *
   * The answer says whether it is `partial`: a function that failed is one that
   * would have listed models, and the ones only it lists are missing from what
   * came back. That has to travel with the read, because the roster replaces the
   * cached one - and a roster that lost models makes the gateway refuse them as
   * `not_found`, for as long as the read stays fresh.
   */
  async fetchModels(signal) {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    const region = (0, import_trae_discovery.traeRegionOfCredential)(credential);
    const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat;
    const headers = { ...buildTraeHeaders(credential, identity), Accept: "application/json" };
    const byId = /* @__PURE__ */ new Map();
    const failures = [];
    const failedFunctions = [];
    const answers = await Promise.all(TRAE_DIRECTORY_FUNCTIONS[region].map(async (directoryFunction) => {
      try {
        const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
          redirect: "error",
          method: "POST",
          headers,
          body: JSON.stringify({
            function: directoryFunction,
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null
          }),
          signal: signal ?? AbortSignal.timeout(3e4)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const document = await response.json();
        if (!Array.isArray(document["config_info_list"])) {
          const code = typeof document["code"] === "number" ? document["code"] : void 0;
          const message = typeof document["message"] === "string" ? document["message"].slice(0, 60) : "";
          throw new Error(code === void 0 ? "no config_info_list" : `code ${code}${message === "" ? "" : ": " + message}`);
        }
        return { directoryFunction, list: document["config_info_list"] };
      } catch (error) {
        failedFunctions.push(directoryFunction);
        return { directoryFunction, failure: `${directoryFunction}: ${String(error).slice(0, 80)}` };
      }
    }));
    for (const answer of answers) {
      if (answer.failure !== void 0) {
        failures.push(answer.failure);
        continue;
      }
      collectTraeSoloModels(answer.list, answer.directoryFunction, byId);
    }
    const models = [...byId.values()];
    if (models.length === 0) {
      throw new Error(`Trae SOLO models response contained no models (${failures.join("; ") || "empty directory"})`);
    }
    const reasoning = await this.readRemoteReasoning(credential, region, signal);
    for (const model of models) {
      if (model.reasoning !== void 0) continue;
      const found = reasoning.get(model.id);
      if (found !== void 0) model.reasoning = found;
    }
    return { models, partial: failures.length > 0, failedFunctions };
  }
  /**
   * Reasoning tables live on the remote model directory, not on
   * `get_detail_param`. A failure here leaves the roster callable and the
   * picker with no levels, rather than failing model discovery.
   */
  async readRemoteReasoning(credential, region, signal) {
    const dressing = region === "ai" ? { referer: "https://coresg-normal.trae.ai/", timezone: "Asia/Singapore", language: "en" } : { referer: "https://solo.trae.cn/", timezone: "Asia/Shanghai", language: "zh-cn" };
    try {
      const response = await this.fetchImpl(
        `${REGION_GATEWAYS[region].remote}/models?functions=${TRAE_DIRECTORY_FUNCTIONS[region].join(",")}`,
        {
          redirect: "error",
          headers: {
            "Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
            "Content-Type": "application/json",
            "x-trae-client-type": "web",
            "x-trae-user-timezone": dressing.timezone,
            "x-preferenced-language": dressing.language,
            "Referer": dressing.referer
          },
          signal: signal ?? AbortSignal.timeout(3e4)
        }
      );
      if (!response.ok) return /* @__PURE__ */ new Map();
      const json = await response.json();
      return collectTraeRemoteReasoning(json.data?.list ?? []);
    } catch {
      return /* @__PURE__ */ new Map();
    }
  }
  /** Today's check-in state for this credential (CN only). */
  async fetchCheckinStatus(signal) {
    return this.postCheckin(TRAE_CHECKIN_STATUS_PATH, signal);
  }
  /** Totals for this account (CN only): what the card shows as remaining. */
  async fetchUsageSummary(signal) {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    if ((0, import_trae_discovery.traeRegionOfCredential)(credential) !== "cn") throw new Error("Trae usage exists on CN only");
    const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS.cn.pay, TRAE_USAGE_PATH), {
      redirect: "error",
      method: "POST",
      headers: traeCheckinHeaders(credential, identity),
      body: JSON.stringify({ require_usage: true }),
      signal: signal ?? AbortSignal.timeout(3e4)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Trae usage failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Trae usage: response is not valid JSON \u2014 ${text.slice(0, 200) || "(empty)"}`);
    }
    return traeUsageSummaryOf(payload);
  }
  /**
   * This account's subscription plan (international only).
   *
   * The ai region is subscription-based: it has no Work-credit totals, so the
   * plan name is the figure its card shows. CN never calls this.
   */
  async fetchPayStatus(signal) {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    const region = (0, import_trae_discovery.traeRegionOfCredential)(credential);
    if (region !== "ai") throw new Error("Trae pay status exists on the international region only");
    const response = await this.fetchImpl(traeEndpoint(this.options.baseUrl ?? REGION_GATEWAYS[region].pay, TRAE_PAY_STATUS_PATH), {
      redirect: "error",
      method: "POST",
      headers: traeCheckinHeaders(credential, identity, region),
      body: "{}",
      signal: signal ?? AbortSignal.timeout(3e4)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Trae pay status failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Trae pay status: response is not valid JSON \u2014 ${text.slice(0, 200) || "(empty)"}`);
    }
    return traePayStatusOf(payload);
  }
  /**
   * Claim today's check-in (CN only). The answer carries no gained amount —
   * read the status again afterwards if the number matters.
   */
  async claimCheckin(signal) {
    return this.postCheckin(TRAE_CHECKIN_CLAIM_PATH, signal);
  }
  async postCheckin(path, signal) {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    if ((0, import_trae_discovery.traeRegionOfCredential)(credential) !== "cn") throw new Error("Trae check-in exists on CN only");
    const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS.cn.pay, path), {
      redirect: "error",
      method: "POST",
      headers: traeCheckinHeaders(credential, identity),
      body: "{}",
      signal: signal ?? AbortSignal.timeout(3e4)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Trae check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Trae check-in: response is not valid JSON \u2014 ${text.slice(0, 200) || "(empty)"}`);
    }
    return traeCheckinStatusOf(payload);
  }
  /** Send one chat body through the credential's regional gateway. */
  async chatStream(bodyJson, signal, functionName, capability, timeouts, maxMode) {
    let prepared;
    try {
      prepared = prepareSoloBody(bodyJson, void 0, functionName, capability, maxMode === true);
    } catch (error) {
      const message = error instanceof Error && error.message !== "" ? error.message : "invalid JSON request";
      return { ok: false, status: 400, kind: "client", message };
    }
    let credential;
    let identity;
    try {
      [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    } catch (error) {
      return { ok: false, status: 503, kind: "server", message: `identity read failed: ${String(error instanceof Error ? error.message : error)}` };
    }
    const headers = buildTraeHeaders(credential, identity);
    const base = this.options.baseUrl ?? REGION_GATEWAYS[(0, import_trae_discovery.traeRegionOfCredential)(credential)].chat;
    let response;
    const deadline = (0, import_upstream.headersDeadline)(signal, timeouts?.headersMs ?? TRAE_HEADERS_TIMEOUT_MS);
    try {
      response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
        redirect: "error",
        method: "POST",
        headers,
        body: prepared,
        signal: deadline.signal
      });
    } catch (error) {
      if (signal?.aborted === true) {
        return { ok: false, status: 0, kind: "aborted", message: "cancelled by the caller" };
      }
      return { ok: false, status: 0, kind: "server", message: `transport error: ${String(error)}` };
    } finally {
      deadline.arrived();
    }
    if (response.ok) {
      return {
        ok: true,
        response: response.body === null ? response : new Response((0, import_upstream.withIdleWatchdog)(response.body, timeouts?.idleMs, signal), {
          status: response.status,
          headers: response.headers
        })
      };
    }
    const text = await (0, import_upstream.readErrorBody)(response, 1024, signal);
    return {
      ok: false,
      status: response.status,
      kind: classifyTraeUpstreamError(response.status),
      message: text || `Trae SOLO returned HTTP ${response.status}`,
      // The rate limit's own wait time, carried out so the gateway can answer
      // with it: the in-stream path already relays one, and a client told to
      // wait retries at once without it.
      retryAfter: response.headers.get("retry-after")
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_DEVICE_CLAIMED,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_PAY_STATUS_PATH,
  TRAE_USAGE_PATH,
  TraeSoloUpstreamClient,
  classifyTraeUpstreamError,
  collectTraeSoloModels,
  mergeTraeDirectory,
  prepareSoloBody,
  traeVariantFor
});
