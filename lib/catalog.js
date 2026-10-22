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
var catalog_exports = {};
__export(catalog_exports, {
  FALLBACK_WORKBUDDY_MODELS: () => FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog: () => WorkBuddyCatalog,
  applyOverride: () => applyOverride,
  catalogFromUpstream: () => catalogFromUpstream,
  hasOverride: () => hasOverride,
  toModelInfo: () => toModelInfo
});
module.exports = __toCommonJS(catalog_exports);
const FALLBACK_WORKBUDDY_MODELS = [
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "glm-5.1", name: "GLM-5.1", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: false },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "kimi-k3", name: "Kimi-K3", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "minimax-m3", name: "MiniMax-M3", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "hy3", name: "Hy3", contextWindow: 2e5, maxOutputTokens: 128e3, supportsImages: true },
  { id: "hy4-preview", name: "Hy4-Preview", contextWindow: 1e6, maxOutputTokens: 128e3, supportsImages: true }
];
class WorkBuddyCatalog {
  models = FALLBACK_WORKBUDDY_MODELS;
  live = false;
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  selection = {};
  /**
   * Whether the roster in force came from the upstream.
   *
   * False means the static fallback is still standing: this plugin's own guess,
   * not a list the vendor answered with. A saved selection cannot be judged
   * against a guess - doing it reported every model the vendor had added since
   * the fallback was written as retired, and said so on every start for as long
   * as the live read kept failing.
   */
  hasLiveRoster() {
    return this.live;
  }
  /** The catalog as the upstream advertises it, before any override. */
  current() {
    return this.models;
  }
  /**
   * The models the provider actually serves, after the user's selection:
   * disabled models are dropped, and each survivor carries its own override.
   *
   * An absent `enabledModelIds` means "everything" - a fresh install with no
   * saved selection must not present an empty picker.
   */
  visible() {
    const enabled = this.selection.enabledModelIds;
    const allow = enabled === void 0 ? void 0 : new Set(enabled);
    const overrides = this.selection.overrides ?? {};
    const bounded = this.live;
    return this.models.filter((model) => allow === void 0 || allow.has(model.id)).map((model) => applyOverride(model, overrides[model.id], bounded));
  }
  /**
   * Replace the catalog with the upstream's own list.
   *
   * An empty list keeps what is there: the static fallback is what a fresh
   * install publishes before any read succeeds, and a wipe here would leave the
   * gateway with nothing to declare. What counts as an answer is decided in
   * `catalogFromUpstream` before this is reached.
   */
  update(models) {
    if (models.length === 0) return;
    this.models = models;
    this.live = true;
  }
  /** Replace the user's selection; the model list is rebuilt from `visible()`. */
  applySelection(selection) {
    this.selection = selection;
  }
}
function applyOverride(model, override, bounded = false) {
  const next = { ...model };
  if (override === void 0) return next;
  if (override.alias !== void 0) {
    const alias = override.alias.trim();
    if (alias === "") delete next.alias;
    else next.alias = alias;
  }
  if (override.contextWindow !== void 0 && override.contextWindow > 0) {
    next.contextWindow = bounded ? Math.min(override.contextWindow, model.contextWindow) : override.contextWindow;
  }
  if (override.maxOutputTokens !== void 0 && override.maxOutputTokens > 0) {
    next.maxOutputTokens = bounded ? Math.min(override.maxOutputTokens, model.maxOutputTokens) : override.maxOutputTokens;
  }
  if (override.supportsImages !== void 0) next.supportsImages = override.supportsImages;
  if (override.thinkingLevels !== void 0 && override.thinkingLevels.length > 0) {
    next.supportedEfforts = override.thinkingLevels;
  }
  if (override.defaultThinkingLevel !== void 0) {
    next.defaultThinkingLevel = override.defaultThinkingLevel;
  }
  return next;
}
function hasOverride(override) {
  if (override === void 0) return false;
  return override.alias !== void 0 || override.contextWindow !== void 0 || override.maxOutputTokens !== void 0 || override.supportsImages !== void 0 || override.thinkingLevels !== void 0 || override.defaultThinkingLevel !== void 0;
}
function toModelInfo(model) {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsImages: model.supportsImages ?? false,
    ...model.creditMultiplier === void 0 ? {} : { multiplier: model.creditMultiplier },
    ...model.reasoning?.supportedEfforts === void 0 ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
    // The upstream's own default, so a model that starts at a non-minimum level
    // publishes that one instead of the plugin's fallback. The declaration only
    // carries it when the level is actually offered, so an upstream that names a
    // level its own roster does not list cannot produce an unusable default.
    ...model.reasoning?.defaultEffort === void 0 ? {} : { defaultThinkingLevel: model.reasoning.defaultEffort },
    ...model.reasoning?.canDisableThinking === void 0 ? {} : { canDisableThinking: model.reasoning.canDisableThinking }
  };
}
function catalogFromUpstream(models) {
  if (models.length === 0) return FALLBACK_WORKBUDDY_MODELS;
  return models.map(toModelInfo);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  applyOverride,
  catalogFromUpstream,
  hasOverride,
  toModelInfo
});
