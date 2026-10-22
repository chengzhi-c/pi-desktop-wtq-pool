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
  WorkBuddyAccountPool: () => WorkBuddyAccountPool,
  candidateAuthDirs: () => candidateAuthDirs,
  ownSignInDir: () => ownSignInDir,
  parseWorkBuddyAuth: () => parseWorkBuddyAuth,
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
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
const ARCHIVE_FILENAME = "credentials-archive.json";
const OWN_SIGN_IN_DIRNAME = "signins";
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
  return (0, import_node_path.basename)(path) === WORKBUDDY_LIVE_FILENAME;
}
function compareFreshness(a, b) {
  const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
  const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
  if (aLive !== bLive) return bLive - aLive;
  const aIssued = a.lastRefreshAtMs ?? 0;
  const bIssued = b.lastRefreshAtMs ?? 0;
  if (aIssued !== bIssued) return bIssued - aIssued;
  return b.expiresAtMs - a.expiresAtMs;
}
function isFresher(candidate, incumbent) {
  return compareFreshness(candidate, incumbent) < 0;
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
const PENALIZE_CAP_MS = 2 * 60 * 60 * 1e3;
const POOL_HOLD_CAP_MS = 24 * 60 * 60 * 1e3;
const MAX_MODEL_COOLDOWN_KEYS = 128;
const RATE_LIMIT_STREAK_CAP = 15 * 60 * 1e3;
const RATE_LIMIT_STREAK_STEPS = 4;
const RATE_LIMIT_STREAK_WINDOW_MS = RATE_LIMIT_STREAK_CAP * 2;
function pruneModelCooldowns(account, now) {
  for (const [modelId, until] of Object.entries(account.modelCooldowns)) {
    if (until <= now) delete account.modelCooldowns[modelId];
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
      lastRefreshTime: Date.now()
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
   * `compareFreshness` ranks a live desktop file above every panel sign-in
   * whatever their issue times, so a token that was refused would win that ranking
   * again on the very next scan and the account would go on sending it - the hold
   * would look released while the requests kept failing. Kept across scans, and
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
   */
  ownsSignIn(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    return account !== void 0 && this.isOwnSignInPath(account.credential.sourcePath);
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
    if (!this.isOwnSignInPath(account.credential.sourcePath)) return false;
    const running = this.scanInflight;
    if (running !== void 0) {
      const settled = await raceWithTimeout(running.catch(() => {
      }), DELETE_SCAN_WAIT_MS);
      if (!settled) void running.catch(() => {
      }).then(() => this.forgetArchived(account.id));
    }
    await (0, import_promises.unlink)(account.credential.sourcePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.forgetArchived(account.id);
    return true;
  }
  /** Whether `sourcePath` sits inside the directory the plugin writes into. */
  isOwnSignInPath(sourcePath) {
    const own = ownSignInDir(this.dataPath?.() ?? "");
    if (own === "" || sourcePath === "") return false;
    const walked = (0, import_node_path.relative)((0, import_node_path.resolve)(own), (0, import_node_path.resolve)(sourcePath));
    return walked !== "" && !walked.startsWith("..") && !(0, import_node_path.isAbsolute)(walked);
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
  }
  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan() {
    const dirs = [...this.authDirs];
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
   * Keep the credentials this walk saw, so an account whose only file the client
   * overwrites on the next sign-in still has a copy to be read back from.
   *
   * Best effort by design: a failed write costs the archive, never the scan.
   */
  async archiveCredentials(credentials) {
    const file = this.archiveFile();
    if (file === void 0 || credentials.length === 0) return;
    const run = this.archiveQueue.then(async () => {
      const stored = await readArchivedCredentials(file);
      let changed = false;
      for (const credential of credentials) {
        const id = workbuddyAccountId(credential);
        const previous = stored.get(id);
        if (previous !== void 0 && !isFresher(credential, previous)) continue;
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
    await this.archiveCredentials(found);
    const signInTokens = /* @__PURE__ */ new Map();
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const held = signInTokens.get(id);
      if (held === void 0) signInTokens.set(id, [credential]);
      else held.push(credential);
    }
    const liveIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
    for (const credential of await this.archivedCredentials(readableDirs)) {
      if (liveIds.has(workbuddyAccountId(credential))) continue;
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
          modelCooldowns: {},
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
      const refused = this.refusedSignIns.get(id);
      if (isFresher(credential, existing.credential) && !(refused?.includes(credential.accessToken) ?? false)) {
        existing.credential = credential;
      }
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
        this.noRefreshWarned.delete(id);
        this.creditBalances.delete(id);
        this.creditExpiries.delete(id);
        this.heldIds.delete(id);
        this.signInTokens.delete(id);
        this.refusedSignIns.delete(id);
      }
    }
    const ordered = [...byId.values()];
    ordered.sort((a, b) => compareFreshness(a.credential, b.credential));
    for (const account of ordered) {
      account.label = accountLabel(account.credential);
      if (liveIds.has(account.id)) delete account.archived;
      else account.archived = true;
    }
    disambiguateLabels(ordered);
    if (!sameDirs(this.authDirs, dirs)) return this.accounts;
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
    return this.accounts.filter((account) => {
      if (this.removedIds.has(account.id)) return false;
      if (this.disabledIds.has(account.id)) return false;
      if (this.reserveHolds(account.id)) return false;
      if (credentialUnusable(account.credential, now)) return false;
      if (account.cooldownUntilMs > now) return false;
      if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
      if (region !== void 0 && (0, import_upstream.regionOf)(account.credential.domain) !== region) return false;
      return true;
    });
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
    if (this.removedIds.has(account.id)) return "removed";
    if (this.disabledIds.has(account.id)) return "switched off";
    if (this.reserveHolds(account.id)) return "under its credit reserve";
    if (credentialUnusable(account.credential, now)) return "sign-in expired";
    if (account.cooldownUntilMs > now) {
      return this.heldIds.get(account.id)?.reason === "session" ? "sign-in refused" : "on hold";
    }
    if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return "rate-limited";
    return null;
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
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return false;
    const previous = account.credential.accessToken;
    await this.ensureFresh(account, true);
    return account.credential.accessToken !== previous;
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
    const expiring = forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS;
    if (!expiring) return "fresh";
    const existing = this.refreshInflight.get(account.id);
    if (existing !== void 0) {
      await existing;
      return "fresh";
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
        this.noRefreshWarned.delete(account.id);
        this.logger?.info?.(`${import_log.LOG_PREFIX}: refreshed token for ${account.label}`);
        await this.archiveCredentials([account.credential]);
        return "refreshed";
      } catch (error) {
        if (credential.expiresAtMs > Date.now() + 3e4) {
          this.logger?.warn?.(`${import_log.LOG_PREFIX}: token refresh failed but token still valid for ${account.label}`, error);
        } else {
          this.logger?.error?.(`${import_log.LOG_PREFIX}: token refresh failed and token expired for ${account.label}`, error);
        }
        return "failed";
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
   * `hold` marks a decision of the pool's own rather than a timestamp read off
   * an upstream answer — a spent account, a dead session. It is bounded by
   * POOL_HOLD_CAP_MS instead of PENALIZE_CAP_MS, because the two-hour ceiling
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
    const holdReason = hold === false ? void 0 : hold === true ? "spent" : hold;
    const cap = holdReason !== void 0 ? POOL_HOLD_CAP_MS : PENALIZE_CAP_MS;
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
      const heldSignIns = carried !== void 0 ? carried.heldSignIns : (this.signInTokens.get(accountId) ?? []).map((entry) => entry.accessToken);
      this.heldIds.set(accountId, {
        reason,
        until: Math.max(until, carried?.until ?? 0),
        heldSignIns
      });
    }
    this.logger?.warn(
      `${import_log.LOG_PREFIX}: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`
    );
  }
  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns() {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0;
      account.modelCooldowns = {};
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
  WorkBuddyAccountPool,
  candidateAuthDirs,
  ownSignInDir,
  parseWorkBuddyAuth,
  workbuddyAccountId,
  writeOwnSignIn
});
