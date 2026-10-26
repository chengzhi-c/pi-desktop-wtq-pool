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
var qoder_client_exports = {};
__export(qoder_client_exports, {
  QODER_EFFORT_ORDER: () => QODER_EFFORT_ORDER,
  QoderUpstreamClient: () => QoderUpstreamClient,
  classifyQoderUpstreamError: () => classifyQoderUpstreamError,
  qoderCheckinStateFrom: () => qoderCheckinStateFrom,
  qoderClaimableCampaignIdOf: () => qoderClaimableCampaignIdOf,
  qoderModelOf: () => qoderModelOf,
  qoderNormalizeClaimResult: () => qoderNormalizeClaimResult,
  qoderRewardExpiryMs: () => qoderRewardExpiryMs,
  qoderRewardValidityDaysOf: () => qoderRewardValidityDaysOf
});
module.exports = __toCommonJS(qoder_client_exports);
var import_node_crypto = require("node:crypto");
var import_qoder_upstream = require("./qoder-upstream");
var import_upstream = require("./upstream");
const QODER_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];
const QODER_TABLE_LEVELS = QODER_EFFORT_ORDER.filter((level) => level !== "none");
const QODER_MODELS_PATH = "/algo/api/v2/model/list?Encode=1";
const QODER_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
function qoderEndpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
const QODER_OPENAPI = {
  cn: "https://openapi.qoder.com.cn",
  global: "https://openapi.qoder.sh"
};
const QODER_USAGE_PATH = "/api/v2/quota/usage";
const QODER_USAGE_PRESENTATION_PATH = "/sash/api/v2/me/usage";
const QODER_CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
function qoderOpenApiHeaders(credential) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.token}`,
    "Cosy-ClientType": "10",
    "User-Agent": "Qoder"
  };
}
function qoderNumber(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : void 0;
}
function qoderRemainingOf(record, total) {
  const used = Math.max(0, qoderNumber(record["used"]) ?? 0);
  return Math.max(0, qoderNumber(record["remaining"]) ?? total - used);
}
function qoderQuotaBucket(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  const total = qoderNumber(record["total"]);
  if (total === void 0 || total < 0) return void 0;
  return { total, remaining: qoderRemainingOf(record, total) };
}
function qoderDedicatedPackage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  const id = typeof record["id"] === "string" ? record["id"].trim() : "";
  const total = qoderNumber(record["total"]);
  if (id === "" || total === void 0 || total <= 0) return void 0;
  const expiresAtMs = qoderEpochMs(record["expiresAt"] ?? record["expires_at"]);
  return {
    id,
    name: typeof record["name"] === "string" ? record["name"] : "",
    total,
    remaining: qoderRemainingOf(record, total),
    ...expiresAtMs === void 0 ? {} : { expiresAtMs }
  };
}
const QODER_EPOCH_SECONDS_BOUNDARY_MS = 1e12;
const QODER_EPOCH_CEILING_MS = 72581184e5;
function qoderRawEpochMs(value) {
  if (value === null || value === void 0) return void 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return void 0;
    return value < QODER_EPOCH_SECONDS_BOUNDARY_MS ? Math.floor(value * 1e3) : Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function qoderEpochMs(value) {
  const ms = qoderRawEpochMs(value);
  return ms !== void 0 && ms <= QODER_EPOCH_CEILING_MS ? ms : void 0;
}
const QODER_CLAIM_BENEFIT_ACTION = "CLAIM_BENEFIT";
const QODER_CLAIMED_STATUS = "CLAIMED";
const CHAT_HEADERS_TIMEOUT_MS = 6e4;
const DIRECTORY_TIMEOUT_MS = 3e4;
function qoderBenefitOf(campaign) {
  const benefit = campaign?.benefit;
  if (benefit === null || typeof benefit !== "object") return void 0;
  const record = benefit;
  const amount = Number(record.amount);
  if (!Number.isFinite(amount) || amount <= 0) return void 0;
  const relative = record.validity?.mode === "RELATIVE_DAYS";
  const validityDays = Number(record.validity?.days);
  return {
    amount,
    kind: typeof record.kind === "string" ? record.kind : "CREDITS",
    ...relative && Number.isFinite(validityDays) && validityDays > 0 ? { validDays: validityDays } : {}
  };
}
function qoderWindowOpenAt(campaign, nowMs) {
  const record = campaign;
  const startAt = qoderEpochMs(record?.startAt ?? record?.beginAt);
  const endAt = qoderEpochMs(record?.endAt);
  if (startAt !== void 0 && nowMs < startAt) return false;
  if (endAt !== void 0 && nowMs > endAt) return false;
  return true;
}
function qoderClaimableCampaignOf(payload, nowMs) {
  const holder = payload;
  const list = holder?.campaigns;
  if (!Array.isArray(list)) return void 0;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const campaign = entry;
    if (campaign["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
    if (!qoderWindowOpenAt(campaign, nowMs)) continue;
    return campaign;
  }
  return void 0;
}
function qoderClaimableCampaignIdOf(payload, nowMs = Date.now()) {
  const campaign = qoderClaimableCampaignOf(payload, nowMs);
  if (campaign === void 0 || campaign["claimStatus"] === QODER_CLAIMED_STATUS) return void 0;
  const id = campaign["campaignId"];
  return typeof id === "string" && id.length > 0 ? id : void 0;
}
function qoderRewardValidityDaysOf(payload) {
  const holder = payload;
  const list = holder?.campaigns;
  if (!Array.isArray(list)) return void 0;
  let days;
  for (const entry of list) {
    const validDays = qoderBenefitOf(entry)?.validDays;
    if (validDays === void 0) continue;
    if (days === void 0 || validDays < days) days = validDays;
  }
  return days;
}
function qoderRewardExpiryMs(payload) {
  const holder = payload;
  const list = holder?.campaigns;
  if (!Array.isArray(list)) return void 0;
  let openedAt;
  let validDays;
  for (const entry of list) {
    const record = entry;
    if (record === null || typeof record !== "object") continue;
    if (record["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
    if (record["claimStatus"] !== QODER_CLAIMED_STATUS) continue;
    const days = qoderBenefitOf(record)?.validDays;
    if (days === void 0) continue;
    const startedAt = qoderEpochMs(record["startAt"]) ?? qoderEpochMs(record["beginAt"]);
    if (startedAt === void 0) continue;
    if (openedAt === void 0 || startedAt > openedAt) {
      openedAt = startedAt;
      validDays = days;
    }
  }
  return openedAt === void 0 || validDays === void 0 ? void 0 : openedAt + validDays * 864e5;
}
function qoderCheckinStateFrom(payload, nowMs = Date.now()) {
  const campaign = qoderClaimableCampaignOf(payload, nowMs);
  if (campaign === void 0) {
    const opensAt = qoderNextOpenAt(payload, nowMs);
    return { active: false, todayCheckedIn: false, ...opensAt === void 0 ? {} : { opensAt } };
  }
  const benefit = qoderBenefitOf(campaign);
  const endsAt = qoderEpochMs(campaign["endAt"]);
  return {
    active: true,
    todayCheckedIn: campaign["claimStatus"] === QODER_CLAIMED_STATUS,
    ...benefit === void 0 ? {} : {
      amount: benefit.amount,
      unit: benefit.kind === "CREDITS" ? "credits" : benefit.kind.toLowerCase(),
      ...benefit.validDays === void 0 ? {} : { validDays: benefit.validDays }
    },
    ...endsAt === void 0 ? {} : { endsAt }
  };
}
function qoderNextOpenAt(payload, nowMs) {
  const holder = payload;
  const list = holder?.campaigns;
  if (!Array.isArray(list)) return void 0;
  let soonest;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const campaign = entry;
    if (campaign["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
    if (campaign["claimStatus"] === QODER_CLAIMED_STATUS) continue;
    const startAt = qoderEpochMs(campaign["startAt"] ?? campaign["beginAt"]);
    if (startAt === void 0 || nowMs >= startAt) continue;
    if (soonest === void 0 || startAt < soonest) soonest = startAt;
  }
  return soonest;
}
function qoderClaimCampaignPath(campaignId) {
  return `${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`;
}
function qoderNormalizeClaimResult(payload, campaign) {
  const payloadRecord = payload;
  const body = payloadRecord?.data !== null && typeof payloadRecord?.data === "object" ? payloadRecord.data : payload;
  const status = typeof body?.status === "string" ? body.status : "";
  const replayed = body?.replayed === true;
  const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
  const granted = status === QODER_CLAIMED_STATUS || replayed || body?.success === true || grantId !== "";
  const amountValue = Number(body?.reward?.amount ?? body?.benefit?.amount ?? (typeof campaign !== "undefined" ? qoderBenefitOf(campaign)?.amount : void 0));
  const expiresAt = qoderEpochMs(body?.expiresAt);
  const code = Number(body?.code ?? body?.errcode);
  const refusal = Number.isFinite(code) && code !== 0 ? String(body?.message ?? body?.msg ?? "upstream code " + code).slice(0, 200) : "";
  return {
    claimed: granted,
    replayed,
    // A payout is what `amount` reports, so a replay that granted nothing and a
    // status that never reached CLAIMED must not carry one: the campaign's
    // advertised amount used to ride along and name credits that never landed.
    ...granted && !replayed && Number.isFinite(amountValue) && amountValue > 0 ? { amount: amountValue } : {},
    ...expiresAt === void 0 ? {} : { expiresAt },
    ...!granted && refusal !== "" ? { reason: refusal } : {}
  };
}
function classifyQoderUpstreamError(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "hard_credit";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type === "text") text += typeof block.text === "string" ? block.text : "";
  }
  return text;
}
function toQoderMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  const callsByName = /* @__PURE__ */ new Map();
  const answered = /* @__PURE__ */ new Set();
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    if (raw["role"] === "system" || raw["role"] === "developer") {
      out.push({ role: "system", content: textOf(raw["content"]) });
      continue;
    }
    if (raw["role"] === "user") {
      const content = raw["content"];
      out.push({ role: "user", content: Array.isArray(content) ? content : textOf(content) });
      continue;
    }
    if (raw["role"] === "assistant") {
      const toolCalls = [];
      if (Array.isArray(raw["tool_calls"])) {
        for (const call of raw["tool_calls"]) {
          if (call === null || typeof call !== "object") continue;
          const id = call["id"];
          if (typeof id !== "string" || id.length === 0) {
            throw new Error("toQoderMessages: assistant tool_call is missing an id; the tool loop cannot match the result back to it");
          }
          const fn = call["function"];
          const name = typeof fn === "object" && fn !== null ? fn["name"] : call["name"];
          if (typeof name !== "string" || name.length === 0) {
            throw new Error(`toQoderMessages: assistant tool_call "${id}" has no function name; the gateway cannot dispatch it`);
          }
          const args = typeof fn === "object" && fn !== null ? fn["arguments"] : call["arguments"];
          toolCalls.push({
            id,
            type: "function",
            function: {
              name,
              arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
            }
          });
        }
      }
      const entry = { role: "assistant", content: textOf(raw["content"]) };
      if (toolCalls.length > 0) {
        entry["tool_calls"] = toolCalls;
        for (const call of toolCalls) {
          const name = String(call["function"]["name"]);
          callsByName.set(name, [...callsByName.get(name) ?? [], String(call["id"])]);
        }
      }
      out.push(entry);
      continue;
    }
    if (raw["role"] === "function") {
      const name = raw["name"];
      const callId = typeof name === "string" ? (callsByName.get(name) ?? []).find((id) => !answered.has(id)) : void 0;
      if (callId === void 0) {
        throw new Error(`toQoderMessages: function message "${typeof name === "string" ? name : ""}" does not answer any assistant tool_call; the tool loop cannot match it`);
      }
      answered.add(callId);
      out.push({ role: "tool", tool_call_id: callId, content: textOf(raw["content"]) });
      continue;
    }
    if (raw["role"] === "tool" || raw["role"] === "toolResult") {
      const toolCallId = raw["tool_call_id"] ?? raw["toolCallId"];
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new Error("toQoderMessages: tool result message is missing tool_call_id; it cannot be linked to the calling assistant turn");
      }
      answered.add(toolCallId);
      out.push({ role: "tool", tool_call_id: toolCallId, content: textOf(raw["content"]) });
      continue;
    }
    throw new Error(`toQoderMessages: unsupported message role "${String(raw["role"])}"`);
  }
  return out;
}
function toQoderTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool, index) => {
    if (tool !== null && typeof tool === "object") {
      const fn = tool["function"];
      if (fn !== null && typeof fn === "object") {
        const name2 = fn["name"];
        if (typeof name2 !== "string" || name2.length === 0) {
          throw new Error(`toQoderTools: tool at index ${index} has no function name; the gateway cannot register it`);
        }
        return {
          type: "function",
          function: {
            name: name2,
            description: fn["description"] ?? "",
            parameters: fn["parameters"] ?? { type: "object", properties: {} }
          }
        };
      }
      const name = tool["name"];
      if (typeof name === "string" && name.length > 0) {
        return {
          type: "function",
          function: {
            name,
            description: tool["description"] ?? "",
            parameters: tool["parameters"] ?? { type: "object", properties: {} }
          }
        };
      }
    }
    throw new Error(`toQoderTools: tool at index ${index} has no name; the gateway cannot register it`);
  });
}
function buildQoderChatBody(source, model, options = {}) {
  const input = JSON.parse(source);
  const recordID = (0, import_node_crypto.randomUUID)();
  const messages = toQoderMessages(input["messages"]);
  const lastUser = [...messages].reverse().find((message) => message["role"] === "user");
  const lastText = textOf(lastUser?.["content"]);
  const parameters = {};
  const maxTokens = input["max_tokens"] ?? input["max_completion_tokens"];
  if (typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    parameters["max_tokens"] = maxTokens;
  }
  if (options.enableThinking === true) {
    parameters["enable_thinking"] = true;
    if (typeof options.reasoningEffort === "string" && options.reasoningEffort.length > 0) {
      parameters["reasoning_effort"] = options.reasoningEffort;
    }
  } else if (options.enableThinking === false) {
    parameters["enable_thinking"] = false;
  }
  return JSON.stringify({
    request_id: (0, import_node_crypto.randomUUID)(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: options.sessionId ?? `xdpool-${(0, import_node_crypto.randomUUID)()}`,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    aliyun_user_type: "",
    system: "",
    messages,
    tools: toQoderTools(input["tools"]),
    parameters,
    chat_context: {
      chatPrompt: "",
      // Kept as the directory's own client sends it (`null`): the image rides in
      // `messages`, and this key is part of the envelope's shape.
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model, ...options.enableThinking === void 0 ? {} : { is_reasoning: options.enableThinking } },
        originalContent: lastText
      },
      features: [],
      text: lastText
    },
    model_config: {
      key: model,
      source: "system",
      ...options.enableThinking === void 0 ? {} : { is_reasoning: options.enableThinking }
    },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: (0, import_node_crypto.randomUUID)(),
      name: lastText.slice(0, 30),
      begin_at: Date.now()
    }
  });
}
function readQoderCatalogShape(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Qoder model list shape changed: top level is ${Array.isArray(data) ? "an array" : typeof data}, not a group envelope`);
  }
  const envelope = data;
  if (!("chat" in envelope)) {
    throw new Error(`Qoder model list shape changed: no \`chat\` group; groups present: ${Object.keys(envelope).slice(0, 12).join(", ") || "(none)"}`);
  }
  const chat = envelope["chat"];
  if (!Array.isArray(chat)) {
    throw new Error(`Qoder model list shape changed: \`chat\` is ${chat === null ? "null" : typeof chat}, not an array`);
  }
  return chat;
}
function qoderContextWindowOf(record) {
  const config = record["context_config"];
  if (config === null || typeof config !== "object" || Array.isArray(config)) return void 0;
  const tokenCountOf = (entry) => {
    if (entry === null || typeof entry !== "object") return void 0;
    const value = entry["token_count"];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
  };
  const sizes = Object.values(config).map(tokenCountOf).filter((value) => value !== void 0);
  return sizes.length === 0 ? void 0 : Math.max(...sizes);
}
const QODER_UNNAMED_ROUTES = /* @__PURE__ */ new Set(["ultimate", "efficient", "smodel", "cmodel"]);
function qoderModelOf(entry) {
  if (entry === null || typeof entry !== "object") return void 0;
  const record = entry;
  if (typeof record["key"] !== "string" || record["key"].length === 0) return void 0;
  if (QODER_UNNAMED_ROUTES.has(record["key"])) return void 0;
  if (record["enable"] === false) return void 0;
  if (typeof record["display_name"] !== "string" || record["display_name"].length === 0) return void 0;
  const config = record["thinking_config"];
  const efforts = config?.enabled?.efforts;
  const isShape = efforts !== null && typeof efforts === "object" && !Array.isArray(efforts);
  const effortLevels = isShape ? QODER_TABLE_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(efforts, level)) : [];
  const defaultEffort = isShape ? QODER_TABLE_LEVELS.find((level) => {
    const row = efforts[level];
    return row !== null && typeof row === "object" && row["is_default"] === true;
  }) : void 0;
  const maxInputTokens = typeof record["max_input_tokens"] === "number" && Number.isFinite(record["max_input_tokens"]) && record["max_input_tokens"] > 0 ? record["max_input_tokens"] : void 0;
  const contextConfig = qoderContextWindowOf(record);
  const contextWindow = contextConfig === void 0 ? maxInputTokens : Math.max(contextConfig, maxInputTokens ?? 0);
  return {
    id: record["key"],
    name: record["display_name"],
    ...maxInputTokens === void 0 ? {} : { maxInputTokens },
    ...contextWindow === void 0 ? {} : { contextWindow },
    supportsImages: record["is_vl"] === true,
    ...effortLevels.length === 0 ? {} : { effortLevels },
    ...defaultEffort === void 0 ? {} : { defaultEffort },
    ...effortLevels.length > 0 && config?.disabled === void 0 ? { alwaysThinking: true } : {}
  };
}
class QoderUpstreamClient {
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  fetchImpl;
  baseUrl() {
    return import_qoder_upstream.QODER_GATEWAYS[this.options.region];
  }
  /**
   * Read the callable roster for this region. A row the parser cannot use is
   * skipped rather than failing the whole directory; a shape that moved
   * throws a named error.
   */
  async fetchModels(signal) {
    const credential = await this.options.credential();
    const url = qoderEndpoint(this.baseUrl(), QODER_MODELS_PATH);
    const headers = (0, import_qoder_upstream.buildCosyAuthHeaders)(Buffer.alloc(0), url, credential);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      // A directory read with no bound of its own would hold the gateway's
      // in-flight promise forever, and every later request would wait on it.
      signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`Qoder model list failed: HTTP ${response.status} ${await (0, import_upstream.readErrorBody)(response, 300, signal)}`);
    }
    const chat = readQoderCatalogShape(await response.json());
    const models = [];
    for (const raw of chat) {
      const model = qoderModelOf(raw);
      if (model !== void 0) models.push(model);
    }
    if (models.length === 0) throw new Error("Qoder model list contained no callable model");
    return models;
  }
  openApiBase() {
    return QODER_OPENAPI[this.options.region];
  }
  /**
   * Read the account's usage, shaped the way the IDE panel presents it.
   *
   * Two routes carry different halves: the presentation route includes the
   * per-model dedicated packages, `quota/usage` is the older narrower shape.
   * Either alone renders something useful, so the first failing falls back to
   * the second rather than failing the whole read. Both failing throws — the
   * caller reports "usage unavailable" instead of an empty panel.
   */
  async fetchUsage(signal) {
    const credential = await this.options.credential();
    const headers = qoderOpenApiHeaders(credential);
    const read = async (path) => {
      const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), path), {
        method: "GET",
        headers,
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`Qoder usage failed: HTTP ${response.status} ${await (0, import_upstream.readErrorBody)(response, 300, signal)}`);
      return await response.json();
    };
    let payload;
    let source = "presentation";
    try {
      payload = await read(QODER_USAGE_PRESENTATION_PATH);
    } catch (error) {
      if (signal?.aborted) throw error;
      source = "quota";
      payload = await read(QODER_USAGE_PATH);
    }
    const envelope = payload === null || typeof payload !== "object" ? {} : payload;
    const usage = envelope["qoderUsage"] ?? envelope["data"] ?? payload;
    if (usage === null || typeof usage !== "object") throw new Error("Qoder usage answered no usable document");
    const record = usage;
    const userQuota = qoderQuotaBucket(record["user_quota"] ?? record["userQuota"]);
    const addOnQuota = qoderQuotaBucket(record["add_on_quota"] ?? record["addOnQuota"]);
    const rawExpiry = record["expiresAt"] ?? record["expires_at"];
    const expiresAtMs = qoderEpochMs(rawExpiry);
    const neverExpires = expiresAtMs === void 0 && rawExpiry !== void 0 && rawExpiry !== null && rawExpiry !== "";
    const rawPackages = record["dedicated_resource_packages"] ?? record["dedicatedResourcePackages"];
    const now = Date.now();
    const dedicatedPackages = Array.isArray(rawPackages) ? rawPackages.map(qoderDedicatedPackage).filter((entry) => entry !== void 0).filter((entry) => entry.expiresAtMs === void 0 || entry.expiresAtMs > now) : [];
    if (userQuota === void 0 && addOnQuota === void 0 && dedicatedPackages.length === 0) {
      throw new Error("Qoder usage contained no usable quota");
    }
    return {
      ...userQuota === void 0 ? {} : { userQuota },
      ...addOnQuota === void 0 ? {} : { addOnQuota },
      dedicatedPackages,
      ...expiresAtMs === void 0 ? {} : { expiresAtMs },
      ...neverExpires ? { neverExpires: true } : {},
      source
    };
  }
  /**
   * Read the raw campaigns payload once. One round trip answers both the
   * promotional rows and the daily check-in round; the pure selectors above
   * split it without a second request.
   */
  async fetchCampaigns(signal) {
    const credential = await this.options.credential();
    const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), QODER_CAMPAIGNS_PATH), {
      method: "GET",
      headers: qoderOpenApiHeaders(credential),
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status} ${await (0, import_upstream.readErrorBody)(response, 300, signal)}`);
    return await response.json();
  }
  /**
   * Claim one campaign's benefit, returning the raw answer. A repeat answers
   * `replayed: true` rather than failing; `qoderNormalizeClaimResult` narrows it.
   */
  async claimCampaign(campaignId, signal) {
    if (typeof campaignId !== "string" || campaignId.length === 0) {
      throw new Error("Qoder check-in failed: no campaign id to claim");
    }
    const credential = await this.options.credential();
    const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), qoderClaimCampaignPath(campaignId)), {
      method: "POST",
      headers: { ...qoderOpenApiHeaders(credential), "Content-Type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
    });
    if (!response.ok) {
      const detail = await (0, import_upstream.readErrorBody)(response, 300, signal);
      throw new Error(`Qoder check-in failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      const contentType = response.headers.get("content-type") ?? "no content-type";
      throw new Error(`Qoder check-in: response is not valid JSON (${contentType}) \u2014 ${text.slice(0, 300)}`);
    }
  }
  /**
   * Open one chat stream for a model. The caller owns the SSE translation;
   * a refusal answers as a classified error with the body truncated.
   */
  async chatStream(openAiBody, model, options = {}) {
    let plain;
    try {
      plain = buildQoderChatBody(openAiBody, model, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      return { ok: false, status: 400, kind: "client", message: detail === "" ? "invalid JSON request" : detail };
    }
    let credential;
    try {
      credential = await this.options.credential();
    } catch (error) {
      return { ok: false, status: 503, kind: "server", message: `credential read failed: ${String(error instanceof Error ? error.message : error)}` };
    }
    const url = qoderEndpoint(this.baseUrl(), QODER_CHAT_PATH);
    const bodyBytes = (0, import_qoder_upstream.encodeBody)(plain);
    const headers = (0, import_qoder_upstream.buildCosyAuthHeaders)(bodyBytes, url, credential);
    let response;
    const deadline = (0, import_upstream.headersDeadline)(options.signal, options.timeouts?.headersMs ?? CHAT_HEADERS_TIMEOUT_MS);
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers, ...options.extraHeaders },
        body: bodyBytes,
        redirect: "error",
        signal: deadline.signal
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        return { ok: false, status: 0, kind: "aborted", message: "cancelled by the caller" };
      }
      return { ok: false, status: 0, kind: "server", message: `transport error: ${String(error)}` };
    } finally {
      deadline.arrived();
    }
    if (!response.ok) {
      const text = await (0, import_upstream.readErrorBody)(response, 300, options.signal);
      return {
        ok: false,
        status: response.status,
        kind: classifyQoderUpstreamError(response.status),
        message: text.slice(0, 300) || `Qoder returned HTTP ${response.status}`,
        // The rate limit's own wait time, carried out so the gateway can answer
        // with it: the in-stream path already relays one.
        retryAfter: response.headers.get("retry-after")
      };
    }
    return {
      ok: true,
      response: response.body === null ? response : new Response((0, import_upstream.withIdleWatchdog)(response.body, options.timeouts?.idleMs, options.signal), {
        status: response.status,
        headers: response.headers
      })
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QODER_EFFORT_ORDER,
  QoderUpstreamClient,
  classifyQoderUpstreamError,
  qoderCheckinStateFrom,
  qoderClaimableCampaignIdOf,
  qoderModelOf,
  qoderNormalizeClaimResult,
  qoderRewardExpiryMs,
  qoderRewardValidityDaysOf
});
