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
var accounts_exports = {};
__export(accounts_exports, {
  POOL_HOLD_MS: () => POOL_HOLD_MS,
  WorkBuddyAccountPool: () => WorkBuddyAccountPool,
  candidateAuthDirs: () => candidateAuthDirs,
  ownSignInDir: () => ownSignInDir,
  parseWorkBuddyAuth: () => parseWorkBuddyAuth,
  renewOwnSignInFile: () => renewOwnSignInFile,
  workbuddyAccountId: () => workbuddyAccountId,
  writeOwnSignIn: () => writeOwnSignIn
});
module.exports = __toCommonJS(accounts_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_upstream = require("./upstream");
var import_at_rest = require("./at-rest");
var import_log = require("./log");
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
const WORKBUDDY_GLOBAL_LIVE_FILENAME = "workbuddy-desktop-ai.info";
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
const ARCHIVE_FILENAME = "credentials-archive.json";
const OWN_SIGN_IN_DIRNAME = "signins";
const DELETED_SIGN_INS_FILENAME = "deleted-signins.json";
const OWN_SIGN_IN_PREFIX = "workbuddy-panel-";
const DELETE_SCAN_WAIT_MS = 5e3;
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
function nonEmptyEnv(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function defaultDesktopAuthDirs(platform = process.platform, home = (0, import_node_os.homedir)(), env = process.env) {
  if (platform === "darwin") {
    return [(0, import_node_path.join)(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  if (platform === "win32") {
    const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? (0, import_node_path.join)(home, "AppData", "Local");
    const roaming = nonEmptyEnv(env["APPDATA"]) ?? (0, import_node_path.join)(home, "AppData", "Roaming");
    return [
      (0, import_node_path.join)(local, "CodeBuddyExtension", "Data", "Public", "auth"),
      (0, import_node_path.join)(roaming, "CodeBuddyExtension", "Data", "Public", "auth")
    ];
  }
  if (platform === "linux") {
    const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? (0, import_node_path.join)(home, ".config");
    return [(0, import_node_path.join)(config, "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  return [];
}
const MAX_EXPIRY_MS = 41024448e5;
function expiryToMs(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ms = value > 1e12 ? value : value * 1e3;
  return ms > MAX_EXPIRY_MS ? 0 : ms;
}
function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
async function raceWithTimeout(work, budgetMs) {
  let timer;
  const timeout = new Promise((resolve2) => {
    timer = setTimeout(() => resolve2(false), budgetMs);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
function parseWorkBuddyAuth(text, sourcePath, decrypt) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const document = parsed;
  let auth;
  let identity;
  if (typeof document["auth"] === "object" && document["auth"] !== null) {
    auth = document["auth"];
    identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
  } else {
    auth = document;
    identity = document;
  }
  const accessToken = decryptableString(auth["accessToken"], decrypt);
  if (accessToken === "") return void 0;
  const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
  const refreshToken = decryptableString(auth["refreshToken"], decrypt);
  const refreshExpired = refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now();
  const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
  const nickname = optionalString(decryptableString(identity["nickname"], decrypt));
  return {
    accessToken,
    refreshToken: refreshExpired ? "" : refreshToken,
    expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
    ...refreshExpiresAtMs === void 0 || refreshExpired ? {} : { refreshExpiresAtMs },
    ...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
    ...nickname === void 0 ? {} : { nickname },
    ...optionalString(identity["uin"]) === void 0 ? {} : { uin: optionalString(identity["uin"]) },
    ...optionalString(identity["uid"]) === void 0 ? {} : { uid: optionalString(identity["uid"]) },
    ...optionalString(identity["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString(identity["enterpriseId"]) },
    domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
    sourcePath
  };
}
function decryptableString(value, decrypt) {
  if (typeof value === "string") return value;
  if ((0, import_at_rest.isEncryptedFieldWrapper)(value) && decrypt !== void 0) {
    try {
      return decrypt(value);
    } catch {
    }
  }
  return "";
}
function isLiveAuthFile(path) {
  const name = (0, import_node_path.basename)(path);
  return name === WORKBUDDY_LIVE_FILENAME || name === WORKBUDDY_GLOBAL_LIVE_FILENAME;
}
function compareFreshness(a, b, ownDir) {
  const aIssued = a.lastRefreshAtMs ?? 0;
  const bIssued = b.lastRefreshAtMs ?? 0;
  if (aIssued !== bIssued && aIssued > 0 && bIssued > 0) return bIssued - aIssued;
  const aRank = credentialRank(a, ownDir);
  const bRank = credentialRank(b, ownDir);
  if (aIssued > 0 !== bIssued > 0) {
    if (aIssued > 0 && aRank <= 1) return -1;
    if (bIssued > 0 && bRank <= 1) return 1;
  }
  if (aRank !== bRank) return aRank - bRank;
  if (aIssued !== bIssued) return bIssued - aIssued;
  return b.expiresAtMs - a.expiresAtMs;
}
function credentialRank(credential, ownDir) {
  if (isLiveAuthFile(credential.sourcePath)) return 0;
  if (ownSignInPath(credential.sourcePath, ownDir)) return 1;
  return 2;
}
function isFresher(candidate, incumbent, ownDir) {
  return compareFreshness(candidate, incumbent, ownDir) < 0;
}
function compareQueueOrder(a, b, ownDir) {
  const aRank = credentialRank(a, ownDir);
  const bRank = credentialRank(b, ownDir);
  if (aRank !== bRank) return aRank - bRank;
  const aIssued = a.lastRefreshAtMs ?? 0;
  const bIssued = b.lastRefreshAtMs ?? 0;
  if (aIssued !== bIssued) return bIssued - aIssued;
  return b.expiresAtMs - a.expiresAtMs;
}
function tokenDigest(accessToken) {
  return (0, import_node_crypto.createHash)("sha256").update(`workbuddy\0deleted\0${accessToken}`).digest("hex").slice(0, 32);
}
async function signInFileStamp(file) {
  try {
    const entry = await (0, import_promises.stat)(file);
    return `${entry.mtimeMs}:${entry.size}`;
  } catch {
    return "";
  }
}
async function withFileLock(lock, work) {
  let held = false;
  for (let attempt = 0; attempt < 25 && !held; attempt += 1) {
    try {
      await (0, import_promises.writeFile)(lock, "", { flag: "wx", mode: 384 });
      held = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") break;
      const age = await (0, import_promises.stat)(lock).then((entry) => Date.now() - entry.mtimeMs, () => 0);
      if (age > 5e3) {
        await (0, import_promises.unlink)(lock).catch(() => {
        });
        continue;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 10));
    }
  }
  try {
    await work();
  } finally {
    if (held) await (0, import_promises.unlink)(lock).catch(() => {
    });
  }
}
async function readDeletedSignInsFile(file) {
  const parsed = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
  const tombstones = /* @__PURE__ */ new Map();
  const entries = parsed?.entries;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return tombstones;
  for (const [id, value] of Object.entries(entries)) {
    const entry = value;
    if (entry === null || typeof entry !== "object") continue;
    const digest = entry.tokenDigest;
    if (typeof digest !== "string" || digest === "") continue;
    const issued = entry.lastRefreshAtMs;
    const deletedAt = entry.deletedAtMs;
    tombstones.set(id, {
      tokenDigest: digest,
      lastRefreshAtMs: typeof issued === "number" && Number.isFinite(issued) ? issued : 0,
      deletedAtMs: typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : 0
    });
  }
  return tombstones;
}
function endsTombstone(tombstone, credential) {
  if (tokenDigest(credential.accessToken) === tombstone.tokenDigest) return false;
  const issued = credential.lastRefreshAtMs ?? 0;
  if (tombstone.lastRefreshAtMs > 0 && issued > 0) return issued > tombstone.lastRefreshAtMs;
  if (tombstone.lastRefreshAtMs === 0 && issued > 0) return issued >= tombstone.deletedAtMs;
  return isLiveAuthFile(credential.sourcePath);
}
function ownSignInPath(sourcePath, ownDir) {
  if (ownDir === "" || sourcePath === "") return false;
  const walked = (0, import_node_path.relative)((0, import_node_path.resolve)(ownDir), (0, import_node_path.resolve)(sourcePath));
  return walked !== "" && !walked.startsWith("..") && !(0, import_node_path.isAbsolute)(walked);
}
function workbuddyAccountId(credential) {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? `path:${credential.sourcePath}`;
  return (0, import_node_crypto.createHash)("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
function accountLabel(credential) {
  return credential.nickname ?? "WorkBuddy";
}
function credentialUnusable(credential, now) {
  if (credential.expiresAtMs <= 0 || credential.expiresAtMs > now) return false;
  return credential.refreshToken === "";
}
function disambiguateLabels(accounts) {
  const counts = /* @__PURE__ */ new Map();
  for (const account of accounts) counts.set(account.label, (counts.get(account.label) ?? 0) + 1);
  for (const account of accounts) {
    if ((counts.get(account.label) ?? 0) < 2) continue;
    const discriminator = (account.credential.uid ?? account.credential.uin ?? "").slice(0, 8);
    if (discriminator !== "") account.label = `${account.label}#${discriminator}`;
  }
}
async function authFilesIn(dir) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(dir);
  } catch {
    return void 0;
  }
  const files = entries.filter((name) => name.endsWith(".info"));
  files.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
  return files.map((name) => (0, import_node_path.join)(dir, name));
}
function sealedAccessToken(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const document = parsed;
  const auth = typeof document["auth"] === "object" && document["auth"] !== null ? document["auth"] : document;
  return (0, import_at_rest.isEncryptedFieldWrapper)(auth["accessToken"]);
}
async function readCredential(path) {
  let text;
  try {
    text = await (0, import_promises.readFile)(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  const decrypt = text.includes('"$wbEncrypted"') ? await (0, import_at_rest.encryptedFieldOpener)() : void 0;
  const credential = parseWorkBuddyAuth(text, path, decrypt);
  if (credential !== void 0) return { kind: "credential", credential };
  if (sealedAccessToken(text)) return { kind: "sealed" };
  return { kind: "absent" };
}
const REFRESH_MARGIN_MS = 5 * 60 * 1e3;
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1e3;
const PENALIZE_CAP_MS = 2 * 60 * 60 * 1e3;
const POOL_HOLD_MS = 6 * 60 * 60 * 1e3;
const REFUSED_SIGN_IN_MESSAGE = "this account's sign-in was refused by the upstream and its refresh token is spent; sign in again in the WorkBuddy desktop app";
const MAX_MODEL_COOLDOWN_KEYS = 128;
const RATE_LIMIT_STREAK_CAP = 15 * 60 * 1e3;
const RATE_LIMIT_STREAK_STEPS = 4;
const RATE_LIMIT_STREAK_WINDOW_MS = RATE_LIMIT_STREAK_CAP * 2;
function pruneModelCooldowns(account, now) {
  for (const table of [account.modelCooldowns, account.modelBlocks]) {
    for (const [modelId, until] of Object.entries(table)) {
      if (until <= now) delete table[modelId];
    }
  }
  const keys = Object.keys(account.modelCooldowns);
  if (keys.length <= MAX_MODEL_COOLDOWN_KEYS) return;
  keys.sort((a, b) => (account.modelCooldowns[a] ?? 0) - (account.modelCooldowns[b] ?? 0));
  for (const key of keys.slice(0, keys.length - MAX_MODEL_COOLDOWN_KEYS)) {
    delete account.modelCooldowns[key];
  }
}
function ownSignInDir(dataPath) {
  return dataPath === "" ? "" : (0, import_node_path.join)(dataPath, OWN_SIGN_IN_DIRNAME);
}
function ownSignInOf(credential) {
  return {
    region: (0, import_upstream.regionOf)(credential.domain),
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs,
    domain: credential.domain,
    ...credential.lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs: credential.lastRefreshAtMs },
    uid: credential.uid ?? "",
    uin: credential.uin ?? "",
    enterpriseId: credential.enterpriseId ?? "",
    nickname: credential.nickname ?? ""
  };
}
async function writeOwnSignIn(directory, signIn) {
  const stable = signIn.uin === "" ? signIn.uid : signIn.uin;
  const suffix = stable === "" ? (0, import_node_crypto.randomUUID)() : stable.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const file = (0, import_node_path.join)(directory, `${OWN_SIGN_IN_PREFIX}${suffix === "" ? (0, import_node_crypto.randomUUID)() : suffix}.info`);
  await (0, import_promises.mkdir)(directory, { recursive: true });
  await (0, import_promises.writeFile)(file, JSON.stringify({
    auth: {
      accessToken: signIn.accessToken,
      refreshToken: signIn.refreshToken,
      expiresAt: signIn.expiresAtMs,
      domain: signIn.domain,
      lastRefreshTime: signIn.lastRefreshAtMs ?? Date.now()
    },
    account: {
      ...signIn.uid === "" ? {} : { uid: signIn.uid },
      ...signIn.uin === "" ? {} : { uin: signIn.uin },
      ...signIn.enterpriseId === "" ? {} : { enterpriseId: signIn.enterpriseId },
      ...signIn.nickname === "" ? {} : { nickname: signIn.nickname }
    }
  }, null, 2), { mode: 384 });
  return file;
}
async function renewOwnSignInFile(file, credential) {
  const document = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
  const auth = document.auth ?? {};
  auth.accessToken = credential.accessToken;
  auth.refreshToken = credential.refreshToken;
  auth.expiresAt = credential.expiresAtMs;
  auth.lastRefreshTime = credential.lastRefreshAtMs ?? Date.now();
  document.auth = auth;
  const temporary = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
  try {
    await (0, import_promises.writeFile)(temporary, JSON.stringify(document, null, 2), { mode: 384 });
    await (0, import_promises.rename)(temporary, file);
  } catch (error) {
    await (0, import_promises.unlink)(temporary).catch(() => {
    });
    throw error;
  }
}
function pickSoonestExpiry(pool, expiryMs, now) {
  let best;
  let bestAt = Infinity;
  for (const account of pool) {
    const at = expiryMs.get(account.id);
    if (at === void 0 || at <= now) continue;
    if (at < bestAt) {
      best = account;
      bestAt = at;
    }
  }
  return best ?? pool[0];
}
function candidateAuthDirs(env = process.env) {
  const dirs = [];
  const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV]);
  if (override !== void 0) {
    dirs.push(override.toLowerCase().endsWith(".info") ? (0, import_node_path.resolve)(override, "..") : override);
  }
  dirs.push(...defaultDesktopAuthDirs());
  return dirs;
}
function sameDirs(a, b) {
  if (a.length !== b.length) return false;
  return a.every((dir) => b.includes(dir));
}
async function readArchivedCredentials(file) {
  const stored = /* @__PURE__ */ new Map();
  let text;
  try {
    text = await (0, import_promises.readFile)(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return stored;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("credential archive is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return stored;
  const entries = parsed.entries;
  if (!Array.isArray(entries)) return stored;
  const horizon = Date.now() - ARCHIVE_RETENTION_MS;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry;
    if (typeof record["id"] !== "string" || record["id"] === "") continue;
    if (typeof record["accessToken"] !== "string" || record["accessToken"] === "") continue;
    const expiresAt = typeof record["expiresAtMs"] === "number" ? record["expiresAtMs"] : 0;
    const refreshExpiresAt = typeof record["refreshExpiresAtMs"] === "number" ? record["refreshExpiresAtMs"] : 0;
    const lastUsable = Math.max(expiresAt, refreshExpiresAt);
    if (lastUsable > 0 && lastUsable < horizon) continue;
    stored.set(record["id"], {
      accessToken: record["accessToken"],
      refreshToken: typeof record["refreshToken"] === "string" ? record["refreshToken"] : "",
      expiresAtMs: typeof record["expiresAtMs"] === "number" ? record["expiresAtMs"] : 0,
      ...typeof record["refreshExpiresAtMs"] !== "number" ? {} : { refreshExpiresAtMs: record["refreshExpiresAtMs"] },
      ...typeof record["lastRefreshAtMs"] !== "number" ? {} : { lastRefreshAtMs: record["lastRefreshAtMs"] },
      ...typeof record["nickname"] !== "string" || record["nickname"] === "" ? {} : { nickname: record["nickname"] },
      ...typeof record["uin"] !== "string" || record["uin"] === "" ? {} : { uin: record["uin"] },
      ...typeof record["uid"] !== "string" || record["uid"] === "" ? {} : { uid: record["uid"] },
      ...typeof record["enterpriseId"] !== "string" || record["enterpriseId"] === "" ? {} : { enterpriseId: record["enterpriseId"] },
      domain: typeof record["domain"] === "string" ? record["domain"] : "",
      sourcePath: typeof record["sourcePath"] === "string" ? record["sourcePath"] : ""
    });
  }
  return stored;
}
async function writeArchivedCredentials(file, entries) {
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(file), { recursive: true });
  const body = JSON.stringify({
    version: 1,
    entries: [...entries].map(([id, credential]) => ({
      id,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs,
      ...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
      ...credential.lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs: credential.lastRefreshAtMs },
      ...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
      ...credential.uin === void 0 ? {} : { uin: credential.uin },
      ...credential.uid === void 0 ? {} : { uid: credential.uid },
      ...credential.enterpriseId === void 0 ? {} : { enterpriseId: credential.enterpriseId },
      domain: credential.domain,
      sourcePath: credential.sourcePath
    }))
  });
  const temporary = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
  try {
    await (0, import_promises.writeFile)(temporary, body, { encoding: "utf8", mode: 384 });
    await (0, import_promises.rename)(temporary, file);
  } catch (error) {
    await (0, import_promises.unlink)(temporary).catch(() => {
    });
    throw error;
  }
}
class WorkBuddyAccountPool {
  logger;
  authDirs;
  cooldownMs;
  client;
  accounts = [];
  distribution;
  /**
   * Account ids the user switched off on the panel.
   *
   * Disabling is a user preference, not a property of the credential: scan()
   * rebuilds every account from the auth files, so the set has to be re-applied
   * from settings and only filters at pick time.
   */
  disabledIds = /* @__PURE__ */ new Set();
  /** Cursor for round-robin and the next new sticky conversation. */
  cursor = 0;
  /** Sticky mode: conversation key → account id. Content stays out of memory. */
  sticky = /* @__PURE__ */ new Map();
  lastScanAtMs = 0;
  preferredIds = /* @__PURE__ */ new Map();
  /**
   * Account ids the user removed from the pool for good.
   *
   * Enforced while scan() assembles its result, so a removed account cannot
   * re-enter the pool when the desktop app rewrites its sign-in file. That is
   * the difference from {@link disabledIds}, which leaves the account listed,
   * readable and restorable with one switch.
   */
  removedIds = /* @__PURE__ */ new Set();
  /**
   * Per-account credit floor, keyed by account id. 0 (or absent) means "spend it
   * all".
   *
   * A reserve is protection, not a limit the upstream knows about: the pool
   * simply stops picking an account once its last known balance is at or below
   * the floor, so the user keeps a cushion for their own use.
   */
  creditReserves = /* @__PURE__ */ new Map();
  /**
   * Last known credit balance per account.
   *
   * Fed by the panel's read-only probes. An account with no reading stays
   * usable: refusing to pick an account whose balance has not been checked yet
   * would strand a healthy pool, and the first 402 still cools it as before.
   */
  creditBalances = /* @__PURE__ */ new Map();
  /** Supplies the archive directory; asked on each scan, not at construction. */
  dataPath;
  /** Soonest remaining one-off pack, ms. Cleared when that pack is spent or past. */
  creditExpiries = /* @__PURE__ */ new Map();
  refreshInflight = /* @__PURE__ */ new Map();
  /** Tail of the archive's write chain; every archive write waits on it. */
  archiveQueue = Promise.resolve();
  /** The one scan in progress; concurrent callers await it instead of duplicating it. */
  scanInflight;
  /** Torn-down sign-ins, read on first use: a scan cannot resurrect what is here. */
  /**
   * Cached tombstones, with the file stamp they were read at.
   *
   * A second pool over the same data directory writes this file too. Serving a
   * cache read before that write and then writing it back verbatim dropped the
   * other pool's deletions, and a deleted account came back the next time the
   * client's snapshot was adopted. The stamp makes a write elsewhere visible.
   */
  deletedSignIns;
  deletedSignInsStamp;
  /** The directories the in-flight scan is reading, so a repoint supersedes it. */
  scanDirs = [];
  /**
   * Accounts whose "expired with no refresh token" warning has been logged.
   *
   * A credential with no expiry and no refresh token stays on the expiring path
   * forever, so without this the same warning fired on every request.
   */
  noRefreshWarned = /* @__PURE__ */ new Set();
  /**
   * Accounts a hold the pool itself decided is keeping out of rotation, and why.
   *
   * Separate from `cooldownUntilMs` because the two are released by different
   * things: an upstream's rate-limit window expires on its own, while a hold
   * ends when the condition behind it changes. The reason is recorded because
   * the two conditions are not the same signal: a balance read finding credits
   * again says a spent account was topped up, and it says nothing about a
   * sign-in the upstream refuses. Releasing both on a balance meant a 401'ing
   * account went back to the head of the queue on every probe cycle.
   */
  heldIds = /* @__PURE__ */ new Map();
  /**
   * Accounts the desktop client is signed into right now.
   *
   * The pool renews one of these into its own directory when the app's session
   * runs out, and serves that copy until the app writes a newer one. Renewing it
   * does not make it the pool's own account: the app still holds the session, and
   * a delete would hide the account from the pool while the user believed they
   * were removing something the plugin had added.
   */
  appHeldIds = /* @__PURE__ */ new Set();
  /**
   * The sign-ins each account's own files hold, as of the last scan.
   *
   * Only the files the client and the panel write, not the archive: the archive
   * is rewritten whenever this process refreshes a token, so counting it would
   * turn every refresh into a "the user signed in again".
   */
  signInTokens = /* @__PURE__ */ new Map();
  /**
   * Sign-ins the upstream refused, per account.
   *
   * A refused token must not come back through the ranking: the copies are
   * compared by issue time, and a token the upstream rejected can be the newest
   * one (a re-login that did not work, a sign-in copied from another machine).
   * Without this the scan would serve it again, and the hold would look released
   * while the requests kept failing. Kept across scans, and
   * dropped once the sign-in is no longer on disk or the cooldowns are reset.
   */
  refusedSignIns = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.logger = options.logger;
    this.authDirs = options.authDirs ?? candidateAuthDirs();
    this.dataPath = options.dataPath;
    this.cooldownMs = options.cooldownMs ?? 6e4;
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs <= 0) this.cooldownMs = 6e4;
    this.client = options.client;
    this.distribution = options.distribution ?? "priority";
  }
  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   *
   * Answers whether the auth directory set changed, which is the one case that
   * empties the pool: the caller has to know, because nothing downstream reads
   * the disk on its own and the pool would otherwise stay empty until a chat
   * request happened to scan it.
   */
  applyConfig(options) {
    let emptied = false;
    if (options.authDirs !== void 0 && options.authDirs.length > 0) {
      if (!sameDirs(this.authDirs, options.authDirs)) {
        this.accounts = [];
        emptied = true;
      }
      this.authDirs = options.authDirs;
    }
    if (options.cooldownMs !== void 0 && options.cooldownMs >= 1e3) {
      this.cooldownMs = options.cooldownMs;
    }
    if (options.distribution !== void 0) {
      this.distribution = options.distribution;
    }
    if (options.disabledAccountIds !== void 0) {
      this.disabledIds = new Set(options.disabledAccountIds);
    }
    if (options.creditReserves !== void 0) {
      const next = /* @__PURE__ */ new Map();
      for (const [id, value] of Object.entries(options.creditReserves)) {
        const floor = Number(value);
        if (id !== "" && Number.isFinite(floor) && floor > 0) next.set(id, Math.floor(floor));
      }
      this.creditReserves = next;
    }
    return emptied;
  }
  /** Remember an account's last known balance, from the panel's probe. */
  setCreditBalance(accountId, total, nearestExpiryMs) {
    if (!Number.isFinite(total) || total < 0) return;
    this.creditBalances.set(accountId, total);
    if (typeof nearestExpiryMs === "number" && Number.isFinite(nearestExpiryMs) && nearestExpiryMs > Date.now()) {
      this.creditExpiries.set(accountId, nearestExpiryMs);
    } else {
      this.creditExpiries.delete(accountId);
    }
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return;
    const hold = this.heldIds.get(accountId);
    if (hold === void 0) return;
    if (hold.until <= Date.now()) {
      this.heldIds.delete(accountId);
      return;
    }
    if (hold.reason !== "spent" || total <= 0) return;
    this.heldIds.delete(accountId);
    if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= hold.until) account.cooldownUntilMs = 0;
    this.logger?.info?.(`${import_log.LOG_PREFIX}: ${account.label} has credits again; releasing the hold`);
  }
  /** True when a known balance has reached the floor set for this account. */
  reserveHolds(accountId) {
    const floor = this.creditReserves.get(accountId);
    if (floor === void 0 || floor <= 0) return false;
    const balance = this.creditBalances.get(accountId);
    return balance !== void 0 && balance <= floor;
  }
  /** Whether this account was switched off on the panel. */
  isDisabled(accountId) {
    return this.disabledIds.has(accountId);
  }
  /**
   * Replace the permanent removal list.
   *
   * The list only filters what is handed out, so both directions take effect at
   * once: a removed account disappears without a rescan, and restoring one does
   * not wait for the next scan to bring it back.
   */
  applyRemoved(ids) {
    this.removedIds = new Set(ids);
  }
  /**
   * True when this account's sign-in is one the plugin wrote, so it may be
   * deleted. The panel asks before it offers the button: deleting a desktop
   * app's own sign-in would sign the user out of that app.
   *
   * A refreshed desktop sign-in does not qualify. The pool holds a copy of it
   * after a renewal, but the app is still signed in, so the row stays out of
   * reach: removing it would suppress an account the user only ever added to the
   * app, and nothing on that row says so.
   */
  ownsSignIn(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0 || this.appHeldIds.has(accountId)) return false;
    return this.isOwnSignInPath(account.credential.sourcePath);
  }
  /**
   * Delete one account's sign-in, and its archive entry with it.
   *
   * Two things have to go, not one: the archive keeps a copy of every
   * credential a walk has seen and reads it back for every directory the walk
   * can still read, which includes the plugin's own. Deleting only the file
   * would bring the account straight back on the next scan.
   *
   * Only a sign-in this plugin wrote is removable. The desktop app owns its own
   * directory, and a file deleted there takes the user's session in that app
   * down with it, so anything outside the plugin's own directory is refused
   * rather than attempted. Answers false for an unknown account too, so the
   * caller reports a refusal instead of treating it as done.
   */
  async removeOwnSignIn(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return false;
    if (!this.ownsSignIn(accountId)) return false;
    const running = this.scanInflight;
    const known = (await this.loadDeletedSignIns()).has(account.id);
    if (!await this.rememberDeletedSignIn(account.id, account.credential)) {
      throw new Error("could not record the deleted sign-in");
    }
    if (running !== void 0) {
      const settled = await raceWithTimeout(running.catch(() => {
      }), DELETE_SCAN_WAIT_MS);
      if (!settled) void running.catch(() => {
      }).then(() => this.forgetArchived(account.id));
    }
    try {
      await (0, import_promises.unlink)(account.credential.sourcePath);
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT") {
        if (!known) {
          ;
          (await this.loadDeletedSignIns()).delete(account.id);
          await this.writeDeletedSignIns([account.id]);
        }
        throw error;
      }
    }
    await this.forgetArchived(account.id);
    this.forgetAccount(account.id);
    return true;
  }
  /** Drop one account and everything the pool remembers about it. */
  forgetAccount(accountId) {
    this.accounts = this.accounts.filter((item) => item.id !== accountId);
    this.noRefreshWarned.delete(accountId);
    this.creditBalances.delete(accountId);
    this.creditExpiries.delete(accountId);
    this.heldIds.delete(accountId);
    this.signInTokens.delete(accountId);
    this.refusedSignIns.delete(accountId);
  }
  /**
   * Record one deleted sign-in, so no later scan puts the account back.
   *
   * The file is written before the delete is reported: a tombstone that only
   * lived in memory would be gone after a restart, and the snapshot it has to
   * hold off is still sitting in the client's directory.
   */
  async rememberDeletedSignIn(id, credential) {
    const tombstones = await this.loadDeletedSignIns();
    const previous = tombstones.get(id);
    tombstones.set(id, {
      tokenDigest: tokenDigest(credential.accessToken),
      lastRefreshAtMs: credential.lastRefreshAtMs ?? 0,
      deletedAtMs: Date.now()
    });
    if (await this.writeDeletedSignIns()) return true;
    if (previous === void 0) tombstones.delete(id);
    else tombstones.set(id, previous);
    return false;
  }
  /**
   * Read the tombstones, re-reading when the file changed underneath us.
   *
   * Nothing is pruned by age. A deleted sign-in's copy is still lying in the
   * client's directory until the client overwrites it, so a tombstone that
   * expired would bring that copy straight back, refresh token included.
   */
  async loadDeletedSignIns() {
    const file = this.deletedSignInsFile();
    const stamp = file === void 0 ? "" : await signInFileStamp(file);
    if (this.deletedSignIns !== void 0 && this.deletedSignInsStamp === stamp) return this.deletedSignIns;
    if (file === void 0) {
      this.deletedSignInsStamp = "";
      this.deletedSignIns = /* @__PURE__ */ new Map();
      return this.deletedSignIns;
    }
    try {
      const tombstones = await readDeletedSignInsFile(file);
      this.deletedSignInsStamp = stamp;
      this.deletedSignIns = tombstones;
      return tombstones;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.deletedSignInsStamp = stamp;
        this.deletedSignIns = /* @__PURE__ */ new Map();
        return this.deletedSignIns;
      }
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not read the deleted sign-ins: ${String(error)}`);
      return this.deletedSignIns ?? /* @__PURE__ */ new Map();
    }
  }
  /**
   * Persist the tombstone set; the caller has already updated the map.
   *
   * What is on disk is merged in first, except for the ids this call is removing:
   * a second pool over the same data directory writes this same file, and writing
   * our map verbatim dropped a delete it had already recorded. The removals are the
   * other half of that: a re-login ends a tombstone and a failed delete rolls one
   * back, and a pure union put both straight back.
   *
   * Answers false when the file could not be written, so a delete can refuse to
   * report success on a state it could not record.
   */
  async writeDeletedSignIns(removed = []) {
    const tombstones = this.deletedSignIns;
    const file = this.deletedSignInsFile();
    if (tombstones === void 0 || file === void 0) return true;
    let written = false;
    await withFileLock(`${file}.lock`, async () => {
      const onDisk = await readDeletedSignInsFile(file).catch(() => /* @__PURE__ */ new Map());
      for (const [id, entry] of onDisk) {
        if (removed.includes(id)) continue;
        const ours = tombstones.get(id);
        if (ours === void 0 || entry.deletedAtMs > ours.deletedAtMs) tombstones.set(id, entry);
      }
      const temporary = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
      try {
        await (0, import_promises.mkdir)((0, import_node_path.dirname)(file), { recursive: true });
        await (0, import_promises.writeFile)(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(tombstones) }, null, 2), { mode: 384 });
        await (0, import_promises.rename)(temporary, file);
        this.deletedSignInsStamp = await signInFileStamp(file);
        written = true;
      } catch (error) {
        await (0, import_promises.unlink)(temporary).catch(() => {
        });
        this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not record the deleted sign-ins: ${String(error)}`);
      }
    });
    return written;
  }
  deletedSignInsFile() {
    const directory = this.dataPath?.();
    return directory === void 0 || directory === "" ? void 0 : (0, import_node_path.join)(directory, DELETED_SIGN_INS_FILENAME);
  }
  /** Whether the pool recorded this sign-in as refused by the upstream. */
  signInRefused(id, token) {
    if (this.refusedSignIns.get(id)?.includes(token) ?? false) return true;
    const hold = this.heldIds.get(id);
    return hold?.reason === "session" && hold.heldSignIns.includes(token);
  }
  /**
   * Every sign-in a refusal could have named for this account.
   *
   * The files the last walk read, plus the credential in force when it came from
   * somewhere else (the archive, or a token this process minted before it was
   * written to disk). Naming only the files left an account served from the
   * archive with an empty proof, and a hold with an empty proof is released by
   * the first scan that follows it.
   */
  refusedSignInsFor(id) {
    const tokens = (this.signInTokens.get(id) ?? []).map((entry) => entry.accessToken);
    const inForce = this.accounts.find((account) => account.id === id)?.credential.accessToken;
    if (inForce !== void 0 && inForce !== "" && !tokens.includes(inForce)) tokens.push(inForce);
    return tokens;
  }
  /** Whether `sourcePath` sits inside the directory the plugin writes into. */
  isOwnSignInPath(sourcePath) {
    return ownSignInPath(sourcePath, ownSignInDir(this.dataPath?.() ?? ""));
  }
  /**
   * Take over the sign-ins the desktop client left behind.
   *
   * The client keeps one live sign-in and a stack of superseded snapshots beside
   * it. A snapshot's token is a session the client itself stopped using, so
   * nothing renews it: it serves until its access token expires and then the
   * account is gone, holding a refresh token the client's own rotation already
   * spent. Copying it into the directory the plugin writes makes it the
   * plugin's account, renewed by the same age rule a panel-added sign-in gets,
   * so the account outlives the snapshot it came from.
   *
   * Only a superseded snapshot is taken over. The live sign-in stays the
   * client's: it refreshes it, and a second holder of the same session
   * refreshing on its own schedule is how both end up with a spent refresh
   * token. An account the client is signed into is skipped for the same reason.
   */
  async adoptOrphanedSignIns(found, tornDown) {
    const directory = ownSignInDir(this.dataPath?.() ?? "");
    if (directory === "") return [];
    const liveIds = /* @__PURE__ */ new Set();
    const ownedIds = /* @__PURE__ */ new Set();
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      if (isLiveAuthFile(credential.sourcePath)) liveIds.add(id);
      else if (ownSignInPath(credential.sourcePath, directory)) ownedIds.add(id);
    }
    const adopted = [];
    for (const credential of found) {
      if (isLiveAuthFile(credential.sourcePath)) continue;
      if (ownSignInPath(credential.sourcePath, directory)) continue;
      const id = workbuddyAccountId(credential);
      if (liveIds.has(id) || ownedIds.has(id) || tornDown.has(id)) continue;
      if ((credential.uin ?? credential.uid ?? credential.nickname ?? "") === "") continue;
      let file;
      try {
        file = await writeOwnSignIn(directory, { ...ownSignInOf(credential), lastRefreshAtMs: credential.lastRefreshAtMs ?? 0 });
      } catch (error) {
        this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not take over ${accountLabel(credential)}: ${String(error)}`);
        continue;
      }
      ownedIds.add(id);
      adopted.push({ ...credential, sourcePath: file });
    }
    return adopted;
  }
  /**
   * Write a renewed token back into the sign-in file it was read from.
   *
   * Best effort: a failed write costs the renewal its persistence, never the
   * request already in flight. Anything that did not come from the plugin's own
   * directory is left alone - the desktop app owns its files.
   */
  async renewOwnSignIn(credential) {
    if (this.isOwnSignInPath(credential.sourcePath)) {
      try {
        await renewOwnSignInFile(credential.sourcePath, credential);
      } catch (error) {
        this.logger?.warn?.(
          `${import_log.LOG_PREFIX}: could not write the renewed token back for ${credential.nickname ?? credential.uid}: ${String(error)}`
        );
      }
      return;
    }
    const directory = ownSignInDir(this.dataPath?.() ?? "");
    if (directory === "") return;
    try {
      credential.sourcePath = await writeOwnSignIn(directory, ownSignInOf(credential));
    } catch (error) {
      this.logger?.warn?.(
        `${import_log.LOG_PREFIX}: could not keep the renewed token for ${credential.nickname ?? credential.uid}: ${String(error)}`
      );
    }
  }
  /**
   * Drop one account from the credential archive.
   *
   * On the same queue as every other archive write: this is a read-modify-write
   * of one document, and a delete that raced a scan's write would otherwise be
   * overwritten by it.
   */
  async forgetArchived(id) {
    const file = this.archiveFile();
    if (file === void 0) return;
    const run = this.archiveQueue.then(async () => {
      const stored = await readArchivedCredentials(file);
      if (!stored.delete(id)) return;
      await writeArchivedCredentials(file, stored);
    });
    this.archiveQueue = run.catch(() => {
    });
    try {
      await run;
    } catch (error) {
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not drop ${id} from the credential archive: ${String(error)}`);
    }
  }
  /** Drop every account, e.g. when the source is switched off. A later `scan()` rebuilds from disk. */
  clear() {
    this.accounts = [];
    this.appHeldIds = /* @__PURE__ */ new Set();
  }
  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan() {
    const dirs = this.scanDirsFor(this.authDirs);
    if (this.scanInflight !== void 0 && sameDirs(this.scanDirs, dirs)) return this.scanInflight;
    const inflight = this.scanOnce(dirs).finally(() => {
      if (this.scanInflight === inflight) {
        this.scanInflight = void 0;
        this.scanDirs = [];
      }
    });
    this.scanDirs = dirs;
    this.scanInflight = inflight;
    return inflight;
  }
  /**
   * The directories a walk reads: the configured ones plus the plugin's own.
   *
   * The pool writes sign-ins into its own directory (a renewal it claims, an
   * account it takes over), so it has to read that directory too, whether or not
   * the host listed it. Read in both places through this one function: a set that
   * disagreed with itself read as "the auth directories were repointed mid-walk"
   * and threw the whole walk away.
   */
  scanDirsFor(authDirs) {
    const dirs = [...authDirs];
    const own = ownSignInDir(this.dataPath?.() ?? "");
    if (own !== "" && !dirs.some((dir) => (0, import_node_path.resolve)(dir) === (0, import_node_path.resolve)(own))) dirs.push(own);
    return dirs;
  }
  /**
   * Keep the credentials this walk saw, so an account whose only file the client
   * overwrites on the next sign-in still has a copy to be read back from.
   *
   * Best effort by design: a failed write costs the archive, never the scan.
   */
  async archiveCredentials(credentials) {
    const file = this.archiveFile();
    if (file === void 0 || credentials.length === 0) return;
    const ownDir = ownSignInDir(this.dataPath?.() ?? "");
    const run = this.archiveQueue.then(async () => {
      const stored = await readArchivedCredentials(file);
      let changed = false;
      for (const credential of credentials) {
        const id = workbuddyAccountId(credential);
        const previous = stored.get(id);
        if (previous !== void 0 && !isFresher(credential, previous, ownDir)) continue;
        stored.set(id, credential);
        changed = true;
      }
      if (changed) await writeArchivedCredentials(file, stored);
    });
    this.archiveQueue = run.catch(() => {
    });
    try {
      await run;
    } catch (error) {
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not update the credential archive: ${String(error)}`);
    }
  }
  /** Credentials the archive kept for a directory this walk can read. */
  async archivedCredentials(homes) {
    const file = this.archiveFile();
    if (file === void 0) return [];
    try {
      const stored = await readArchivedCredentials(file);
      return [...stored.values()].filter((credential) => homes.has(this.homeOf(credential)));
    } catch (error) {
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not read the credential archive: ${String(error)}`);
      return [];
    }
  }
  /** The auth directory a credential was read from. */
  homeOf(credential) {
    return (0, import_node_path.resolve)((0, import_node_path.dirname)(credential.sourcePath));
  }
  archiveFile() {
    const directory = this.dataPath?.();
    return directory === void 0 || directory === "" ? void 0 : (0, import_node_path.join)(directory, ARCHIVE_FILENAME);
  }
  async scanOnce(dirs) {
    const found = [];
    const readableDirs = /* @__PURE__ */ new Set();
    const sealedDirs = /* @__PURE__ */ new Set();
    for (const dir of dirs) {
      const files = await authFilesIn(dir);
      if (files === void 0) continue;
      readableDirs.add((0, import_node_path.resolve)(dir));
      for (const file of files) {
        const read = await readCredential(file);
        if (read.kind === "credential") found.push(read.credential);
        else if (read.kind === "sealed") sealedDirs.add((0, import_node_path.resolve)(dir));
      }
    }
    const tombstones = await this.loadDeletedSignIns();
    const tornDown = /* @__PURE__ */ new Set();
    const releasedIds = [];
    const held = [];
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const tombstone = tombstones.get(id);
      if (tombstone === void 0) {
        held.push(credential);
        continue;
      }
      if (!endsTombstone(tombstone, credential)) {
        tornDown.add(id);
        continue;
      }
      tombstones.delete(id);
      releasedIds.push(id);
      held.push(credential);
    }
    found.length = 0;
    found.push(...held);
    for (const id of tombstones.keys()) tornDown.add(id);
    if (releasedIds.length > 0) await this.writeDeletedSignIns(releasedIds);
    await this.archiveCredentials(found);
    found.push(...await this.adoptOrphanedSignIns(found, tornDown));
    const signInTokens = /* @__PURE__ */ new Map();
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const held2 = signInTokens.get(id);
      if (held2 === void 0) signInTokens.set(id, [credential]);
      else held2.push(credential);
    }
    const liveIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
    const appHeld = new Set(
      found.filter((credential) => isLiveAuthFile(credential.sourcePath)).map((credential) => workbuddyAccountId(credential))
    );
    for (const credential of await this.archivedCredentials(readableDirs)) {
      const id = workbuddyAccountId(credential);
      if (tornDown.has(id)) continue;
      if (found.some((entry) => workbuddyAccountId(entry) === id && entry.accessToken === credential.accessToken)) continue;
      found.push(credential);
    }
    const byId = /* @__PURE__ */ new Map();
    for (const account of this.accounts) byId.set(account.id, account);
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const existing = byId.get(id);
      if (existing === void 0) {
        byId.set(id, {
          id,
          label: accountLabel(credential),
          credential,
          cooldownUntilMs: 0,
          modelCooldowns: /* @__PURE__ */ Object.create(null),
          modelBlocks: /* @__PURE__ */ Object.create(null),
          rateLimitHits: 0
        });
        continue;
      }
      const hold = this.heldIds.get(id);
      const heldSignIns = hold?.reason === "session" ? hold.heldSignIns : void 0;
      const replaced = heldSignIns === void 0 ? void 0 : signInTokens.get(id)?.find((entry) => !heldSignIns.includes(entry.accessToken));
      if (replaced !== void 0 && hold !== void 0 && heldSignIns !== void 0) {
        this.heldIds.delete(id);
        if (existing.cooldownUntilMs <= hold.until) existing.cooldownUntilMs = 0;
        existing.credential = replaced;
        this.refusedSignIns.set(id, heldSignIns);
      }
      if (!this.signInRefused(id, credential.accessToken) && (this.signInRefused(id, existing.credential.accessToken) || isFresher(credential, existing.credential, ownSignInDir(this.dataPath?.() ?? "")))) {
        existing.credential = credential;
      }
    }
    for (const [id, account] of byId) {
      const hold = this.heldIds.get(id);
      if (hold?.reason !== "session") continue;
      if (hold.heldSignIns.length === 0) continue;
      if (this.signInRefused(id, account.credential.accessToken)) continue;
      this.heldIds.delete(id);
      if (account.cooldownUntilMs > 0 && account.cooldownUntilMs <= hold.until) account.cooldownUntilMs = 0;
      this.logger?.info?.(`${import_log.LOG_PREFIX}: ${account.label} has a sign-in the upstream did not refuse; releasing the hold`);
    }
    const foundIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
    for (const [id, refused] of this.refusedSignIns) {
      if (!foundIds.has(id)) {
        this.refusedSignIns.delete(id);
        continue;
      }
      const onDisk = signInTokens.get(id);
      if (onDisk !== void 0 && !refused.some((token) => onDisk.some((entry) => entry.accessToken === token))) {
        this.refusedSignIns.delete(id);
      }
    }
    const scanNow = Date.now();
    for (const account of byId.values()) pruneModelCooldowns(account, scanNow);
    for (const [id, account] of byId) {
      const home = (0, import_node_path.resolve)((0, import_node_path.dirname)(account.credential.sourcePath));
      if (sealedDirs.has(home)) continue;
      if (readableDirs.has(home) && !foundIds.has(id)) {
        byId.delete(id);
        this.forgetAccount(id);
      }
    }
    this.appHeldIds = appHeld;
    const ordered = [...byId.values()];
    ordered.sort((a, b) => compareQueueOrder(a.credential, b.credential, ownSignInDir(this.dataPath?.() ?? "")));
    for (const account of ordered) {
      account.label = accountLabel(account.credential);
      const home = (0, import_node_path.resolve)((0, import_node_path.dirname)(account.credential.sourcePath));
      if (!readableDirs.has(home) || sealedDirs.has(home)) continue;
      if (liveIds.has(account.id)) delete account.archived;
      else account.archived = true;
    }
    disambiguateLabels(ordered);
    if (!sameDirs(this.scanDirsFor(this.authDirs), dirs)) return this.accounts;
    this.accounts = ordered;
    this.signInTokens = signInTokens;
    this.lastScanAtMs = Date.now();
    return this.accounts;
  }
  /** All accounts, cooldown state included. */
  list(region) {
    const kept = this.accounts.filter((account) => !this.removedIds.has(account.id));
    if (region === void 0) return kept;
    return kept.filter((account) => (0, import_upstream.regionOf)(account.credential.domain) === region);
  }
  /**
   * Why this account cannot serve a request, or null when it can.
   *
   * One ladder, two readers: `available` filters with it and
   * `unavailableReason` prints its answer. Keeping them separate meant every
   * new disqualifier had to be added in two places, and forgetting one made the
   * panel call an account available that the rotation would never pick.
   */
  ineligible(account, now, modelId, region) {
    if (this.removedIds.has(account.id)) return "removed";
    if (this.disabledIds.has(account.id)) return "switched off";
    if (this.reserveHolds(account.id)) return "under its credit reserve";
    if (credentialUnusable(account.credential, now)) return "sign-in expired";
    if (region !== void 0 && (0, import_upstream.regionOf)(account.credential.domain) !== region) return "other region";
    if (account.cooldownUntilMs > now) {
      const reason = this.heldIds.get(account.id)?.reason;
      return reason === "session" ? "sign-in refused" : reason === "restricted" ? "restricted by the upstream" : "on hold";
    }
    if (modelId !== void 0 && (account.modelBlocks[modelId] ?? 0) > now) return "plan";
    if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return "rate-limited";
    return null;
  }
  /**
   * Accounts currently eligible to serve a request.
   *
   * With a `modelId`, an account is eligible when it is not account-wide cooled
   * AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
   * that model out while `hy3` on the same account stays usable. Without a
   * model id the legacy account-wide check applies (callers that cannot name a
   * model, e.g. CLI diagnostics). The panel asks this same question to mark the
   * account the next request will use: a hand-rolled filter there once marked a
   * switched-off account as next up, which is what this being the only answer is
   * for.
   */
  available(now, modelId, region) {
    return this.accounts.filter((account) => this.ineligible(account, now, modelId, region) === null);
  }
  /**
   * The pool's own hold on this account, if one is in force right now.
   *
   * A caller that is about to spend upstream calls on an account asks first: a
   * held sign-in cannot answer, so the read is skipped and the hold's reason is
   * reported instead. Null when no hold applies or the hold has run out.
   */
  activeHold(accountId) {
    const hold = this.heldIds.get(accountId);
    if (hold === void 0 || hold.until <= Date.now()) return null;
    return { reason: hold.reason, untilMs: hold.until };
  }
  /**
   * Why this account is not being served right now, for a caller that has to
   * explain an empty pool. Returns null when the account is eligible.
   *
   * One place for the answer: the gateway used to infer a cause from cooldown
   * timestamps alone, so an expired sign-in was reported as a credit-reserve
   * setting the user never touched.
   */
  unavailableReason(accountId, now, modelId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return null;
    return this.ineligible(account, now, modelId);
  }
  /**
   * Pick the account to serve a request.
   *
   * The `distribution` setting chooses how:
   *
   * - **priority** (default): one account serves every request until it is
   *   rate-limited, then the next in order takes over. Credits drain one account
   *   at a time, and a cooling account returns to the head of the queue the moment
   *   its window resets - it was never consumed, so it resumes straight away.
   * - **round-robin**: consecutive requests rotate through the pool so spend
   *   spreads evenly across every account.
   * - **expiry**: the account whose credit pack expires soonest goes first, so
   *   nothing is wasted on the day it lapses.
   * - **sticky**: one account per conversation, for as long as it keeps working.
   *
   * In every mode an explicit user selection (`prefer`) heads the list, a cooling
   * account is skipped for that model only, and an unrecognised setting falls back
   * to priority.
   *
   * Scans on first use, and rescans when every known account is cooling down: a
   * fresh desktop login is the usual way out of an exhausted pool.
   */
  async acquire(modelId, region, conversationKey) {
    if (this.accounts.length === 0) await this.scan();
    let pool = this.available(Date.now(), modelId, region);
    if (pool.length === 0) {
      await this.scan();
      pool = this.available(Date.now(), modelId, region);
    }
    if (pool.length === 0) return void 0;
    const preferredId = this.preferredIds.get(region);
    const account = pool.find((item) => item.id === preferredId) ?? this.pick(pool, conversationKey);
    if (account === void 0) return void 0;
    await this.ensureFresh(account);
    const eligible = this.available(Date.now(), modelId, region);
    if (eligible.includes(account)) return account;
    const next = eligible.find((item) => item.id === preferredId) ?? this.pick(eligible, conversationKey);
    if (next === void 0) return void 0;
    await this.ensureFresh(next);
    return next;
  }
  pick(pool, conversationKey) {
    if (this.distribution === "expiry") return this.pickByExpiry(pool);
    if (this.distribution === "sticky" && conversationKey !== void 0) {
      const bound = this.sticky.get(conversationKey);
      const kept = bound === void 0 ? void 0 : pool.find((account3) => account3.id === bound);
      if (kept !== void 0) return kept;
      const account2 = pool[this.cursor % pool.length];
      if (account2 === void 0) return void 0;
      this.sticky.set(conversationKey, account2.id);
      this.cursor = (this.cursor + 1) % pool.length;
      while (this.sticky.size > 200) {
        const oldest = this.sticky.keys().next().value;
        if (oldest === void 0) break;
        this.sticky.delete(oldest);
      }
      return account2;
    }
    const index = this.distribution === "round-robin" ? this.cursor % pool.length : 0;
    const account = pool[index];
    if (account !== void 0 && this.distribution === "round-robin") {
      this.cursor = (index + 1) % pool.length;
    }
    return account;
  }
  pickByExpiry(pool) {
    return pickSoonestExpiry(pool, this.creditExpiries, Date.now());
  }
  /** Next account the card may name. Rotating modes have none. Does not move the cursor. */
  preview(eligible) {
    if (eligible.length === 0) return void 0;
    if (this.distribution === "expiry") return this.pickByExpiry(eligible);
    if (this.distribution === "priority") return eligible[0];
    return void 0;
  }
  /** Prefer one billing account per gateway; undefined restores automatic use. */
  prefer(accountId, region) {
    if (accountId === void 0) this.preferredIds.delete(region);
    else this.preferredIds.set(region, accountId);
  }
  /**
   * Refresh one account after a session-dead upstream answer, ignoring the
   * stored expiry: a revocation does not rewrite it. False when the access
   * token is unchanged, so the caller stops retrying the same dead token.
   */
  async refreshAccount(accountId) {
    return await this.refreshForRetry(accountId) === "refreshed";
  }
  /**
   * Refresh after a session-dead answer, keeping a refusal apart from a failure.
   *
   * Only the upstream turning the sign-in down justifies a hold. A timeout, a
   * rate limit or an unreachable host says nothing about the token, and parking
   * the account for six hours over one bad round trip took a healthy account out
   * of rotation until a manual reset.
   */
  async refreshForRetry(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return "failed";
    const previous = account.credential.accessToken;
    if (account.credential.refreshToken === "") return "refused";
    const outcome = await this.ensureFresh(account, true);
    if (account.credential.accessToken !== previous) return "refreshed";
    return outcome === "refused" ? "refused" : "failed";
  }
  /**
   * Hold an account whose sign-in the upstream refuses.
   *
   * The chat gateway has answered a refused sign-in with this hold since it was
   * written; the panel's reads and the scheduled passes had no equivalent, so a
   * revoked account kept spending its two upstream calls on every poll and every
   * pass. The hold is what stops that, and it is released the way every other
   * hold is: a new sign-in for the account, a cooldown reset, or its cap.
   */
  holdRefusedSignIn(accountId) {
    this.penalize(accountId, Date.now() + POOL_HOLD_MS, void 0, "session");
  }
  /**
   * One upstream read that a refused sign-in gets a second chance at.
   *
   * The upstream revokes the session a sign-in belongs to without rewriting the
   * token's own expiry, so an account the user switched away from in the desktop
   * app keeps a credential that reads as valid for weeks and answers 401 on
   * every call. A refresh token that still lives recovers the account on the
   * spot, which is the case the desktop app's own refresh leaves behind; one
   * that does not leaves the account held instead of retried forever.
   *
   * A failure of any other kind is rethrown untouched: a rate limit, a spent
   * balance and an upstream fault each have their own path, and none of them is
   * helped by a token this read did not blame.
   *
   * While the hold stands the read is not attempted at all. The panel polls
   * every couple of minutes and the scheduled passes walk the whole pool, and
   * each of those would otherwise spend the same call on a sign-in that cannot
   * answer it.
   */
  async readAfterRefresh(accountId, read) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) throw new Error(`${import_log.LOG_PREFIX}: no account ${accountId} to read for`);
    if (this.activeHold(accountId)?.reason === "session") throw new Error(REFUSED_SIGN_IN_MESSAGE);
    try {
      return await read(account.credential);
    } catch (error) {
      if ((0, import_upstream.upstreamErrorKind)(error) !== "session_dead") throw error;
      const outcome = await this.refreshForRetry(accountId);
      if (outcome === "refreshed") {
        try {
          return await read(account.credential);
        } catch (retry) {
          if ((0, import_upstream.upstreamErrorKind)(retry) !== "session_dead") throw retry;
          this.holdRefusedSignIn(accountId);
          throw retry;
        }
      }
      if (outcome === "refused") this.holdRefusedSignIn(accountId);
      throw error;
    }
  }
  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   *
   * Reports what it did, so a caller walking the pool for keep-alive can tell a
   * pass that refreshed something from one that had nothing to do. The answer
   * describes this call, not the account: an in-flight refresh another call
   * started is reported as `fresh` because this one spent no upstream call.
   */
  async ensureFresh(account, forced = false) {
    if (this.client === void 0) return "fresh";
    const credential = account.credential;
    const issuedAt = credential.lastRefreshAtMs ?? 0;
    const stale = this.isOwnSignInPath(credential.sourcePath) && issuedAt > 0 && Date.now() - issuedAt >= REFRESH_AFTER_MS;
    const expiring = forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS || stale;
    if (!expiring) return "fresh";
    const existing = this.refreshInflight.get(account.id);
    if (existing !== void 0) {
      return await existing;
    }
    const run = (async () => {
      if (credential.refreshToken === "") {
        if (credential.expiresAtMs > Date.now() + 3e4) return "fresh";
        if (!this.noRefreshWarned.has(account.id)) {
          this.noRefreshWarned.add(account.id);
          this.logger?.warn(`${import_log.LOG_PREFIX}: ${account.label} token expired with no refresh token; sign in again`);
        }
        return "noToken";
      }
      try {
        const outcome = await this.client.refreshToken(credential);
        if (account.credential !== credential) return "fresh";
        account.credential = {
          ...credential,
          accessToken: outcome.accessToken,
          ...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
          // A refresh that reports no lifetime still produced a fresh token, so
          // the stored expiry is replaced rather than kept: carrying the old
          // value forward leaves a credential that was parsed without any
          // `expiresAt` (0) permanently "expiring", which re-runs this whole
          // round trip on every single request. The assumed lifetime must clear
          // the margin above, or `ensureFresh` would still see it as expiring.
          expiresAtMs: (0, import_upstream.tokenExpiryMs)(outcome.expiresInSec),
          ...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
          // Stamped with the moment the upstream issued this token. A file on
          // disk keeps the issue time it was written with, so without this
          // stamp the refreshed credential ties with its own on-disk snapshot
          // and then loses the expiry tiebreaker to the very token it replaced:
          // the next scan swapped the working token back out and every request
          // rode the revoked one until it was refreshed again.
          lastRefreshAtMs: Date.now()
        };
        await this.archiveCredentials([account.credential]);
        await this.renewOwnSignIn(account.credential);
        this.noRefreshWarned.delete(account.id);
        const sessionHold = this.heldIds.get(account.id);
        if (sessionHold !== void 0 && sessionHold.reason === "session") {
          this.heldIds.delete(account.id);
          if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= sessionHold.until) account.cooldownUntilMs = 0;
          this.logger?.info?.(`${import_log.LOG_PREFIX}: ${account.label} refreshed again; releasing the refused sign-in hold`);
        }
        this.logger?.info?.(`${import_log.LOG_PREFIX}: refreshed token for ${account.label}`);
        return "refreshed";
      } catch (error) {
        if (credential.expiresAtMs > Date.now() + 3e4) {
          this.logger?.warn?.(`${import_log.LOG_PREFIX}: token refresh failed but token still valid for ${account.label}`, error);
        } else {
          this.logger?.error?.(`${import_log.LOG_PREFIX}: token refresh failed and token expired for ${account.label}`, error);
        }
        const kind = (0, import_upstream.upstreamErrorKind)(error);
        return kind === "session_dead" ? "refused" : "failed";
      }
    })();
    this.refreshInflight.set(account.id, run);
    try {
      return await run;
    } finally {
      this.refreshInflight.delete(account.id);
    }
  }
  /**
   * Mark an account (or one of its models) rate-limited.
   *
   * With `modelId`, only that model on the account is cooled — the account's
   * other models stay in rotation, matching the upstream's per-model rate
   * limit ("可切换其他模型继续使用"). Without a model id the whole account is
   * cooled, which callers should reserve for limits that truly span every model.
   *
   * `hold` names a decision of the pool's own rather than a timestamp read
   * off an upstream answer — a spent account, a dead session. It is bounded by
   * POOL_HOLD_MS instead of PENALIZE_CAP_MS, because the two-hour ceiling
   * exists to stop a mis-parsed reset from parking an account all day, and
   * neither of these conditions clears by itself.
   */
  penalize(accountId, resetAtMs, modelId, hold = false) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return;
    account.rateLimitHits += 1;
    const now = Date.now();
    const stated = resetAtMs !== void 0 && resetAtMs > now;
    if (hold === false && !stated) {
      const sinceLast = now - (account.rateLimitStreakAtMs ?? 0);
      account.rateLimitStreak = sinceLast > RATE_LIMIT_STREAK_WINDOW_MS ? 1 : (account.rateLimitStreak ?? 0) + 1;
      account.rateLimitStreakAtMs = now;
    }
    const holdReason = hold === false ? void 0 : hold;
    const cap = holdReason !== void 0 ? POOL_HOLD_MS : PENALIZE_CAP_MS;
    const streak = Math.min(Math.max((account.rateLimitStreak ?? 1) - 1, 0), RATE_LIMIT_STREAK_STEPS);
    const backoff = Math.min(this.cooldownMs * 2 ** streak, Math.max(this.cooldownMs, RATE_LIMIT_STREAK_CAP));
    const until = stated ? Math.min(resetAtMs, now + cap) : holdReason !== void 0 ? now + cap : now + backoff;
    if (modelId !== void 0 && modelId !== "") {
      pruneModelCooldowns(account, now);
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
      this.logger?.warn(
        `${import_log.LOG_PREFIX}: ${account.label} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`
      );
      return;
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
    if (holdReason !== void 0) {
      const prior = this.heldIds.get(accountId);
      const carried = prior !== void 0 && prior.until > now && prior.reason === "session" ? prior : void 0;
      const reason = carried?.reason ?? holdReason;
      const heldSignIns = carried !== void 0 ? carried.heldSignIns : this.refusedSignInsFor(accountId);
      this.heldIds.set(accountId, {
        reason,
        until: Math.max(until, carried?.until ?? 0),
        heldSignIns
      });
    }
    this.logger?.warn(
      holdReason !== void 0 ? `${import_log.LOG_PREFIX}: account ${account.label} held (${holdReason}); held until ${new Date(until).toISOString()}` : `${import_log.LOG_PREFIX}: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`
    );
  }
  /**
   * Keep one model out of one account's rotation for a stated window.
   *
   * `penalize` caps what it writes at `PENALIZE_CAP_MS`, which exists so a
   * mis-parsed rate-limit reset cannot park work all day. A plan refusal names
   * no upstream window and clears only when the subscription changes, so it
   * brings its own deadline; routing it through `penalize` silently shortened
   * it to the rate-limit ceiling and bought one wasted upstream call per two
   * hours. The account is left alone: every other model on it still serves.
   */
  blockModel(accountId, modelId, untilMs) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0 || modelId === "" || untilMs <= Date.now()) return;
    pruneModelCooldowns(account, Date.now());
    account.modelBlocks[modelId] = Math.max(account.modelBlocks[modelId] ?? 0, untilMs);
  }
  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns() {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0;
      account.modelCooldowns = /* @__PURE__ */ Object.create(null);
      account.modelBlocks = /* @__PURE__ */ Object.create(null);
      account.rateLimitHits = 0;
      account.rateLimitStreak = 0;
      account.rateLimitStreakAtMs = 0;
    }
    this.heldIds.clear();
    this.refusedSignIns.clear();
  }
  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status() {
    const now = Date.now();
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
      lastScanAtMs: this.lastScanAtMs
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POOL_HOLD_MS,
  WorkBuddyAccountPool,
  candidateAuthDirs,
  ownSignInDir,
  parseWorkBuddyAuth,
  renewOwnSignInFile,
  workbuddyAccountId,
  writeOwnSignIn
});
