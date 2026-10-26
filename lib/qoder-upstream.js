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
var qoder_upstream_exports = {};
__export(qoder_upstream_exports, {
  QODER_GATEWAYS: () => QODER_GATEWAYS,
  buildCosyAuthHeaders: () => buildCosyAuthHeaders,
  encodeBody: () => encodeBody
});
module.exports = __toCommonJS(qoder_upstream_exports);
var import_node_crypto = require("node:crypto");
const QODER_GATEWAYS = {
  cn: "https://gateway.qoder.com.cn/",
  global: "https://api3.qoder.sh/"
};
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const COSY_VERSION = "1.1.38";
const CLIENT_TYPE = "5";
const MACHINE_TYPE = "5";
const DATA_POLICY = "disagree";
const LOGIN_VERSION = "v2";
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < table.length; i++) table[i] = i;
  for (let i = 0; i < STD_ALPHABET.length; i++) {
    table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  }
  table["=".charCodeAt(0)] = "$".charCodeAt(0);
  return table;
})();
function encodeByteAt(byte) {
  return ENCODE_TABLE[byte] ?? byte;
}
function encodeBody(plaintext) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const std = bytes.toString("base64");
  const n = std.length;
  const third = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - third; i < n; i++) out[dst++] = encodeByteAt(std.charCodeAt(i));
  for (let i = third; i < n - third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i));
  for (let i = 0; i < third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i));
  return out;
}
function signaturePath(url) {
  let path = new URL(url).pathname;
  if (path.startsWith("/algo")) path = path.slice("/algo".length);
  return path;
}
function qoderMachineOs(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  if (platform === "darwin") return arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  return arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}
function aesEncryptCBCBase64(plaintext, keyString) {
  const key = Buffer.from(keyString);
  const cipher = (0, import_node_crypto.createCipheriv)("aes-128-cbc", key, key);
  return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}
function buildCosyAuthHeaders(body, url, credential) {
  const aesKey = (0, import_node_crypto.randomUUID)().replace(/-/g, "").slice(0, 16);
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: credential.userID,
      security_oauth_token: credential.token,
      name: credential.name ?? "",
      aid: "",
      email: credential.email ?? ""
    }),
    aesKey
  );
  const cosyKey = (0, import_node_crypto.publicEncrypt)(
    { key: QODER_RSA_PUBLIC_KEY, padding: import_node_crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey)
  ).toString("base64");
  const timestamp = Math.floor(Date.now() / 1e3).toString();
  const requestId = (0, import_node_crypto.randomUUID)();
  const payloadB64 = Buffer.from(JSON.stringify({
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: COSY_VERSION,
    ideVersion: ""
  })).toString("base64");
  const path = signaturePath(url);
  const bodyBytes = body;
  const sig = (0, import_node_crypto.createHash)("md5").update(payloadB64).update("\n").update(cosyKey).update("\n").update(timestamp).update("\n").update(bodyBytes).update("\n").update(path).digest("hex");
  const machineID = credential.machineID ?? "";
  return {
    "Authorization": `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": credential.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": MACHINE_TYPE,
    "Cosy-Machineos": qoderMachineOs(),
    "Cosy-Clienttype": CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": (0, import_node_crypto.createHash)("md5").update(bodyBytes).digest("hex"),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": path,
    "Cosy-Data-Policy": DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": LOGIN_VERSION,
    "X-Request-Id": (0, import_node_crypto.randomUUID)()
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QODER_GATEWAYS,
  buildCosyAuthHeaders,
  encodeBody
});
