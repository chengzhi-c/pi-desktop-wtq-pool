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
var trae_identity_exports = {};
__export(trae_identity_exports, {
  TRAE_STORAGE_MISSING_PREFIX: () => TRAE_STORAGE_MISSING_PREFIX,
  pickTraeStorageIdentity: () => pickTraeStorageIdentity,
  readTraeCliIdentity: () => readTraeCliIdentity,
  readTraeIdentity: () => readTraeIdentity,
  resolveTraeIdentity: () => resolveTraeIdentity,
  traeDeviceCenterId: () => traeDeviceCenterId
});
module.exports = __toCommonJS(trae_identity_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_trae_discovery = require("./trae-discovery");
const TRAE_DEVICE_CENTER_PREFIX = "iCubeAuthInfo://icube-dc:";
const TRAE_STORAGE_MISSING_PREFIX = "Trae storage was not found";
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function osVersionOf(platform) {
  return `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${(0, import_node_os.release)()}`;
}
function deviceCpuOf() {
  return nonEmpty((0, import_node_os.cpus)()[0]?.model.split(" ")[0]);
}
function traeDeviceCenterId(storage) {
  const ids = Object.keys(storage).filter((key) => key.startsWith(TRAE_DEVICE_CENTER_PREFIX)).map((key) => key.slice(TRAE_DEVICE_CENTER_PREFIX.length)).filter(Boolean);
  return ids.length === 1 ? ids[0] : void 0;
}
async function readJsonFile(path) {
  try {
    const parsed = JSON.parse(await (0, import_promises.readFile)(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function productJsonPaths(edition, options) {
  const appName = (0, import_trae_discovery.traeMacAppName)(edition);
  if (options.platform === "darwin") {
    return [(0, import_node_path.join)("/Applications", `${appName}.app`, "Contents", "Resources", "app", "product.json")];
  }
  if (options.platform !== "win32") return [];
  const localRoots = [options.env.LOCALAPPDATA, (0, import_node_path.join)(options.home, "AppData", "Local")].filter((value) => typeof value === "string" && value !== "").filter((value, index, all) => all.indexOf(value) === index);
  return localRoots.flatMap((root) => (0, import_trae_discovery.traeWindowsAppNames)(edition).map((spelling) => (0, import_node_path.join)(root, "Programs", spelling, "resources", "app", "product.json")));
}
async function readTraeIdentity(candidate, options = {}) {
  const resolved = {
    platform: options.platform ?? process.platform,
    home: options.home ?? (0, import_node_os.homedir)(),
    env: options.env ?? process.env
  };
  let storage;
  try {
    const parsed = JSON.parse(await (0, import_promises.readFile)(candidate.path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    storage = parsed;
  } catch (error) {
    if (isFileMissing(error)) throw error;
    throw new Error(`Trae ${candidate.edition} storage is not a JSON object`);
  }
  const machineFile = nonEmpty(await (0, import_promises.readFile)((0, import_node_path.join)((0, import_node_path.dirname)((0, import_node_path.dirname)((0, import_node_path.dirname)(candidate.path))), "machineid"), "utf8").catch(() => ""));
  const telemetryMachine = nonEmpty(storage["telemetry.machineId"]);
  const machineId = telemetryMachine ?? machineFile;
  if (machineId === void 0) throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
  const centerId = traeDeviceCenterId(storage);
  const deviceId = centerId ?? nonEmpty(storage["telemetry.devDeviceId"]) ?? (0, import_node_crypto.createHash)("sha256").update(machineId).digest("hex").slice(0, 32);
  const buildVersion = nonEmpty(storage["iCubeLastVersion"]);
  let product = {};
  for (const path of productJsonPaths(candidate.edition, resolved)) {
    product = await readJsonFile(path) ?? {};
    if (Object.keys(product).length > 0) break;
  }
  const appVersion = nonEmpty(product["appVersion"]);
  const deviceBrand = resolved.platform === "darwin" ? nonEmpty(resolved.env["TRAE_DEVICE_BRAND"]) : void 0;
  const deviceCpu = deviceCpuOf();
  return {
    machineId,
    deviceId,
    ...centerId === void 0 ? { deviceIdIsFallback: true } : {},
    ...appVersion === void 0 ? {} : { appVersion },
    ...buildVersion === void 0 ? {} : { buildVersion },
    ...deviceBrand === void 0 ? {} : { deviceBrand },
    ...deviceCpu === void 0 ? {} : { deviceCpu },
    osVersion: osVersionOf(resolved.platform),
    platform: resolved.platform
  };
}
function isFileMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function pickTraeStorageIdentity(candidates, edition, options = {}) {
  const mine = candidates.filter((candidate) => candidate.edition === edition);
  let lastError;
  let anyPresent = false;
  for (const candidate of mine) {
    try {
      return await readTraeIdentity(candidate, options);
    } catch (error) {
      if (!isFileMissing(error)) {
        lastError = error;
        anyPresent = true;
      }
    }
  }
  const where = `${edition} desktop location(s)` + (mine.length === 0 ? " (none scanned)" : `, ${mine.length} checked`);
  if (!anyPresent) throw new Error(`${TRAE_STORAGE_MISSING_PREFIX} (${where})`);
  const code = typeof lastError === "object" && lastError !== null && "code" in lastError && typeof lastError.code === "string" ? lastError.code : "invalid storage";
  throw new Error(`Trae identity could not be resolved (${where}; ${code})`);
}
const CLI_HOME_BY_EDITION = {
  cn: ".trae-cn",
  solo: ".trae-cn",
  sg: ".trae",
  "solo-sg": ".trae"
};
async function readTraeCliIdentity(edition, options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? (0, import_node_os.homedir)();
  const env = options.env ?? process.env;
  const cliHome = (0, import_node_path.join)(home, CLI_HOME_BY_EDITION[edition]);
  const argv = await readJsonFile((0, import_node_path.join)(cliHome, "argv.json"));
  const version = await readJsonFile((0, import_node_path.join)(cliHome, "builtin", "ide_version.json"));
  if (argv === void 0 && version === void 0) {
    throw new Error("Trae CLI identity was not found (its home holds neither argv.json nor ide_version.json)");
  }
  const crashReporterId = nonEmpty(argv?.["crash-reporter-id"]);
  const hostName = nonEmpty((0, import_node_os.hostname)()) ?? "unknown-host";
  const user = nonEmpty(env["USERNAME"]) ?? nonEmpty(env["USER"]) ?? "unknown-user";
  const deviceId = crashReporterId ?? (0, import_node_crypto.createHash)("sha256").update(`trae-cli\0${hostName}\0${user}`).digest("hex").slice(0, 32);
  const machineId = (0, import_node_crypto.createHash)("sha256").update(`trae-cli-machine\0${deviceId}\0${hostName}`).digest("hex");
  const appVersion = nonEmpty(version?.["version"]);
  const deviceCpu = deviceCpuOf();
  return {
    machineId,
    deviceId,
    ...appVersion === void 0 ? {} : { appVersion },
    ...deviceCpu === void 0 ? {} : { deviceCpu },
    osVersion: osVersionOf(platform),
    platform
  };
}
async function resolveTraeIdentity(candidates, edition, options = {}) {
  try {
    return await pickTraeStorageIdentity(candidates, edition, options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(TRAE_STORAGE_MISSING_PREFIX)) throw error;
    return readTraeCliIdentity(edition, options);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TRAE_STORAGE_MISSING_PREFIX,
  pickTraeStorageIdentity,
  readTraeCliIdentity,
  readTraeIdentity,
  resolveTraeIdentity,
  traeDeviceCenterId
});
