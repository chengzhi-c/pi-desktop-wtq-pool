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
var checkin_time_exports = {};
__export(checkin_time_exports, {
  CHECKIN_POLL_MS: () => CHECKIN_POLL_MS,
  CHECKIN_TIME_ZONE: () => CHECKIN_TIME_ZONE,
  DEFAULT_CHECKIN_HOURS: () => DEFAULT_CHECKIN_HOURS,
  checkinSlotId: () => checkinSlotId,
  dueCheckinSlot: () => dueCheckinSlot,
  normaliseCheckinHours: () => normaliseCheckinHours,
  zonedDay: () => zonedDay,
  zonedDayHour: () => zonedDayHour
});
module.exports = __toCommonJS(checkin_time_exports);
const CHECKIN_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_CHECKIN_HOURS = [9];
const CHECKIN_POLL_MS = 6e4;
function zonedDayHour(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHECKIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found === void 0 ? "00" : found.value;
  };
  return { day: pick("year") + "-" + pick("month") + "-" + pick("day"), hour: Number(pick("hour")) };
}
function zonedDay(offset = 0) {
  const today = zonedDayHour(/* @__PURE__ */ new Date()).day;
  if (offset === 0) return today;
  const [year, month, day] = today.split("-");
  const shifted = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + offset));
  return shifted.toISOString().slice(0, 10);
}
function normaliseCheckinHours(raw) {
  const hours = [...new Set(raw.filter((value) => typeof value === "number" || typeof value === "string" && value.trim() !== "").map((value) => Math.floor(Number(value))))].filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23).sort((a, b) => a - b);
  return hours.length === 0 ? [...DEFAULT_CHECKIN_HOURS] : hours;
}
function checkinSlotId(day, hour) {
  return day + "T" + String(hour).padStart(2, "0");
}
function dueCheckinSlot(now, hours, fired) {
  const { day, hour } = zonedDayHour(now);
  for (const candidate of [...hours].sort((a, b) => a - b)) {
    if (candidate > hour) continue;
    const slot = checkinSlotId(day, candidate);
    if (!fired.has(slot)) return slot;
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHECKIN_POLL_MS,
  CHECKIN_TIME_ZONE,
  DEFAULT_CHECKIN_HOURS,
  checkinSlotId,
  dueCheckinSlot,
  normaliseCheckinHours,
  zonedDay,
  zonedDayHour
});
