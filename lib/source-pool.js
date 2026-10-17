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
var source_pool_exports = {};
__export(source_pool_exports, {
  createSourcePool: () => createSourcePool
});
module.exports = __toCommonJS(source_pool_exports);
var import_loopback = require("./loopback");
function createSourcePool(host) {
  const sourceCreditExpiry = /* @__PURE__ */ new Map();
  function packUrgency(source, label, now) {
    const at = sourceCreditExpiry.get(source + "\n" + label);
    return typeof at === "number" && at > now ? at : Infinity;
  }
  const sourceRotation = /* @__PURE__ */ new Map();
  const sourceFailureHold = /* @__PURE__ */ new Map();
  function noteSourceFailure(source, label, retryAfter) {
    const stated = (0, import_loopback.retryAfterHeader)(retryAfter);
    const waitMs = stated === void 0 ? host.cooldownMs() : Number(stated) * 1e3;
    sourceFailureHold.set(source + "\n" + label, Date.now() + waitMs);
  }
  function sourceFailureActive(source, label, now) {
    const until = sourceFailureHold.get(source + "\n" + label);
    if (until === void 0) return false;
    if (until <= now) {
      sourceFailureHold.delete(source + "\n" + label);
      return false;
    }
    return true;
  }
  function sourceCredentialExpired(credential, now) {
    return typeof credential.expiresAtMs === "number" && credential.expiresAtMs > 0 && credential.expiresAtMs <= now;
  }
  function orderSourceCredentials(source, region, credentials, labelOf, rotate) {
    const now = Date.now();
    const stored = host.preferredSourceAccount(source, region);
    const preferred = stored !== "" && credentials.some((credential) => labelOf(credential) === stored) ? stored : "";
    const rank = (credential) => {
      const expired = sourceCredentialExpired(credential, now) ? 1 : 0;
      const held = expired === 0 && sourceFailureActive(source, labelOf(credential), now) ? 1 : 0;
      const wanted = preferred !== "" && labelOf(credential) === preferred ? 0 : 1;
      return expired * 4 + held * 2 + wanted;
    };
    const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right));
    if (preferred === "" && host.sourceDistribution(source) === "expiry") {
      const live2 = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
      const rest2 = ordered.filter((credential) => sourceCredentialExpired(credential, now));
      live2.sort((left, right) => packUrgency(source, labelOf(left), now) - packUrgency(source, labelOf(right), now));
      return live2.concat(rest2);
    }
    const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
    if (rotate !== true || preferred !== "" || live.length < 2 || host.sourceDistribution(source) !== "round-robin") return ordered;
    const key = host.sourceRegionKey(source, region);
    const step = (sourceRotation.get(key) ?? 0) % live.length;
    sourceRotation.set(key, step + 1);
    const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
    return live.slice(step).concat(live.slice(0, step), rest);
  }
  return {
    sourceCreditExpiry,
    sourceRotation,
    sourceFailureHold,
    sourceCredentialExpired,
    noteSourceFailure,
    sourceFailureActive,
    packUrgency,
    orderSourceCredentials
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createSourcePool
});
