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
  WORKBUDDY_AUTH_FILE_ENV: () => WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_LIVE_FILENAME: () => WORKBUDDY_LIVE_FILENAME,
  WorkBuddyAccountPool: () => WorkBuddyAccountPool,
  candidateAuthDirs: () => candidateAuthDirs,
  defaultDesktopAuthDirs: () => defaultDesktopAuthDirs,
  parseWorkBuddyAuth: () => parseWorkBuddyAuth,
  pickSoonestExpiry: () => pickSoonestExpiry,
  workbuddyAccountId: () => workbuddyAccountId
});
module.exports = __toCommonJS(accounts_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_upstream = require("./upstream");
var import_at_rest = require("./at-rest");
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
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
function refreshExpiryMs(expiresInSec) {
  const assumed = () => Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
  if (typeof expiresInSec !== "number" || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    return assumed();
  }
  const at = expiryToMs(Date.now() + expiresInSec * 1e3);
  return at === 0 ? assumed() : at;
}
function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
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
  if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) {
    return void 0;
  }
  const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
  const nickname = optionalString(decryptableString(identity["nickname"], decrypt));
  return {
    accessToken,
    refreshToken: decryptableString(auth["refreshToken"], decrypt),
    expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
    ...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
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
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
  return (0, import_node_crypto.createHash)("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
function accountLabel(credential) {
  return credential.nickname ?? "WorkBuddy";
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
async function readCredential(path) {
  let text;
  try {
    text = await (0, import_promises.readFile)(path, "utf8");
  } catch {
    return void 0;
  }
  const decrypt = text.includes('"$wbEncrypted"') ? await (0, import_at_rest.encryptedFieldOpener)() : void 0;
  return parseWorkBuddyAuth(text, path, decrypt);
}
const REFRESH_MARGIN_MS = 5 * 60 * 1e3;
const PENALIZE_CAP_MS = 2 * 60 * 60 * 1e3;
const ASSUMED_TOKEN_LIFETIME_MS = 60 * 60 * 1e3;
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
  /** Soonest remaining one-off pack, ms. Cleared when that pack is spent or past. */
  creditExpiries = /* @__PURE__ */ new Map();
  refreshInflight = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.logger = options.logger;
    this.authDirs = options.authDirs ?? candidateAuthDirs();
    this.cooldownMs = options.cooldownMs ?? 6e4;
    this.client = options.client;
    this.distribution = options.distribution ?? "priority";
  }
  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   */
  applyConfig(options) {
    if (options.authDirs !== void 0 && options.authDirs.length > 0) {
      if (!sameDirs(this.authDirs, options.authDirs)) this.accounts = [];
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
  /** Drop every account, e.g. when the source is switched off. A later `scan()` rebuilds from disk. */
  clear() {
    this.accounts = [];
  }
  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan() {
    const found = [];
    const readableDirs = /* @__PURE__ */ new Set();
    for (const dir of this.authDirs) {
      const files = await authFilesIn(dir);
      if (files === void 0) continue;
      readableDirs.add((0, import_node_path.resolve)(dir));
      for (const file of files) {
        const credential = await readCredential(file);
        if (credential !== void 0) found.push(credential);
      }
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
      if (isFresher(credential, existing.credential)) existing.credential = credential;
    }
    const foundIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
    for (const [id, account] of byId) {
      const home = (0, import_node_path.resolve)((0, import_node_path.dirname)(account.credential.sourcePath));
      if (readableDirs.has(home) && !foundIds.has(id)) byId.delete(id);
    }
    const ordered = [...byId.values()];
    ordered.sort((a, b) => compareFreshness(a.credential, b.credential));
    for (const account of ordered) account.label = accountLabel(account.credential);
    disambiguateLabels(ordered);
    this.accounts = ordered;
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
      if (account.cooldownUntilMs > now) return false;
      if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
      if (region !== void 0 && (0, import_upstream.regionOf)(account.credential.domain) !== region) return false;
      return true;
    });
  }
  /**
   * Pick the account to serve a request.
   *
   * Two distributions, chosen by the `distribution` setting:
   *
   * - **priority** (default, and what the card ships with): one account serves
   *   every request until it is rate-limited, then the next in order takes over.
   *   Credits drain one account at a time, and a cooling account returns to the
   *   head of the queue the moment its window resets — it was never consumed, so
   *   it resumes straight away.
   * - **round-robin**: consecutive requests rotate through the pool so spend
   *   spreads evenly across every account.
   *
   * In both modes an explicit user selection (`prefer`) heads the list, a
   * cooling account is skipped for that model only, and an unrecognised setting
   * falls back to priority.
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
    return account;
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
   */
  async ensureFresh(account, forced = false) {
    if (this.client === void 0) return;
    const credential = account.credential;
    const expiring = forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS;
    if (!expiring) return;
    const existing = this.refreshInflight.get(account.id);
    if (existing !== void 0) {
      await existing;
      return;
    }
    const run = (async () => {
      if (credential.refreshToken === "") {
        if (credential.expiresAtMs > Date.now() + 3e4) return;
        this.logger?.warn(`pi-desktop-wtq-pool: ${account.label} token expired with no refresh token; sign in again`);
        return;
      }
      try {
        const outcome = await this.client.refreshToken(credential);
        if (account.credential !== credential) return;
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
          expiresAtMs: refreshExpiryMs(outcome.expiresInSec),
          ...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
        };
        this.logger?.info?.(`pi-desktop-wtq-pool: refreshed token for ${account.label}`);
      } catch (error) {
        if (credential.expiresAtMs > Date.now() + 3e4) {
          this.logger?.warn?.(`pi-desktop-wtq-pool: token refresh failed but token still valid for ${account.label}`, error);
        } else {
          this.logger?.error?.(`pi-desktop-wtq-pool: token refresh failed and token expired for ${account.label}`, error);
        }
      }
    })();
    this.refreshInflight.set(account.id, run);
    try {
      await run;
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
   */
  penalize(accountId, resetAtMs, modelId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return;
    account.rateLimitHits += 1;
    const now = Date.now();
    const raw = resetAtMs !== void 0 && resetAtMs > now ? resetAtMs : now + this.cooldownMs;
    const until = Math.min(raw, now + PENALIZE_CAP_MS);
    if (modelId !== void 0 && modelId !== "") {
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
      this.logger?.warn(
        `pi-desktop-wtq-pool: ${account.label} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`
      );
      return;
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
    this.logger?.warn(
      `pi-desktop-wtq-pool: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`
    );
  }
  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns() {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0;
      account.modelCooldowns = {};
      account.rateLimitHits = 0;
    }
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
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_LIVE_FILENAME,
  WorkBuddyAccountPool,
  candidateAuthDirs,
  defaultDesktopAuthDirs,
  parseWorkBuddyAuth,
  pickSoonestExpiry,
  workbuddyAccountId
});
