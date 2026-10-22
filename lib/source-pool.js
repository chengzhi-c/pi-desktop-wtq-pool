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
  function accountStateKey(source, region, label) {
    return host.sourceRegionKey(source, region) + "\n" + label;
  }
  const sourceCreditExpiry = /* @__PURE__ */ new Map();
  function packUrgency(source, region, label, now) {
    const at = sourceCreditExpiry.get(accountStateKey(source, region, label));
    return typeof at === "number" && at > now ? at : Infinity;
  }
  const sourceRotation = /* @__PURE__ */ new Map();
  const sourceFailureHold = /* @__PURE__ */ new Map();
  function noteSourceFailure(source, region, label, retryAfter) {
    const stated = (0, import_loopback.retryAfterHeader)(retryAfter);
    const waitMs = stated === void 0 ? host.cooldownMs() : Number(stated) * 1e3;
    sourceFailureHold.set(accountStateKey(source, region, label), Date.now() + waitMs);
  }
  function sourceFailureActive(source, region, label, now) {
    const key = accountStateKey(source, region, label);
    const until = sourceFailureHold.get(key);
    if (until === void 0) return false;
    if (until <= now) {
      sourceFailureHold.delete(key);
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
      const held2 = expired === 0 && sourceFailureActive(source, region, labelOf(credential), now) ? 1 : 0;
      const wanted = preferred !== "" && labelOf(credential) === preferred ? 0 : 1;
      return expired * 4 + held2 * 2 + wanted;
    };
    const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right));
    if (preferred === "" && host.sourceDistribution(source) === "expiry") {
      const live2 = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
      const rest2 = ordered.filter((credential) => sourceCredentialExpired(credential, now));
      const healthy2 = live2.filter((credential) => !sourceFailureActive(source, region, labelOf(credential), now));
      const held2 = live2.filter((credential) => sourceFailureActive(source, region, labelOf(credential), now));
      const byUrgency = (left, right) => packUrgency(source, region, labelOf(left), now) - packUrgency(source, region, labelOf(right), now);
      healthy2.sort(byUrgency);
      held2.sort(byUrgency);
      return healthy2.concat(held2, rest2);
    }
    const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
    if (rotate !== true || preferred !== "" || live.length < 2 || host.sourceDistribution(source) !== "round-robin") return ordered;
    const healthy = live.filter((credential) => !sourceFailureActive(source, region, labelOf(credential), now));
    const held = live.filter((credential) => sourceFailureActive(source, region, labelOf(credential), now));
    if (healthy.length < 2) return ordered;
    const key = host.sourceRegionKey(source, region);
    const step = (sourceRotation.get(key) ?? 0) % healthy.length;
    sourceRotation.set(key, step + 1);
    const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
    return healthy.slice(step).concat(healthy.slice(0, step), held, rest);
  }
  return {
    sourceCreditExpiry,
    sourceRotation,
    sourceFailureHold,
    sourceCredentialExpired,
    accountStateKey,
    noteSourceFailure,
    packUrgency,
    orderSourceCredentials
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createSourcePool
});
