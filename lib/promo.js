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
var promo_exports = {};
__export(promo_exports, {
  promoStatusFor: () => promoStatusFor
});
module.exports = __toCommonJS(promo_exports);
const PROMO_RULES = [
  { idPrefix: "hy4-preview", region: "cn", hours: [23, 0, 1, 2, 3, 4, 5, 6, 7], until: "2026-10-31" }
];
function nextWindowHour(rule, hour) {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (hour + step) % 24;
    if (rule.hours.includes(candidate)) return candidate;
  }
  return hour;
}
function windowEndHour(rule, hour) {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (hour + step) % 24;
    if (!rule.hours.includes(candidate)) return candidate;
  }
  return hour;
}
function promoStatusFor(model, clock, region) {
  if (model.multiplier === 0) return void 0;
  for (const rule of PROMO_RULES) {
    if (rule.region !== region) continue;
    if (!model.id.startsWith(rule.idPrefix)) continue;
    if (clock.day > rule.until) continue;
    if (rule.hours.includes(clock.hour)) {
      const untilHour = windowEndHour(rule, clock.hour);
      if (clock.day === rule.until && untilHour <= clock.hour) {
        return { kind: "night", untilHour: 24 };
      }
      return { kind: "night", untilHour };
    }
    return { kind: "night-later", nextHour: nextWindowHour(rule, clock.hour) };
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  promoStatusFor
});
