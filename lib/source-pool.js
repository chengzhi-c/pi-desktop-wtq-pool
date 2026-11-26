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
  createSourcePool: () => createSourcePool,
  sourceAccountId: () => sourceAccountId,
  uniqueSourceLabels: () => uniqueSourceLabels
});
module.exports = __toCommonJS(source_pool_exports);
var import_node_crypto = require("node:crypto");
var import_loopback = require("./loopback");
function sourceAccountId(region, id) {
  return (0, import_node_crypto.createHash)("sha256").update(region + "\n" + id).digest("hex");
}
function uniqueSourceLabels(items, labelOf, idOf) {
  const labels = items.map((item) => labelOf(item));
  const counts = /* @__PURE__ */ new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const named = items.map((item, index) => {
    const label = labels[index];
    if (counts.get(label) === 1) return label;
    const id = idOf(item).replace(/[^A-Za-z0-9]/gu, "").slice(-8);
    return id === "" ? label : `${label}#${id}`;
  });
  const namedCounts = /* @__PURE__ */ new Map();
  for (const name of named) namedCounts.set(name, (namedCounts.get(name) ?? 0) + 1);
  const used = new Map([...labels, ...named].map((name) => [name, ""]));
  const conflicts = items.map((item, index) => ({ index, id: idOf(item) })).filter(({ index, id }) => id !== "" && namedCounts.get(named[index]) !== 1 && counts.get(labels[index]) !== 1).sort((left, right) => left.id.localeCompare(right.id));
  for (const { index, id } of conflicts) {
    const base = `${labels[index]}#${(0, import_node_crypto.createHash)("sha256").update(id).digest("hex").slice(0, 8)}`;
    let name = base;
    let suffix = 2;
    while (used.has(name) && used.get(name) !== id) name = `${base}-${suffix++}`;
    named[index] = name;
    used.set(name, id);
  }
  return named;
}
function createSourcePool(host) {
  function accountStateKey(source, region, id) {
    return host.sourceRegionKey(source, region) + "\n" + id;
  }
  const sourceCreditExpiry = /* @__PURE__ */ new Map();
  function packUrgency(source, region, id, now) {
    const at = sourceCreditExpiry.get(accountStateKey(source, region, id));
    return typeof at === "number" && at > now ? at : Infinity;
  }
  const sourceRotation = /* @__PURE__ */ new Map();
  const sourceFailureHold = /* @__PURE__ */ new Map();
  function noteSourceFailure(source, region, id, retryAfter) {
    const stated = (0, import_loopback.retryAfterHeader)(retryAfter);
    const waitMs = stated === void 0 ? host.cooldownMs() : Number(stated) * 1e3;
    sourceFailureHold.set(accountStateKey(source, region, id), Date.now() + waitMs);
  }
  function sourceFailureActive(source, region, id, now) {
    const key = accountStateKey(source, region, id);
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
  function orderSourceCredentials(source, region, credentials, idOf, rotate) {
    const now = Date.now();
    const stored = host.preferredSourceAccount(source, region);
    const preferred = stored !== "" && credentials.some((credential) => idOf(credential) === stored) ? stored : "";
    const rank = (credential) => {
      const expired = sourceCredentialExpired(credential, now) ? 1 : 0;
      const held2 = expired === 0 && sourceFailureActive(source, region, idOf(credential), now) ? 1 : 0;
      const wanted = preferred !== "" && idOf(credential) === preferred ? 0 : 1;
      return expired * 4 + held2 * 2 + wanted;
    };
    const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right));
    if (preferred === "" && host.sourceDistribution(source) === "expiry") {
      const live2 = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
      const rest2 = ordered.filter((credential) => sourceCredentialExpired(credential, now));
      const healthy2 = live2.filter((credential) => !sourceFailureActive(source, region, idOf(credential), now));
      const held2 = live2.filter((credential) => sourceFailureActive(source, region, idOf(credential), now));
      const byUrgency = (left, right) => packUrgency(source, region, idOf(left), now) - packUrgency(source, region, idOf(right), now);
      healthy2.sort(byUrgency);
      held2.sort(byUrgency);
      return healthy2.concat(held2, rest2);
    }
    const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
    const peek = rotate === "peek";
    if (rotate !== true && !peek || preferred !== "" || live.length < 2 || host.sourceDistribution(source) !== "round-robin") return ordered;
    const healthy = live.filter((credential) => !sourceFailureActive(source, region, idOf(credential), now));
    const held = live.filter((credential) => sourceFailureActive(source, region, idOf(credential), now));
    if (healthy.length < 2) return ordered;
    const key = host.sourceRegionKey(source, region);
    const step = (sourceRotation.get(key) ?? 0) % healthy.length;
    if (!peek) sourceRotation.set(key, step + 1);
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
    orderSourceCredentials
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createSourcePool,
  sourceAccountId,
  uniqueSourceLabels
});
