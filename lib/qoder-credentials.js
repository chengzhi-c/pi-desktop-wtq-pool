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
var qoder_credentials_exports = {};
__export(qoder_credentials_exports, {
  QoderKeyError: () => QoderKeyError,
  discoverQoderCredentials: () => discoverQoderCredentials,
  parseQoderAuthSession: () => parseQoderAuthSession,
  readQoderCredential: () => readQoderCredential,
  resetQoderCredentialCache: () => resetQoderCredentialCache,
  unwrapQoderOscryptKey: () => unwrapQoderOscryptKey
});
module.exports = __toCommonJS(qoder_credentials_exports);
var import_node_child_process = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_qoder_discovery = require("./qoder-discovery");
const MACHINE_ID_NAMES = ["auth.machine-id", "machineid", "machineId"];
const oscryptKeyCache = /* @__PURE__ */ new Map();
const DPAPI_PREFIX = "DPAPI";
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XdpoolDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$inputText = [Console]::In.ReadToEnd().Trim()
$blob = [Convert]::FromBase64String($inputText)
$key = [XdpoolDpapi]::U($blob)
[Console]::Out.Write([Convert]::ToBase64String($key))
`;
class QoderKeyError extends Error {
  constructor(reason, message) {
    super(message ?? `Qoder OSCrypt key ${reason}`);
    this.reason = reason;
    this.name = "QoderKeyError";
  }
}
function powershellPath(env) {
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot === void 0 || systemRoot === "") return void 0;
  return (0, import_node_path.join)(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function childEnv(env) {
  const allowed = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"];
  const result = {};
  for (const name of allowed) {
    const value = env[name];
    if (typeof value === "string" && value !== "") result[name] = value;
  }
  return result;
}
async function unwrapQoderOscryptKey(localStatePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") throw new QoderKeyError("unsupported-platform", "Qoder OSCrypt unwrap needs Windows DPAPI");
  const stateText = await (0, import_promises.readFile)(localStatePath, "utf8");
  let encoded;
  try {
    const parsed = JSON.parse(stateText);
    const osCrypt = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed["os_crypt"] : void 0;
    encoded = typeof osCrypt === "object" && osCrypt !== null && !Array.isArray(osCrypt) ? osCrypt["encrypted_key"] : void 0;
  } catch {
    throw new QoderKeyError("invalid", "Qoder Local State is not JSON");
  }
  if (typeof encoded !== "string" || encoded === "") {
    throw new QoderKeyError("invalid", "Qoder Local State has no os_crypt.encrypted_key");
  }
  const blob = Buffer.from(encoded, "base64");
  try {
    if (blob.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX) {
      throw new QoderKeyError("invalid", "Qoder encrypted_key is not a DPAPI blob");
    }
    const payload = blob.subarray(DPAPI_PREFIX.length);
    if (payload.length === 0) throw new QoderKeyError("invalid", "Qoder encrypted_key is empty");
    let mtimeMs = 0;
    try {
      mtimeMs = (await (0, import_promises.stat)(localStatePath)).mtimeMs;
    } catch {
    }
    const cached = oscryptKeyCache.get(localStatePath);
    if (cached !== void 0 && cached.mtimeMs === mtimeMs) return Buffer.from(cached.key);
    const exe = powershellPath(env);
    if (exe === void 0) throw new QoderKeyError("unavailable", "SystemRoot is not set, cannot locate PowerShell");
    const stdout = await new Promise((resolve, reject) => {
      const child = (0, import_node_child_process.spawn)(exe, ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
        env: childEnv(env),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
      }, options.timeoutMs ?? 3e4);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new QoderKeyError("unavailable", String(error.message).slice(0, 200)));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new QoderKeyError("unavailable", `PowerShell exited ${code}: ${err.trim().slice(0, 160)}`));
      });
      child.stdin.end(payload.toString("base64"));
    });
    const key = Buffer.from(stdout.trim(), "base64");
    if (key.length !== 32) throw new QoderKeyError("invalid", "DPAPI unwrap did not yield a 32-byte key");
    oscryptKeyCache.set(localStatePath, { mtimeMs, key: Buffer.from(key) });
    return key;
  } finally {
    blob.fill(0);
  }
}
function parseQoderAuthSession(plaintext) {
  let session;
  try {
    session = JSON.parse(plaintext);
  } catch {
    return void 0;
  }
  if (typeof session !== "object" || session === null) return void 0;
  const record = session;
  const token = typeof record["token"] === "string" ? record["token"] : "";
  if (token === "") return void 0;
  const rawUser = record["user"];
  const user = typeof rawUser === "object" && rawUser !== null && !Array.isArray(rawUser) ? rawUser : {};
  const userID = typeof user["id"] === "string" ? user["id"] : "";
  if (userID === "") return void 0;
  const parsedExpiry = (value) => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value > 1e12 ? value : value * 1e3;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric > 0 ? numeric > 1e12 ? numeric : numeric * 1e3 : 0;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  };
  return {
    userID,
    name: typeof user["name"] === "string" ? user["name"] : "",
    email: typeof user["email"] === "string" ? user["email"] : "",
    token,
    expiresAtMs: parsedExpiry(record["expiresAt"])
  };
}
async function machineIdOf(appDir) {
  for (const name of MACHINE_ID_NAMES) {
    try {
      const text = (await (0, import_promises.readFile)((0, import_node_path.join)(appDir, name), "utf8")).trim();
      if (text !== "") return text;
    } catch {
    }
  }
  return void 0;
}
async function firstAuthBlob(paths) {
  for (const path of paths) {
    try {
      return await (0, import_promises.readFile)(path);
    } catch {
    }
  }
  return void 0;
}
async function readQoderCredential(candidates, options = {}) {
  const byKind = (kind) => candidates.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.path);
  const appDir = candidates[0]?.appDir ?? "";
  const region = candidates[0]?.region ?? "cn";
  const base = { region };
  const authBlob = await firstAuthBlob(byKind("auth-v1"));
  if (authBlob === void 0) return { failure: { ...base, reason: "no-auth" } };
  let key;
  try {
    const localState = byKind("local-state")[0];
    if (localState === void 0) throw new QoderKeyError("invalid", "no Local State candidate");
    key = await unwrapQoderOscryptKey(localState, options);
  } catch (error) {
    const reason = error instanceof QoderKeyError && error.reason === "unsupported-platform" ? "unsupported-platform" : "no-key";
    return { failure: { ...base, reason, ...error instanceof Error ? { message: error.message } : {} } };
  }
  try {
    const plain = (0, import_qoder_discovery.decryptQoderOscrypt)(authBlob, key);
    if (plain === void 0) return { failure: { ...base, reason: "undecryptable" } };
    const session = parseQoderAuthSession(plain);
    if (session === void 0) return { failure: { ...base, reason: "invalid" } };
    const machineID = await machineIdOf(appDir);
    return {
      credential: {
        ...base,
        ...session,
        ...machineID === void 0 ? {} : { machineID }
      }
    };
  } finally {
    key.fill(0);
  }
}
const DISCOVERY_TTL_MS = 3e4;
let discoveryCache;
function resetQoderCredentialCache() {
  discoveryCache = void 0;
}
async function discoverQoderCredentials(candidates) {
  const cacheable = candidates === void 0;
  if (cacheable && discoveryCache !== void 0 && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    const cached = discoveryCache.value;
    return { credentials: [...cached.credentials], failures: [...cached.failures] };
  }
  const value = await readQoderCredentials(candidates ?? (0, import_qoder_discovery.qoderStorageCandidates)());
  if (cacheable && value.credentials.length > 0) discoveryCache = { at: Date.now(), value };
  return { credentials: [...value.credentials], failures: [...value.failures] };
}
async function readQoderCredentials(candidates) {
  const byAppDir = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const list = byAppDir.get(candidate.appDir);
    if (list === void 0) byAppDir.set(candidate.appDir, [candidate]);
    else list.push(candidate);
  }
  const credentials = [];
  const failures = [];
  for (const group of byAppDir.values()) {
    const result = await readQoderCredential(group);
    if (result.credential !== void 0) {
      const fresh = result.credential;
      const at = credentials.findIndex((existing) => existing.region === fresh.region && existing.userID === fresh.userID);
      const incumbent = at === -1 ? void 0 : credentials[at];
      if (incumbent === void 0) {
        credentials.push(fresh);
      } else if (fresh.expiresAtMs > incumbent.expiresAtMs) {
        credentials[at] = fresh;
      }
    } else if (result.failure !== void 0 && result.failure.reason !== "no-auth") {
      failures.push(result.failure);
    }
  }
  return { credentials, failures };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QoderKeyError,
  discoverQoderCredentials,
  parseQoderAuthSession,
  readQoderCredential,
  resetQoderCredentialCache,
  unwrapQoderOscryptKey
});
