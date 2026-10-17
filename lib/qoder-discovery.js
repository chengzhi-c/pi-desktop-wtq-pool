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
var qoder_discovery_exports = {};
__export(qoder_discovery_exports, {
  decryptQoderOscrypt: () => decryptQoderOscrypt,
  qoderStorageCandidates: () => qoderStorageCandidates
});
module.exports = __toCommonJS(qoder_discovery_exports);
var import_node_crypto = require("node:crypto");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
const QODER_CN_APP_NAMES = ["com.qodercn.app.stable", "QoderCN", "Qoder CN", "QoderWork CN"];
const QODER_GLOBAL_APP_NAMES = ["com.qoder.app.stable", "Qoder", "QoderWork"];
function qoderAppDataRootFor(platform = process.platform, env = process.env, home = (0, import_node_os.homedir)()) {
  if (platform === "win32") {
    const roaming = env["APPDATA"]?.trim();
    return roaming === void 0 || roaming === "" ? (0, import_node_path.join)(home, "AppData", "Roaming") : roaming;
  }
  if (platform === "darwin") return (0, import_node_path.join)(home, "Library", "Application Support");
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg.length > 0) return xdg;
  return (0, import_node_path.join)(home, ".config");
}
function qoderStorageCandidates(platform = process.platform, home = (0, import_node_os.homedir)(), env = process.env) {
  const root = qoderAppDataRootFor(platform, env, home);
  let roots;
  if (platform === "win32") {
    const fallback = (0, import_node_path.join)(home, "AppData", "Roaming");
    roots = [root, fallback].filter((value, index, all) => all.indexOf(value) === index);
  } else {
    roots = [root];
  }
  const apps = [
    ...QODER_CN_APP_NAMES.map((appName) => ({ appName, region: "cn" })),
    ...QODER_GLOBAL_APP_NAMES.map((appName) => ({ appName, region: "global" }))
  ];
  const result = [];
  for (const rootDir of roots) {
    for (const { appName, region } of apps) {
      const appDir = (0, import_node_path.join)(rootDir, appName);
      result.push({ region, appName, appDir, path: (0, import_node_path.join)(appDir, "Local State"), kind: "local-state" });
      result.push({ region, appName, appDir, path: (0, import_node_path.join)(appDir, "auth.v1.dat"), kind: "auth-v1" });
    }
  }
  return result;
}
function decryptQoderOscrypt(blob, key) {
  if (blob.length < 3 + 12 + 16) return void 0;
  if (blob.subarray(0, 3).toString("latin1") !== "v10") return void 0;
  const body = blob.subarray(3);
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(12, body.length - 16);
  try {
    const decipher = (0, import_node_crypto.createDecipheriv)("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decryptQoderOscrypt,
  qoderStorageCandidates
});
