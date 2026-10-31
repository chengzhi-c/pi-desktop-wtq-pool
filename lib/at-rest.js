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
var at_rest_exports = {};
__export(at_rest_exports, {
  WORKBUDDY_APP_EXECUTABLE_ENV: () => WORKBUDDY_APP_EXECUTABLE_ENV,
  atRestKeyFailure: () => atRestKeyFailure,
  encryptedFieldOpener: () => encryptedFieldOpener,
  isEncryptedFieldWrapper: () => isEncryptedFieldWrapper,
  openEncryptedField: () => openEncryptedField,
  scanInterpreter: () => scanInterpreter,
  signatureAccepts: () => signatureAccepts,
  signatureScanEnv: () => signatureScanEnv
});
module.exports = __toCommonJS(at_rest_exports);
var import_node_crypto = require("node:crypto");
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const KEY_FETCH_TIMEOUT_MS = 3e4;
const KEY_FAILURE_BACKOFF_MS = 6e4;
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
const WORKBUDDY_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";
function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed("WBEV1"),
    encodeLengthPrefixed("sym-v1"),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0])
  ]);
}
function isEncryptedFieldWrapper(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const wrapper = value;
  const keys = Object.keys(wrapper).sort();
  return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope" && wrapper["$wbEncrypted"] === 1 && typeof wrapper["envelope"] === "string";
}
function deriveAtRestKeyId(key) {
  return (0, import_node_crypto.createHash)("sha256").update(key).digest("hex").slice(0, 16);
}
function deriveAtRestKey(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("workbuddy: at-rest key payload is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("workbuddy: at-rest key payload is not an object");
  }
  const secret = payload["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") {
    throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
  }
  return (0, import_node_crypto.createHash)("sha256").update(secret, "utf8").digest();
}
function encryptedFieldKeyId(field) {
  try {
    const record = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
    return typeof record["keyId"] === "string" ? record["keyId"] : void 0;
  } catch {
    return void 0;
  }
}
function openEncryptedField(field, key) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
  } catch {
    throw new Error("workbuddy: encrypted field envelope is not valid JSON");
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("workbuddy: encrypted field envelope is not an object");
  }
  const record = envelope;
  const suite = record["suite"];
  const keyId = record["keyId"];
  const nonce = record["nonce"];
  const authTag = record["authTag"];
  const ciphertext = record["ciphertext"];
  if (typeof suite !== "number" || typeof keyId !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
  }
  if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
  }
  const expectedKeyId = deriveAtRestKeyId(key);
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
  }
  const decipher = (0, import_node_crypto.createDecipheriv)("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
function cleanIconPath(raw) {
  return raw.replace(/^"/u, "").replace(/",-?\d+$/u, "").replace(/,-?\d+$/u, "").trim();
}
function localWindowsPath(candidate) {
  return /^[A-Za-z]:[\\/]/u.test(candidate);
}
function windowsRegistryAppPaths() {
  if (process.platform !== "win32") return [];
  const cached = registryAppPaths;
  if (cached !== void 0) {
    if (cached.length > 0 && statExecutables(cached).length > 0) return cached;
    if (Date.now() - registryScannedAtMs < KEY_FAILURE_BACKOFF_MS) return [];
  }
  registryAppPaths = readRegistryAppPaths();
  registryScannedAtMs = Date.now();
  return registryAppPaths;
}
function systemRootOf(env) {
  const value = env["SystemRoot"]?.trim() || env["windir"]?.trim();
  return value === void 0 || value === "" ? void 0 : value;
}
function signatureScanEnv(env = process.env) {
  const systemRoot = systemRootOf(env);
  const ambient = env["PSModulePath"];
  const modules = systemRoot === void 0 ? void 0 : (0, import_node_path.join)(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules");
  if (modules === void 0) return { ...env };
  if (ambient === modules || ambient?.startsWith(`${modules};`) === true) return { ...env };
  return { ...env, PSModulePath: ambient === void 0 || ambient === "" ? modules : `${modules};${ambient}` };
}
function scanInterpreter(env) {
  const systemRoot = systemRootOf(env);
  if (systemRoot === void 0) return void 0;
  return (0, import_node_path.join)(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function readRegistryAppPaths() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
    "function Clean([string]$v) {",
    "  $v = $v.Trim()",
    `  if ($v.Length -ge 2 -and $v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length - 2) }`,
    "  $v = $v.Trim()",
    '  $i = $v.LastIndexOf(",")',
    '  if ($i -gt 0 -and $v.Substring($i + 1) -match "^[0-9]+$") { $v = $v.Substring(0, $i) }',
    "  return $v",
    "}",
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$out = foreach($r in $roots){",
    "  Get-ItemProperty -Path $r | ForEach-Object {",
    "    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation",
    "    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
    "      foreach($raw in @($di,$il)){",
    "        $p = Clean $raw",
    "        if($p -eq ''){ continue }",
    "        Write-Output $p",
    "      }",
    "    }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($out) -Compress"
  ].join("\n");
  let stdout;
  const interpreter = scanInterpreter(process.env);
  if (interpreter === void 0) return [];
  try {
    stdout = (0, import_node_child_process.execFileSync)(interpreter, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], { encoding: "utf8", timeout: 2e4, windowsHide: true, maxBuffer: 8388608, env: signatureScanEnv() });
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const cleaned = cleanIconPath(entry);
    if (cleaned === "" || !localWindowsPath(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}
function signatureAccepts(status, signer) {
  return status === "Valid" && signer !== void 0 && signer.trim() !== "";
}
let signatureScanFailure = "";
async function signedExecutables(candidates) {
  if (process.platform !== "win32" || candidates.length === 0) return candidates;
  signatureScanFailure = "";
  const interpreter = scanInterpreter(process.env);
  if (interpreter === void 0) {
    signatureScanFailure = "the signature check could not run: Windows PowerShell was not found";
    return [];
  }
  const payload = Buffer.from(JSON.stringify(candidates), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
    `$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$out = foreach ($p in @($paths)) {",
    "  if ([string]::IsNullOrWhiteSpace([string]$p)) { continue }",
    "  $s = $null",
    "  try { $s = Get-AuthenticodeSignature -LiteralPath ([string]$p) } catch { $s = $null }",
    "  [pscustomobject]@{",
    "    path = [string]$p",
    '    status = if ($s -ne $null) { [string]$s.Status } else { "" }',
    '    signer = if ($s -ne $null -and $s.SignerCertificate -ne $null) { [string]$s.SignerCertificate.Subject } else { "" }',
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($out) -Compress"
  ].join("\n");
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      (0, import_node_child_process.execFile)(interpreter, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ], { encoding: "utf8", timeout: 2e4, windowsHide: true, maxBuffer: 8388608, env: signatureScanEnv() }, (error, output) => {
        if (error !== null) reject(error);
        else resolve(output);
      });
    });
  } catch {
    signatureScanFailure = "the signature check could not run";
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    signatureScanFailure = "the signature check returned no readable answer";
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const accepted = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry;
    const file = record["path"];
    const status = record["status"];
    const signer = record["signer"];
    if (typeof file !== "string" || file === "") continue;
    if (!signatureAccepts(
      typeof status === "string" ? status : void 0,
      typeof signer === "string" ? signer : void 0
    )) continue;
    accepted.push(file);
  }
  return accepted;
}
function statExecutables(candidates) {
  const files = [];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    if (process.platform === "win32" && !localWindowsPath(candidate)) continue;
    try {
      if ((0, import_node_fs.statSync)(candidate, { throwIfNoEntry: false })?.isFile() === true) files.push(candidate);
    } catch {
    }
  }
  return files;
}
async function executableCandidates(env = process.env) {
  const override = env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim();
  const known = override === void 0 ? [] : [override];
  if (process.platform === "win32") {
    const local = env["LOCALAPPDATA"]?.trim();
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], local === void 0 || local === "" ? (0, import_node_path.join)((0, import_node_os.homedir)(), "AppData", "Local", "Programs") : (0, import_node_path.join)(local, "Programs")];
    for (const root of roots) {
      if (!root) continue;
      for (const name of APP_EXECUTABLE_NAMES) {
        known.push((0, import_node_path.join)(root, "WorkBuddy", name));
        known.push((0, import_node_path.join)(root, "WorkBuddy AI", name));
      }
    }
  } else if (process.platform === "darwin") {
    const home = (0, import_node_os.homedir)();
    for (const bundle of ["WorkBuddy.app", "WorkBuddy AI.app"]) {
      for (const base of ["/Applications", (0, import_node_path.join)(home, "Applications")]) {
        known.push((0, import_node_path.join)(base, bundle, "Contents", "MacOS", "Electron"));
      }
    }
  }
  const standard = await signedExecutables(statExecutables(known));
  if (standard.length > 0 || process.platform !== "win32") return standard;
  return signedExecutables(statExecutables(windowsRegistryAppPaths()));
}
function fetchAtRestKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    (0, import_node_child_process.execFile)(executable, ["-e", "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: KEY_FETCH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1048576
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`));
        return;
      }
      const payload = stdout.trim();
      if (payload === "") {
        reject(new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
        return;
      }
      resolve(payload);
    });
  });
}
const atRestKeyById = /* @__PURE__ */ new Map();
let registryAppPaths;
let registryScannedAtMs = 0;
let inflightKeys;
let lastKeyFailureAtMs = 0;
let lastKeyFailure = "";
let lastKeyRotationAtMs = 0;
function atRestKeyFailure() {
  return atRestKeyById.size > 0 ? "" : lastKeyFailure;
}
function invalidateAtRestKeys() {
  if (Date.now() - lastKeyRotationAtMs < KEY_FAILURE_BACKOFF_MS) return;
  lastKeyRotationAtMs = Date.now();
  atRestKeyById.clear();
  lastKeyFailureAtMs = 0;
  lastKeyFailure = "";
}
function ensureAtRestKeys() {
  if (atRestKeyById.size > 0) return Promise.resolve();
  if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve();
  inflightKeys ??= (async () => {
    const candidates = await executableCandidates();
    if (candidates.length === 0) {
      lastKeyFailureAtMs = Date.now();
      lastKeyFailure = process.platform === "win32" ? signatureScanFailure !== "" ? signatureScanFailure : "no WorkBuddy executable with a valid signature was found" : "no WorkBuddy executable found in the standard install roots";
      return;
    }
    let anySuccess = false;
    let lastReason = "";
    await Promise.all(candidates.map(async (executable) => {
      try {
        const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable));
        atRestKeyById.set(deriveAtRestKeyId(key), key);
        anySuccess = true;
      } catch (error) {
        lastReason = String(error instanceof Error ? error.message : error).slice(0, 200);
      }
    }));
    lastKeyFailure = anySuccess ? "" : lastReason;
    lastKeyFailureAtMs = anySuccess ? 0 : Date.now();
  })().finally(() => {
    inflightKeys = void 0;
  });
  return inflightKeys;
}
async function encryptedFieldOpener() {
  await ensureAtRestKeys();
  if (atRestKeyById.size === 0) return void 0;
  return (value) => {
    if (!isEncryptedFieldWrapper(value)) throw new Error("workbuddy: not an encrypted field wrapper");
    const keyId = encryptedFieldKeyId(value);
    if (keyId === void 0) throw new Error("workbuddy: encrypted field has no key id");
    const key = atRestKeyById.get(keyId);
    if (key === void 0) {
      invalidateAtRestKeys();
      throw new Error("workbuddy: no at-rest key available for this encrypted field");
    }
    return openEncryptedField(value, key);
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WORKBUDDY_APP_EXECUTABLE_ENV,
  atRestKeyFailure,
  encryptedFieldOpener,
  isEncryptedFieldWrapper,
  openEncryptedField,
  scanInterpreter,
  signatureAccepts,
  signatureScanEnv
});
