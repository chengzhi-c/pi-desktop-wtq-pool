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
var trae_discovery_exports = {};
__export(trae_discovery_exports, {
  discoverTraeCredentials: () => discoverTraeCredentials,
  normalizeTraeCredential: () => normalizeTraeCredential,
  resetTraeCredentialCache: () => resetTraeCredentialCache,
  traeMacAppName: () => traeMacAppName,
  traeRegionOfCredential: () => traeRegionOfCredential,
  traeStorageCandidates: () => traeStorageCandidates,
  traeWindowsAppNames: () => traeWindowsAppNames
});
module.exports = __toCommonJS(trae_discovery_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
const TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
const TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
const CLI_DEFAULT_HOST = "https://api.trae.cn";
const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209]);
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170]);
function xor(a, b) {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}
function encryptionType(header) {
  if (header.equals(Buffer.from([116, 99, 5, 16, 0, 0]))) return "aes";
  if (header.equals(Buffer.from([18, 57, 32, 32, 2, 3]))) return "aes-private";
  throw new Error("unsupported Trae auth encryption header");
}
function decryptTraeStorageValue(encoded) {
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length <= 102) throw new Error("Trae auth ciphertext is too short");
  const type = encryptionType(buffer.subarray(0, 6));
  const random = buffer.subarray(6, 38);
  const encrypted = buffer.subarray(38);
  const salt = type === "aes-private" ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
  const first = (0, import_node_crypto.createHash)("sha512").update(random).digest();
  const derived = (0, import_node_crypto.createHash)("sha512").update(Buffer.concat([first, salt])).digest();
  const decipher = (0, import_node_crypto.createDecipheriv)("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length < 64) throw new Error("Trae auth plaintext is too short");
  const expected = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const actual = (0, import_node_crypto.createHash)("sha512").update(plaintext).digest();
  if (!expected.equals(actual)) throw new Error("Trae auth integrity check failed");
  return plaintext.toString("utf8");
}
function parseTraeAuthValue(value) {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("Trae auth value is empty");
  const plaintext = trimmed.startsWith("{") ? trimmed : decryptTraeStorageValue(trimmed);
  return JSON.parse(plaintext);
}
function parseTraeStorageDocument(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Trae storage document must be an object");
  }
  const value = parsed[TRAE_AUTH_STORAGE_KEY];
  if (typeof value !== "string") throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`);
  return parseTraeAuthValue(value);
}
function decodeBase64UrlJson(segment) {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function parseTraeCliToken(text) {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Trae CLI token file is empty");
  let token = trimmed;
  if (trimmed.startsWith("{")) {
    const envelope = JSON.parse(trimmed);
    const candidate = envelope["token"] ?? envelope["accessToken"] ?? envelope["jwt"];
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new Error("Trae CLI token document has no token field");
    }
    token = candidate.trim();
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) {
    throw new Error("Trae CLI token is not a three-part JWT");
  }
  const payload = decodeBase64UrlJson(segments[1]);
  if (payload === void 0) throw new Error("Trae CLI token payload is not decodable JSON");
  const data = typeof payload["data"] === "object" && payload["data"] !== null && !Array.isArray(payload["data"]) ? payload["data"] : void 0;
  const userId = typeof data?.["user_id"] === "string" ? data["user_id"] : void 0;
  if (userId === void 0 || userId === "") throw new Error("Trae CLI token has no data.user_id claim");
  const exp = payload["exp"];
  const expiresAtMs = typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1e3 : void 0;
  return { accessToken: token, userId, ...expiresAtMs === void 0 ? {} : { expiresAtMs } };
}
function traeRegionOfEdition(edition) {
  return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
function traeRegionOfUserRegion(value) {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
  if (typeof raw !== "string") return void 0;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "cn") return "cn";
  if (lowered === "sg" || lowered === "ai") return "ai";
  return void 0;
}
function traeRegionOfHost(host) {
  if (host === void 0) return void 0;
  const trimmed = host.trim();
  if (trimmed === "") return void 0;
  let hostname;
  try {
    hostname = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return void 0;
  }
  if (hostname === "trae.ai" || hostname.endsWith(".trae.ai")) return "ai";
  if (hostname === "trae.cn" || hostname.endsWith(".trae.cn") || hostname.endsWith(".trae.com.cn")) return "cn";
  return void 0;
}
function traeRegionOfCredential(credential) {
  return traeRegionOfUserRegion(credential.userRegion) ?? traeRegionOfHost(credential.host) ?? traeRegionOfEdition(credential.edition);
}
function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function timeToMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1e3;
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1e3;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function userRegionOf(value) {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
}
function normalizeTraeCredential(raw, edition, source) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
  const value = raw;
  const accessToken = optionalString(value["token"]) ?? optionalString(value["accessToken"]);
  if (accessToken === void 0) return void 0;
  const account = typeof value["account"] === "object" && value["account"] !== null && !Array.isArray(value["account"]) ? value["account"] : void 0;
  return {
    accessToken,
    userId: optionalString(value["userId"]) ?? "",
    ...optionalString(account?.["username"]) === void 0 ? {} : { accountName: optionalString(account?.["username"]) },
    ...optionalString(account?.["email"]) === void 0 ? {} : { email: optionalString(account?.["email"]) },
    host: optionalString(value["host"]) ?? "",
    ...userRegionOf(value["userRegion"]) === void 0 ? {} : { userRegion: userRegionOf(value["userRegion"]) },
    expiresAtMs: timeToMs(value["expiredAt"] ?? value["expiresAt"]) ?? 0,
    edition,
    source
  };
}
function traeAccountKey(credential) {
  const region = traeRegionOfCredential(credential);
  const userId = credential.userId.trim();
  if (userId !== "") return `id:${region}:${userId}`;
  return `name:${region}\0${credential.accountName ?? credential.email ?? ""}`;
}
function preferredTraeCredential(left, right) {
  if (left.expiresAtMs !== right.expiresAtMs) return left.expiresAtMs > right.expiresAtMs ? left : right;
  const rank = (credential) => (credential.source === "desktop" ? 2 : 0) + (credential.accountName ?? credential.email ? 1 : 0);
  return rank(left) >= rank(right) ? left : right;
}
const WINDOWS_APP_NAMES = {
  cn: ["Trae CN", "trae-cn"],
  sg: ["Trae"],
  solo: ["TRAE SOLO CN", "trae-solo-cn"],
  "solo-sg": ["TRAE SOLO"]
};
const LINUX_APP_NAMES = {
  // The `cn` list carries the bare `trae` spellings because a domestic install
  // on a case-sensitive filesystem is reachable under either of them. The `sg`
  // list repeats them on purpose: an international install lives at exactly
  // those paths on Linux, and dropping them would stop discovering it. What
  // keeps one install from becoming two credentials is the path dedupe in
  // {@link traeStorageCandidates}, which probes each file once.
  cn: ["trae-cn", "Trae CN", "trae", "Trae"],
  sg: ["trae", "Trae"],
  solo: ["trae-solo-cn", "TRAE SOLO CN"],
  "solo-sg": ["trae-solo", "TRAE SOLO"]
};
const MAC_APP_NAMES = {
  cn: "Trae CN",
  sg: "Trae",
  solo: "TRAE SOLO CN",
  "solo-sg": "TRAE SOLO"
};
function traeMacAppName(edition) {
  return MAC_APP_NAMES[edition];
}
function traeWindowsAppNames(edition) {
  return WINDOWS_APP_NAMES[edition];
}
const CLI_HOME_NAMES = [".trae-cn", ".trae"];
function traeCliCandidates(platform, home, env) {
  const roots = [];
  if (platform === "win32") {
    for (const value of [env.USERPROFILE, home]) {
      if (typeof value === "string" && value !== "" && !roots.includes(value)) roots.push(value);
    }
  } else {
    roots.push(home);
  }
  const result = [];
  for (const root of roots) {
    for (const name of CLI_HOME_NAMES) {
      result.push({ edition: name === ".trae-cn" ? "cn" : "sg", path: (0, import_node_path.join)(root, name, TRAE_CLI_TOKEN_FILENAME), source: "cli" });
    }
  }
  return result;
}
function traeStorageCandidates(platform = process.platform, home = (0, import_node_os.homedir)(), env = process.env) {
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const edition of ["cn", "sg", "solo", "solo-sg"]) {
    let roots;
    let appNames;
    if (platform === "darwin") {
      roots = [(0, import_node_path.join)(home, "Library", "Application Support")];
      appNames = [MAC_APP_NAMES[edition]];
    } else if (platform === "win32") {
      roots = [env.APPDATA, (0, import_node_path.join)(home, "AppData", "Roaming")].filter((value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index);
      appNames = WINDOWS_APP_NAMES[edition];
    } else if (platform === "linux") {
      roots = [env.XDG_CONFIG_HOME || (0, import_node_path.join)(home, ".config")];
      appNames = LINUX_APP_NAMES[edition];
    } else {
      roots = [];
      appNames = [MAC_APP_NAMES[edition]];
    }
    for (const root of roots) {
      for (const appName of appNames) {
        const path = (0, import_node_path.join)(root, appName, "User", "globalStorage", "storage.json");
        if (seen.has(path)) continue;
        seen.add(path);
        result.push({ edition, path, source: "desktop" });
      }
    }
  }
  return [...result, ...traeCliCandidates(platform, home, env)];
}
function failureOf(candidate, error) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
  if (code === "ENOENT") return { path: candidate.path, edition: candidate.edition, source: candidate.source, reason: "missing" };
  if (error instanceof Error && code !== void 0) {
    return { path: candidate.path, edition: candidate.edition, source: candidate.source, reason: "unreadable", message: error.message };
  }
  return {
    path: candidate.path,
    edition: candidate.edition,
    source: candidate.source,
    reason: code === void 0 ? "invalid" : "unreadable",
    message: error instanceof Error ? error.message : String(error)
  };
}
function credentialFrom(candidate, text) {
  let credential;
  if (candidate.source === "cli") {
    if (traeRegionOfEdition(candidate.edition) !== "cn") {
      throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`);
    }
    const claims = parseTraeCliToken(text);
    credential = normalizeTraeCredential({
      token: claims.accessToken,
      userId: claims.userId,
      host: CLI_DEFAULT_HOST,
      expiredAt: claims.expiresAtMs
    }, candidate.edition, "cli");
  } else {
    credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, "desktop");
  }
  if (credential === void 0) throw new Error(`${candidate.source} candidate could not be normalized into a credential`);
  return credential;
}
const DISCOVERY_TTL_MS = 3e4;
let discoveryCache;
function resetTraeCredentialCache() {
  discoveryCache = void 0;
}
async function discoverTraeCredentials(candidates) {
  const cacheable = candidates === void 0;
  if (cacheable && discoveryCache !== void 0 && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    const cached = discoveryCache.value;
    return { credentials: [...cached.credentials], failures: [...cached.failures] };
  }
  const value = await readTraeCredentials(candidates ?? traeStorageCandidates());
  if (cacheable && value.credentials.length > 0) discoveryCache = { at: Date.now(), value };
  return { credentials: [...value.credentials], failures: [...value.failures] };
}
async function readTraeCredentials(candidates) {
  const byAccount = /* @__PURE__ */ new Map();
  const failures = [];
  for (const candidate of candidates) {
    let text;
    try {
      text = await (0, import_promises.readFile)(candidate.path, "utf8");
    } catch (error) {
      const failure = failureOf(candidate, error);
      if (failure.reason !== "missing") failures.push(failure);
      continue;
    }
    try {
      const credential = credentialFrom(candidate, text);
      const key = traeAccountKey(credential);
      const existing = byAccount.get(key);
      byAccount.set(key, existing === void 0 ? credential : preferredTraeCredential(existing, credential));
    } catch (error) {
      failures.push(failureOf(candidate, error));
    }
  }
  return { credentials: [...byAccount.values()], failures };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  discoverTraeCredentials,
  normalizeTraeCredential,
  resetTraeCredentialCache,
  traeMacAppName,
  traeRegionOfCredential,
  traeStorageCandidates,
  traeWindowsAppNames
});
