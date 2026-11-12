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
  legacyWorkBuddyAccountId: () => legacyWorkBuddyAccountId,
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
var import_file_lock = require("./file-lock");
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
function expiryToMs(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ms = value > 1e12 ? value : value * 1e3;
  return ms > import_upstream.MAX_EXPIRY_MS ? 0 : ms;
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
  const refreshField = encryptedField(auth["refreshToken"]);
  const refreshToken = decryptableString(auth["refreshToken"], decrypt);
  const refreshExpired = refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now();
  const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
  const nickname = optionalString(decryptableString(identity["nickname"], decrypt));
  return {
    accessToken,
    refreshToken: refreshExpired ? "" : refreshToken,
    ...!refreshExpired && refreshField !== void 0 && refreshToken === "" ? { refreshTokenUnavailable: true } : {},
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
function encryptedField(value) {
  if (typeof value === "string") {
    if (!value.trimStart().startsWith("{")) return void 0;
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      return /"\$wbEncrypted"\s*:/u.test(text) ? null : void 0;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "$wbEncrypted") ? value : void 0;
}
function decryptableString(value, decrypt) {
  const field = encryptedField(value);
  if (field !== void 0) {
    if (!(0, import_at_rest.isEncryptedFieldWrapper)(field)) return "";
    try {
      return decrypt?.(field) ?? "";
    } catch {
    }
    return "";
  }
  return typeof value === "string" ? value : "";
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
  const ordering = compareFreshness(candidate, incumbent, ownDir);
  if (candidate.accessToken !== incumbent.accessToken) return ordering < 0;
  if (candidate.refreshTokenUnavailable && incumbent.refreshToken !== "") return false;
  if (ordering !== 0) return ordering < 0;
  if (candidate.sourcePath === incumbent.sourcePath) {
    return candidate.refreshToken !== incumbent.refreshToken || candidate.refreshTokenUnavailable !== incumbent.refreshTokenUnavailable;
  }
  return false;
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
const MISSING_FILE_STAMP = "missing";
async function signInFileStamp(file) {
  try {
    const entry = await (0, import_promises.stat)(file);
    return `${entry.mtimeMs}:${entry.size}`;
  } catch (error) {
    const code = error.code;
    return code === "ENOENT" || code === "ENOTDIR" ? MISSING_FILE_STAMP : void 0;
  }
}
async function readDeletedSignInsFile(file) {
  const parsed = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
  const tombstones = /* @__PURE__ */ new Map();
  const entries = parsed?.entries;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return tombstones;
  for (const [id, value] of Object.entries(entries)) {
    const record = deletedSignInFrom(value);
    if (record !== void 0) tombstones.set(id, record);
  }
  return tombstones;
}
function deletedSignInFrom(value) {
  const entry = value;
  if (entry === null || typeof entry !== "object") return void 0;
  const digest = entry.tokenDigest;
  if (typeof digest !== "string" || digest === "") return void 0;
  const issued = entry.lastRefreshAtMs;
  const deletedAt = entry.deletedAtMs;
  const nonce = entry.nonce;
  const alternates = Array.isArray(entry.alternates) ? entry.alternates.flatMap((alternate) => {
    const record = deletedSignInFrom(alternate);
    return record === void 0 ? [] : [record];
  }) : [];
  return {
    tokenDigest: digest,
    lastRefreshAtMs: typeof issued === "number" && Number.isFinite(issued) ? issued : 0,
    deletedAtMs: typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : 0,
    ...typeof nonce === "string" && nonce !== "" ? { nonce } : {},
    ...alternates.length > 0 ? { alternates } : {}
  };
}
function endsTombstone(tombstone, credential) {
  if (tokenDigest(credential.accessToken) === tombstone.tokenDigest) return false;
  const issued = credential.lastRefreshAtMs ?? 0;
  if (tombstone.lastRefreshAtMs > 0 && issued > 0) return issued > tombstone.lastRefreshAtMs;
  if (tombstone.lastRefreshAtMs === 0 && issued > 0) return issued >= tombstone.deletedAtMs;
  return isLiveAuthFile(credential.sourcePath);
}
function tombstoneOf(tombstones, credential, currentId = workbuddyAccountId(credential)) {
  const record = tombstones.get(currentId);
  if (record !== void 0) return { key: currentId, record, current: true };
  for (const previous of previousAccountIds(credential)) {
    const old = tombstones.get(previous);
    if (old !== void 0) return { key: previous, record: old, current: false };
  }
  return void 0;
}
function namesNewerSignIn(candidate, current) {
  if (candidate.lastRefreshAtMs > 0 && current.lastRefreshAtMs === 0) return true;
  if (candidate.lastRefreshAtMs === 0 && current.lastRefreshAtMs > 0) return false;
  if (candidate.lastRefreshAtMs > 0 && current.lastRefreshAtMs > 0 && candidate.lastRefreshAtMs !== current.lastRefreshAtMs) {
    return candidate.lastRefreshAtMs > current.lastRefreshAtMs;
  }
  return candidate.deletedAtMs > current.deletedAtMs;
}
function recordsOf(entry) {
  if (entry.alternates === void 0) return [entry];
  return [entry, ...entry.alternates.flatMap((record) => recordsOf(record))];
}
function withoutAlternates(record) {
  const { alternates: _ignored, ...bare } = record;
  return bare;
}
function sameDeletedSignIn(left, right) {
  if (left.nonce !== void 0 || right.nonce !== void 0) return left.nonce === right.nonce;
  return left.tokenDigest === right.tokenDigest && left.lastRefreshAtMs === right.lastRefreshAtMs && left.deletedAtMs === right.deletedAtMs;
}
function deletedSignInFromRecords(records) {
  if (records.length === 0) return void 0;
  const [primary, ...alternates] = records;
  const bare = withoutAlternates(primary);
  return alternates.length === 0 ? bare : { ...bare, alternates: alternates.map(withoutAlternates) };
}
function mergeDeletedSignIns(existing, candidate) {
  if (existing === void 0) return withoutAlternates(candidate);
  const records = [...recordsOf(existing)];
  const bare = withoutAlternates(candidate);
  if (!records.some((record) => sameDeletedSignIn(record, bare))) records.push(bare);
  let primary = 0;
  for (let index = 1; index < records.length; index += 1) {
    if (namesNewerSignIn(records[index], records[primary])) primary = index;
  }
  const [chosen] = records.splice(primary, 1);
  return deletedSignInFromRecords([chosen, ...records]);
}
function dropDeletedSignIns(entry, targets) {
  const kept = recordsOf(entry).filter((record) => !targets.some((target) => sameDeletedSignIn(record, target)));
  if (kept.length === recordsOf(entry).length) return entry;
  return deletedSignInFromRecords(kept);
}
function tombstoneBlocks(entry, credential) {
  if (entry.current) return recordsOf(entry.record).some((record) => !endsTombstone(record, credential));
  const digest = tokenDigest(credential.accessToken);
  return recordsOf(entry.record).some((record) => digest === record.tokenDigest);
}
function ownSignInPath(sourcePath, ownDir) {
  if (ownDir === "" || sourcePath === "") return false;
  const walked = (0, import_node_path.relative)((0, import_node_path.resolve)(ownDir), (0, import_node_path.resolve)(sourcePath));
  return walked !== "" && !walked.startsWith("..") && !(0, import_node_path.isAbsolute)(walked);
}
function workbuddyAccountId(credential) {
  const stable = credential.uin ?? credential.uid ?? `${credential.nickname ?? ""}\0${credential.sourcePath}`;
  return (0, import_node_crypto.createHash)("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
function legacyWorkBuddyAccountId(credential) {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? `path:${credential.sourcePath}`;
  return (0, import_node_crypto.createHash)("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
function previousAccountIds(credential) {
  if ((credential.uin ?? credential.uid) !== void 0) return [];
  const previous = legacyWorkBuddyAccountId(credential);
  return previous === workbuddyAccountId(credential) ? [] : [previous];
}
function accountLabel(credential) {
  return credential.nickname ?? "WorkBuddy";
}
function foldSessionCopies(credentials, ownDir) {
  const isOwn = (credential) => ownSignInPath(credential.sourcePath, ownDir);
  const identityLess = (credential) => (credential.uin ?? credential.uid ?? "") === "";
  const tokenKey = (credential) => {
    if (!identityLess(credential)) return "";
    const token = credential.refreshToken || credential.accessToken;
    return token === "" ? "" : credential.domain + "\0" + token;
  };
  const nameKey = (credential) => {
    if (!identityLess(credential) || (credential.nickname ?? "") === "") return "";
    return credential.domain + "\0" + credential.nickname;
  };
  const copiedTokens = /* @__PURE__ */ new Set();
  for (const credential of credentials) {
    const key = tokenKey(credential);
    if (key !== "" && isOwn(credential)) copiedTokens.add(key);
  }
  const rankOf = (credential) => isLiveAuthFile(credential.sourcePath) ? 3 : ownSignInPath(credential.sourcePath, ownDir) ? 2 : 1;
  const best = /* @__PURE__ */ new Map();
  for (const credential of credentials) {
    const key = tokenKey(credential);
    if (key === "" || !copiedTokens.has(key)) continue;
    const current = best.get(key);
    if (current === void 0 || rankOf(credential) > rankOf(current) || rankOf(credential) === rankOf(current) && isFresher(credential, current, ownDir)) {
      best.set(key, credential);
    }
  }
  const ownedNames = /* @__PURE__ */ new Set();
  for (const credential of credentials) {
    const key = nameKey(credential);
    if (key !== "" && isOwn(credential)) ownedNames.add(key);
  }
  const bestOwned = /* @__PURE__ */ new Map();
  for (const credential of credentials) {
    const key = nameKey(credential);
    if (key === "" || !ownedNames.has(key) || !isOwn(credential)) continue;
    const current = bestOwned.get(key);
    if (current === void 0 || isFresher(credential, current, ownDir)) bestOwned.set(key, credential);
  }
  return credentials.filter((credential) => {
    const key = tokenKey(credential);
    if (key !== "" && copiedTokens.has(key) && best.get(key) !== credential) return false;
    const name = nameKey(credential);
    if (name === "" || !ownedNames.has(name)) return true;
    if (isLiveAuthFile(credential.sourcePath)) return true;
    if (isOwn(credential)) return bestOwned.get(name) === credential;
    return false;
  });
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
  } catch (error) {
    const code = error.code;
    return { unavailable: code !== "ENOENT" && code !== "ENOTDIR" };
  }
  const files = entries.filter((name) => name.endsWith(".info"));
  files.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
  return { files: files.map((name) => (0, import_node_path.join)(dir, name)), unavailable: false };
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
  return encryptedField(auth["accessToken"]) !== void 0;
}
function sealedIdentity(text, sourcePath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const document = parsed;
  const account = typeof document["account"] === "object" && document["account"] !== null && !Array.isArray(document["account"]) ? document["account"] : document;
  const uin = typeof account["uin"] === "string" && account["uin"] !== "" ? account["uin"] : void 0;
  const uid = typeof account["uid"] === "string" && account["uid"] !== "" ? account["uid"] : void 0;
  if (uin === void 0 && uid === void 0) return void 0;
  return workbuddyAccountId({ uin, uid, nickname: void 0, sourcePath });
}
async function readCredential(path) {
  let text;
  try {
    text = await (0, import_promises.readFile)(path, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unreadable" };
  }
  const decrypt = text.includes('"$wbEncrypted"') || text.includes('\\"$wbEncrypted\\"') ? await (0, import_at_rest.encryptedFieldOpener)() : void 0;
  const credential = parseWorkBuddyAuth(text, path, decrypt);
  if (credential !== void 0) return { kind: "credential", credential };
  if (sealedAccessToken(text)) return { kind: "sealed", id: sealedIdentity(text, path) };
  try {
    JSON.parse(text);
    return { kind: "absent" };
  } catch {
    return { kind: "unreadable" };
  }
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
async function writeOwnSignIn(directory, signIn, signal) {
  const file = ownSignInFile(directory, signIn);
  return await withSignInWriteLock(file, async () => {
    await writeOwnSignInDocument(file, signIn, signal);
    return file;
  });
}
const signInWriteQueues = /* @__PURE__ */ new Map();
async function withSignInWriteLock(file, work) {
  const previous = signInWriteQueues.get(file) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(() => void 0, () => void 0);
  signInWriteQueues.set(file, settled);
  try {
    return await run;
  } finally {
    if (signInWriteQueues.get(file) === settled) signInWriteQueues.delete(file);
  }
}
function ownSignInFile(directory, signIn) {
  const stable = signIn.uin === "" ? signIn.uid : signIn.uin;
  const suffix = stable === "" ? (0, import_node_crypto.randomUUID)() : stable.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return (0, import_node_path.join)(directory, `${OWN_SIGN_IN_PREFIX}${suffix === "" ? (0, import_node_crypto.randomUUID)() : suffix}.info`);
}
async function writeOwnSignInDocument(file, signIn, signal) {
  signal?.throwIfAborted();
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(file), { recursive: true, mode: 448 });
  signal?.throwIfAborted();
  await removeAbandonedTemps(file);
  const temporary = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
  try {
    await (0, import_promises.writeFile)(temporary, JSON.stringify({
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
    signal?.throwIfAborted();
    await (0, import_file_lock.replaceFile)(temporary, file);
  } catch (error) {
    await (0, import_promises.unlink)(temporary).catch(() => {
    });
    throw error;
  }
}
async function renewOwnSignInFile(file, credential, previous, createIfMissing = false, beforeCommit) {
  return await withSignInWriteLock(file, async () => {
    await removeAbandonedTemps(file);
    let text;
    try {
      text = await (0, import_promises.readFile)(file, "utf8");
    } catch (error) {
      if (!createIfMissing || error.code !== "ENOENT") throw error;
      if (beforeCommit !== void 0 && !await beforeCommit()) return false;
      await writeOwnSignInDocument(file, ownSignInOf(credential));
      if (beforeCommit !== void 0 && !await beforeCommit()) {
        await (0, import_promises.unlink)(file).catch(() => {
        });
        return false;
      }
      return true;
    }
    const document = JSON.parse(text);
    const auth = document.auth ?? {};
    if (auth.accessToken !== previous.accessToken) {
      const onDisk = parseWorkBuddyAuth(text, file);
      if (onDisk === void 0) throw new Error("sign-in changed while the token refresh was in flight");
      if (isFresher(onDisk, previous, (0, import_node_path.dirname)(file))) return false;
    }
    auth.accessToken = credential.accessToken;
    auth.refreshToken = credential.refreshToken;
    auth.expiresAt = credential.expiresAtMs;
    auth.lastRefreshTime = credential.lastRefreshAtMs ?? Date.now();
    document.auth = auth;
    const temporary = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
    try {
      await (0, import_promises.writeFile)(temporary, JSON.stringify(document, null, 2), { mode: 384 });
      if (beforeCommit !== void 0 && !await beforeCommit()) {
        await (0, import_promises.unlink)(temporary).catch(() => {
        });
        return false;
      }
      await (0, import_file_lock.replaceFile)(temporary, file);
      if (beforeCommit !== void 0 && !await beforeCommit()) {
        await (0, import_promises.unlink)(file).catch(() => {
        });
        return false;
      }
      return true;
    } catch (error) {
      await (0, import_promises.unlink)(temporary).catch(() => {
      });
      throw error;
    }
  });
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
  dirs.push(...defaultDesktopAuthDirs(process.platform, (0, import_node_os.homedir)(), env));
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
    const expiresAt = typeof record["expiresAtMs"] === "number" ? expiryToMs(record["expiresAtMs"]) : 0;
    const refreshExpiresAt = typeof record["refreshExpiresAtMs"] === "number" ? expiryToMs(record["refreshExpiresAtMs"]) : 0;
    const lastRefreshAt = typeof record["lastRefreshAtMs"] === "number" ? expiryToMs(record["lastRefreshAtMs"]) : 0;
    const lastUsable = Math.max(expiresAt, refreshExpiresAt);
    if (lastUsable > 0 && lastUsable < horizon) continue;
    stored.set(record["id"], {
      accessToken: record["accessToken"],
      refreshToken: typeof record["refreshToken"] === "string" ? record["refreshToken"] : "",
      expiresAtMs: expiresAt,
      ...refreshExpiresAt === 0 ? {} : { refreshExpiresAtMs: refreshExpiresAt },
      ...lastRefreshAt === 0 ? {} : { lastRefreshAtMs: lastRefreshAt },
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
const ABANDONED_TEMP_MAX_AGE_MS = 10 * 60 * 1e3;
async function removeAbandonedTemps(file, minAgeMs = ABANDONED_TEMP_MAX_AGE_MS) {
  const prefix = `${(0, import_node_path.basename)(file)}.`;
  let names;
  try {
    names = await (0, import_promises.readdir)((0, import_node_path.dirname)(file));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const id = name.slice(prefix.length, -4);
    if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(id)) continue;
    const candidate = (0, import_node_path.join)((0, import_node_path.dirname)(file), name);
    if (minAgeMs > 0) {
      const info = await (0, import_promises.stat)(candidate).catch(() => void 0);
      if (info === void 0 || Date.now() - info.mtimeMs < minAgeMs) continue;
    }
    await (0, import_promises.unlink)(candidate).catch(() => {
    });
  }
}
async function removeAbandonedSignInTemps(directory) {
  let names;
  try {
    names = await (0, import_promises.readdir)(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^workbuddy-panel-.*\.info\.[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\.tmp$/iu.test(name)) continue;
    const file = (0, import_node_path.join)(directory, name);
    const info = await (0, import_promises.stat)(file).catch(() => void 0);
    if (info === void 0 || Date.now() - info.mtimeMs < ABANDONED_TEMP_MAX_AGE_MS) continue;
    await (0, import_promises.unlink)(file).catch(() => {
    });
  }
}
async function writeArchivedCredentials(file, entries, signal) {
  signal?.throwIfAborted();
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(file), { recursive: true, mode: 448 });
  signal?.throwIfAborted();
  await removeAbandonedTemps(file);
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
    signal?.throwIfAborted();
    await (0, import_file_lock.replaceFile)(temporary, file);
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
  /**
   * Last account handed out per region, for round-robin.
   *
   * Both region shims share one pool, and filtering to the caller's region
   * before indexing used to make each region renormalise the same cursor
   * against its own length: with two accounts per region, alternating turns
   * served the same account in each region and never reached the others.
   * A stored id also survives the pool shrinking between picks: an account
   * whose refresh fails is excluded from the retry, and a numeric position
   * would then point at an account that already had its turn.
   */
  lastServed = /* @__PURE__ */ new Map();
  /** Sticky mode: conversation key → account id. Content stays out of memory. */
  sticky = /* @__PURE__ */ new Map();
  /**
   * Account id → the order in which it last served. A readout only: the composer
   * shows the account a sticky conversation is on, and that account is the one
   * that just answered. A counter rather than a clock, because two acquires can
   * land in the same millisecond. Not persisted; after a restart the rotation
   * starts over.
   */
  servedOrder = /* @__PURE__ */ new Map();
  servedCount = 0;
  lastScanAtMs = 0;
  preferredIds = /* @__PURE__ */ new Map();
  /**
   * Account ids the user removed from the pool.
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
  scanAbort = new AbortController();
  /** A committed delete retires scans that read the roster before it. */
  rosterRevision = 0;
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
   * Account id → when an upstream 5xx cooldown ends.
   *
   * A 5xx is not a frequency wall, and reporting it as one on the next request
   * sent the user looking for a limit that never existed. Kept beside the
   * cooldown so `ineligible` can name the cause while the account is out.
   */
  serverCooldowns = /* @__PURE__ */ new Map();
  /**
   * Accounts the desktop client is signed into right now.
   *
   * The pool renews one of these into its own directory when the app's session
   * runs out, and serves that copy until the app writes a newer one. Renewing it
   * does not make it the pool's own account: the app still holds the session, and
   * a delete would hide the account from the pool while the user believed they
   * were removing something the plugin had added.
   */
  appHeldFiles = /* @__PURE__ */ new Map();
  /** An unreadable live sign-in whose account cannot be identified. */
  unknownLiveSignIn = false;
  /** Unknown live files stay protected while their directory cannot answer. */
  unknownLiveFiles = /* @__PURE__ */ new Set();
  /** Accounts whose desktop live sign-in is present but currently unreadable. */
  refreshBlockedIds = /* @__PURE__ */ new Set();
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
        this.clear();
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
    this.logger?.info?.(`${import_log.LOG_PREFIX}: ${(0, import_log.accountLogTag)(account.label)} has credits again; releasing the hold`);
  }
  /** True when a known balance has reached the floor set for this account. */
  reserveHolds(account) {
    const floor = this.storedValue(this.creditReserves, account);
    if (floor === void 0 || floor <= 0) return false;
    const balance = this.creditBalances.get(account.id);
    return balance !== void 0 && balance <= floor;
  }
  /** Whether this account was switched off on the panel. */
  isDisabled(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    return account === void 0 ? this.disabledIds.has(accountId) : this.storedIdMatches(this.disabledIds, account);
  }
  /** The credit floor in force for one account. */
  creditReserve(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    return account === void 0 ? this.creditReserves.get(accountId) : this.storedValue(this.creditReserves, account);
  }
  /**
   * Every key this account may still be recorded under in persisted settings.
   *
   * The panel writes by current id, so a toggle has to clear the older keys
   * too; otherwise an old entry stays behind and takes effect again the moment
   * the current one is removed. An old key shared with another row is not a key
   * for this account: settings already ignore it, and purging its archive entry
   * on delete would take the other row's copy with it.
   */
  storedIds(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return [accountId];
    return [accountId, ...previousAccountIds(account.credential).filter((id) => this.legacyKeyUnique(account, id))];
  }
  /** Whether a stored id set names this account under any of its keys. */
  storedIdMatches(stored, account) {
    if (stored.has(account.id)) return true;
    return previousAccountIds(account.credential).some((id) => stored.has(id) && this.legacyKeyUnique(account, id));
  }
  /** A value stored under any of this account's keys; current wins. */
  storedValue(stored, account) {
    const current = stored.get(account.id);
    if (current !== void 0) return current;
    for (const id of previousAccountIds(account.credential)) {
      if (!this.legacyKeyUnique(account, id)) continue;
      const value = stored.get(id);
      if (value !== void 0) return value;
    }
    return void 0;
  }
  /**
   * Whether a 1.2.3 key names this row and no other one.
   *
   * That key hashed a nickname alone, so two identity-less sign-ins can share
   * it. Applying it to both would switch off or remove an account the user
   * never touched; an ambiguous key is therefore ignored rather than guessed.
   */
  legacyKeyUnique(account, key) {
    const claimants = this.accounts.filter((item) => item.id === key || previousAccountIds(item.credential).includes(key));
    return claimants.length === 1 && claimants[0]?.id === account.id;
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
    if (account === void 0 || this.unknownLiveSignIn || [...this.appHeldFiles.values()].includes(accountId)) return false;
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
    const ownedPath = account.credential.sourcePath;
    if (!this.isOwnSignInPath(ownedPath)) return false;
    const deletingCredential = account.credential;
    const sameCredential = (credential) => credential.accessToken === deletingCredential.accessToken && credential.refreshToken === deletingCredential.refreshToken;
    const running = this.scanInflight;
    const recorded = await this.rememberDeletedSignIn(account.id, account.credential);
    if (recorded === void 0) throw new Error("could not record the deleted sign-in");
    const rollbackTombstone = async () => {
      const drop = async () => await this.updateDeletedSignIns((tombstones) => {
        const current2 = tombstones.get(account.id);
        if (current2 === void 0) return true;
        const kept = dropDeletedSignIns(current2, [recorded.written]);
        if (kept === void 0) tombstones.delete(account.id);
        else if (kept !== current2) tombstones.set(account.id, kept);
        return true;
      }) === true;
      return await drop() || await drop();
    };
    const fail = async () => {
      if (!await rollbackTombstone()) {
        this.logger?.error?.(`${import_log.LOG_PREFIX}: could not remove the tombstone of a failed delete for ${(0, import_log.accountLogTag)(account.label)}; the account stays hidden until the deleted sign-ins can be written again`);
      }
    };
    const settled = running === void 0 ? true : await raceWithTimeout(running.catch(() => {
    }), DELETE_SCAN_WAIT_MS);
    const current = this.accounts.find((item) => item.id === account.id);
    let replaced = current !== void 0 && (!this.ownsSignIn(account.id) || (0, import_node_path.resolve)(current.credential.sourcePath) !== (0, import_node_path.resolve)(ownedPath) || !sameCredential(current.credential));
    if (current === void 0) {
      const tombstone = (await this.loadDeletedSignIns())?.get(account.id);
      replaced = tombstone === void 0 || !tombstoneBlocks({ record: tombstone, current: true }, deletingCredential);
    }
    const onDisk = await readCredential(ownedPath);
    if (!replaced) {
      replaced = onDisk.kind === "sealed" || onDisk.kind === "unreadable" || onDisk.kind === "credential" && (workbuddyAccountId(onDisk.credential) !== account.id || !sameCredential(onDisk.credential));
    }
    if (replaced) {
      await fail();
      return false;
    }
    try {
      const tombstoneFile = this.deletedSignInsFile();
      if (tombstoneFile === void 0) await (0, import_promises.unlink)(ownedPath);
      else await (0, import_file_lock.withFileLock)(`${tombstoneFile}.lock`, async () => {
        await (0, import_promises.unlink)(ownedPath);
      });
    } catch (error) {
      const code = error.code;
      if (!(error instanceof import_file_lock.FileLockReleaseError) && code !== "ENOENT") {
        await fail();
        this.rosterRevision += 1;
        await this.rescan().catch((rescanError) => {
          this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not restore the roster after a failed delete: ${String(rescanError)}`);
        });
        throw error;
      }
    }
    await removeAbandonedTemps(ownedPath, 0);
    this.rosterRevision += 1;
    const archivedIds = this.storedIds(account.id);
    if (!settled) {
      void running.catch(() => {
      }).then(() => this.forgetArchived(archivedIds));
    }
    await this.forgetArchived(archivedIds);
    const remaining = this.accounts.find((item) => item.id === account.id);
    if (remaining === void 0 || this.isOwnSignInPath(remaining.credential.sourcePath) && (0, import_node_path.resolve)(remaining.credential.sourcePath) === (0, import_node_path.resolve)(ownedPath)) {
      this.forgetAccount(account.id);
    }
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
    this.serverCooldowns.delete(accountId);
  }
  /**
   * Record one deleted sign-in, so no later scan puts the account back.
   *
   * The file is written before the delete is reported: a tombstone that only
   * lived in memory would be gone after a restart, and the snapshot it has to
   * hold off is still sitting in the client's directory. Answers undefined when
   * the record could not be written, so the delete can refuse to report success.
   */
  async rememberDeletedSignIn(id, credential) {
    const written = {
      tokenDigest: tokenDigest(credential.accessToken),
      lastRefreshAtMs: credential.lastRefreshAtMs ?? 0,
      deletedAtMs: Date.now(),
      nonce: (0, import_node_crypto.randomUUID)()
    };
    return await this.updateDeletedSignIns((tombstones) => {
      tombstones.set(id, mergeDeletedSignIns(tombstones.get(id), written));
      return { written };
    });
  }
  /**
   * Read the tombstones, re-reading when the file changed underneath us.
   *
   * Nothing is pruned by age. A deleted sign-in's copy is still lying in the
   * client's directory until the client overwrites it, so a tombstone that
   * expired would bring that copy straight back, refresh token included.
   */
  async loadDeletedSignIns(signal) {
    const file = this.deletedSignInsFile();
    const stamp = file === void 0 ? MISSING_FILE_STAMP : await signInFileStamp(file);
    if (stamp === void 0) return void 0;
    if (signal?.aborted) return this.deletedSignIns ?? /* @__PURE__ */ new Map();
    if (this.deletedSignIns !== void 0 && this.deletedSignInsStamp === stamp) return this.deletedSignIns;
    if (file === void 0) {
      this.deletedSignInsStamp = MISSING_FILE_STAMP;
      this.deletedSignIns = /* @__PURE__ */ new Map();
      return this.deletedSignIns;
    }
    try {
      const tombstones = await readDeletedSignInsFile(file);
      if (signal?.aborted) return this.deletedSignIns ?? /* @__PURE__ */ new Map();
      this.deletedSignInsStamp = stamp;
      this.deletedSignIns = tombstones;
      return tombstones;
    } catch (error) {
      if (signal?.aborted) return this.deletedSignIns ?? /* @__PURE__ */ new Map();
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.deletedSignInsStamp = MISSING_FILE_STAMP;
        this.deletedSignIns = /* @__PURE__ */ new Map();
        return this.deletedSignIns;
      }
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not read the deleted sign-ins: ${String(error)}`);
      return void 0;
    }
  }
  /**
   * Read-modify-write the tombstone document under its file lock.
   *
   * The change starts from what is on disk, never from the in-memory copy: a
   * second pool may have released a record this process still holds, and writing
   * the cached map back put that release in force again. `mutate` gets the current
   * records and answers whatever the caller needs; undefined means the document
   * could not be read or written, and nothing was persisted.
   */
  async updateDeletedSignIns(mutate, signal) {
    const file = this.deletedSignInsFile();
    if (file === void 0) {
      const tombstones = this.deletedSignIns ?? /* @__PURE__ */ new Map();
      const answer2 = mutate(tombstones);
      this.deletedSignIns = tombstones;
      this.deletedSignInsStamp = MISSING_FILE_STAMP;
      return answer2;
    }
    let answer;
    let written = false;
    try {
      await (0, import_file_lock.withFileLock)(`${file}.lock`, async () => {
        if (signal?.aborted) return;
        let onDisk;
        try {
          onDisk = await readDeletedSignInsFile(file);
        } catch (error) {
          if (error.code !== "ENOENT") {
            if (!signal?.aborted) {
              this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not read the deleted sign-ins to update them: ${String(error)}`);
            }
            return;
          }
          onDisk = /* @__PURE__ */ new Map();
        }
        if (signal?.aborted) return;
        const result = mutate(onDisk);
        if (signal?.aborted) return;
        const temporary = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
        try {
          signal?.throwIfAborted();
          await (0, import_promises.mkdir)((0, import_node_path.dirname)(file), { recursive: true, mode: 448 });
          signal?.throwIfAborted();
          await removeAbandonedTemps(file);
          await (0, import_promises.writeFile)(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(onDisk) }, null, 2), { mode: 384 });
          signal?.throwIfAborted();
          await (0, import_file_lock.replaceFile)(temporary, file);
          const stamp = await signInFileStamp(file);
          answer = result;
          written = true;
          if (!signal?.aborted) {
            this.deletedSignIns = onDisk;
            this.deletedSignInsStamp = stamp;
          }
        } catch (error) {
          await (0, import_promises.unlink)(temporary).catch(() => {
          });
          if (!signal?.aborted) this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not record the deleted sign-ins: ${String(error)}`);
        }
      });
    } catch (error) {
      if (!signal?.aborted) {
        this.logger?.warn?.(written ? `${import_log.LOG_PREFIX}: the deleted sign-ins were saved but their lock was not released: ${String(error)}` : `${import_log.LOG_PREFIX}: could not lock the deleted sign-ins: ${String(error)}`);
      }
    }
    return answer;
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
  async adoptOrphanedSignIns(found, tornDown, sealedLiveIds, unknownLiveDirs, signal) {
    const directory = ownSignInDir(this.dataPath?.() ?? "");
    if (directory === "") return [];
    const latest = await this.loadDeletedSignIns(signal);
    if (latest === void 0) return [];
    const liveIds = new Set(sealedLiveIds);
    const ownedIds = /* @__PURE__ */ new Set();
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      if (isLiveAuthFile(credential.sourcePath)) liveIds.add(id);
      else if (ownSignInPath(credential.sourcePath, directory)) ownedIds.add(id);
    }
    const adopted = [];
    for (const credential of found) {
      if (signal.aborted) break;
      if (isLiveAuthFile(credential.sourcePath)) continue;
      if (ownSignInPath(credential.sourcePath, directory)) continue;
      const id = workbuddyAccountId(credential);
      if (unknownLiveDirs.has(this.homeOf(credential)) || liveIds.has(id) || ownedIds.has(id) || tornDown.has(id)) continue;
      const entry = tombstoneOf(latest, credential, id);
      if (entry !== void 0 && tombstoneBlocks(entry, credential)) continue;
      if ((credential.uin ?? credential.uid ?? "") === "") continue;
      let file;
      try {
        file = await writeOwnSignIn(directory, { ...ownSignInOf(credential), lastRefreshAtMs: credential.lastRefreshAtMs ?? 0 }, signal);
      } catch (error) {
        if (signal.aborted) break;
        this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not take over ${(0, import_log.accountLogTag)(accountLabel(credential))}: ${String(error)}`);
        continue;
      }
      const adoptedCredential = { ...credential, sourcePath: file };
      const after = await this.loadDeletedSignIns(signal);
      const afterEntry = after === void 0 ? void 0 : tombstoneOf(after, adoptedCredential, id);
      if (after === void 0 || afterEntry !== void 0 && tombstoneBlocks(afterEntry, adoptedCredential)) {
        await (0, import_promises.unlink)(file).catch(() => {
        });
        continue;
      }
      ownedIds.add(id);
      adopted.push(adoptedCredential);
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
  async renewOwnSignIn(previous, credential) {
    const guard = async () => await this.deleteDidNotTake(credential);
    if (this.isOwnSignInPath(previous.sourcePath)) {
      return await renewOwnSignInFile(previous.sourcePath, credential, previous, false, guard);
    }
    if ((credential.uin ?? credential.uid ?? "") === "") return true;
    const directory = ownSignInDir(this.dataPath?.() ?? "");
    if (directory === "") return true;
    const file = ownSignInFile(directory, ownSignInOf(credential));
    if (!await guard()) return false;
    const written = await renewOwnSignInFile(file, credential, previous, true, guard);
    if (written) credential.sourcePath = file;
    return written;
  }
  /**
   * Whether a delete still stands against this sign-in.
   *
   * A delete records a tombstone, unlinks the file, and reports success. A
   * renewal over the same sign-in used to race that: its rename landed after
   * the unlink, the file came back with a token issued after the tombstone, and
   * `endsTombstone` read the recreation as a re-login and cleared the record -
   * a deleted account came back.
   *
   * The token's issue time cannot order the two acts. A rotation that started
   * after the delete, from an account still held in memory, also mints a token
   * newer than the record. What is known instead is which sign-in a record
   * names: a current-key record names this exact account, and only a scan
   * releases it for a sign-in the user made after the delete - before that
   * account can be refreshed again. So the presence of the record is enough.
   * A 1.2.3 record cannot tell two sign-ins apart and stays digest-matched.
   *
   * The set is read under the lock a delete writes it with, so a delete that
   * committed a moment ago is visible. Nothing blocking runs under that lock.
   */
  async deleteDidNotTake(credential) {
    const file = this.deletedSignInsFile();
    if (file === void 0) return true;
    const present = await (0, import_promises.stat)(file).then(() => true, (error) => error.code !== "ENOENT");
    if (!present) return true;
    let alive = true;
    try {
      await (0, import_file_lock.withFileLock)(`${file}.lock`, async () => {
        const tombstones = await this.loadDeletedSignIns();
        if (tombstones === void 0) {
          alive = false;
          return;
        }
        const entry = tombstoneOf(tombstones, credential);
        if (entry !== void 0 && (entry.current || tombstoneBlocks(entry, credential))) alive = false;
      });
    } catch (error) {
      if (!(error instanceof import_file_lock.FileLockReleaseError)) throw error;
    }
    return alive;
  }
  /**
   * Drop one account from the credential archive.
   *
   * On the same queue as every other archive write: this is a read-modify-write
   * of one document, and a delete that raced a scan's write would otherwise be
   * overwritten by it.
   */
  async forgetArchived(ids) {
    const file = this.archiveFile();
    if (file === void 0) return;
    const run = this.archiveQueue.then(async () => {
      await (0, import_file_lock.withFileLock)(`${file}.lock`, async () => {
        const stored = await readArchivedCredentials(file);
        let dropped = false;
        for (const id of ids) dropped = stored.delete(id) || dropped;
        if (!dropped) return;
        await writeArchivedCredentials(file, stored);
      });
    });
    this.archiveQueue = run.catch(() => {
    });
    try {
      await run;
    } catch (error) {
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not drop a sign-in from the credential archive: ${String(error)}`);
    }
  }
  /** Drop every account, e.g. when the source is switched off. A later `scan()` rebuilds from disk. */
  clear() {
    this.scanAbort.abort();
    this.scanAbort = new AbortController();
    this.scanInflight = void 0;
    this.scanDirs = [];
    this.accounts = [];
    this.appHeldFiles = /* @__PURE__ */ new Map();
    this.unknownLiveSignIn = false;
    this.unknownLiveFiles = /* @__PURE__ */ new Set();
    this.refreshBlockedIds = /* @__PURE__ */ new Set();
    this.serverCooldowns.clear();
    this.refreshInflight.clear();
  }
  /** Read after any scan already running, so a manual request gets a fresh snapshot. */
  async rescan() {
    const signal = this.scanAbort.signal;
    await this.scanInflight?.catch(() => {
    });
    if (signal.aborted) return this.accounts;
    return this.scan();
  }
  /** Scan the auth directories and merge newly discovered accounts. */
  async scan() {
    const dirs = this.scanDirsFor(this.authDirs);
    if (this.scanInflight !== void 0 && sameDirs(this.scanDirs, dirs)) return this.scanInflight;
    const inflight = this.scanOnce(dirs, this.scanAbort.signal).finally(() => {
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
  async archiveCredentials(credentials, signal) {
    const file = this.archiveFile();
    if (file === void 0 || credentials.length === 0) return;
    const ownDir = ownSignInDir(this.dataPath?.() ?? "");
    let committed = false;
    let wrote = false;
    const run = this.archiveQueue.then(async () => {
      await (0, import_file_lock.withFileLock)(`${file}.lock`, async () => {
        if (signal?.aborted) return;
        const stored = await readArchivedCredentials(file);
        if (signal?.aborted) return;
        const tombstones = await this.loadDeletedSignIns(signal);
        if (tombstones === void 0) return;
        let changed = false;
        for (const credential of credentials) {
          const id = workbuddyAccountId(credential);
          const entry = tombstoneOf(tombstones, credential, id);
          if (entry !== void 0 && (entry.current || tombstoneBlocks(entry, credential))) continue;
          const previous = stored.get(id);
          if (previous !== void 0 && !isFresher(credential, previous, ownDir)) continue;
          stored.set(id, credential);
          changed = true;
        }
        if (changed) {
          await writeArchivedCredentials(file, stored, signal);
          wrote = true;
        }
        committed = true;
      });
    });
    this.archiveQueue = run.catch(() => {
    });
    try {
      await run;
    } catch (error) {
      if (!signal?.aborted) {
        const message = !committed ? "could not update the credential archive" : wrote ? "the credential archive was saved but its lock was not released" : "the credential archive is current but its lock was not released";
        this.logger?.warn?.(`${import_log.LOG_PREFIX}: ${message}: ${String(error)}`);
      }
    }
  }
  /** Credentials the archive kept for a directory this walk can read. */
  async archivedCredentials(homes) {
    const file = this.archiveFile();
    if (file === void 0) return [];
    try {
      let stored = /* @__PURE__ */ new Map();
      await (0, import_file_lock.withFileLock)(`${file}.lock`, async () => {
        await removeAbandonedTemps(file);
        stored = await readArchivedCredentials(file);
      });
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
  async scanOnce(dirs, signal = this.scanAbort.signal) {
    const rosterRevision = this.rosterRevision;
    const found = [];
    const readableDirs = /* @__PURE__ */ new Set();
    const sealedDirs = /* @__PURE__ */ new Set();
    const sealedFiles = /* @__PURE__ */ new Set();
    const sealedFileIds = /* @__PURE__ */ new Map();
    const unreadableFiles = /* @__PURE__ */ new Set();
    const unavailableDirs = /* @__PURE__ */ new Set();
    const ownDir = ownSignInDir(this.dataPath?.() ?? "");
    for (const dir of dirs) {
      if (signal.aborted) return this.accounts;
      if (ownDir !== "" && (0, import_node_path.resolve)(dir) === (0, import_node_path.resolve)(ownDir)) await removeAbandonedSignInTemps(dir);
      const read = await authFilesIn(dir);
      if (signal.aborted) return this.accounts;
      if (read.files === void 0) {
        if (read.unavailable) unavailableDirs.add((0, import_node_path.resolve)(dir));
        continue;
      }
      readableDirs.add((0, import_node_path.resolve)(dir));
      for (const file of read.files) {
        const credentialRead = await readCredential(file);
        if (signal.aborted) return this.accounts;
        if (credentialRead.kind === "credential") found.push(credentialRead.credential);
        else if (credentialRead.kind === "sealed") {
          sealedDirs.add((0, import_node_path.resolve)(dir));
          const resolvedFile = (0, import_node_path.resolve)(file);
          sealedFiles.add(resolvedFile);
          if (credentialRead.id !== void 0) sealedFileIds.set(resolvedFile, credentialRead.id);
        } else if (credentialRead.kind === "unreadable") {
          sealedDirs.add((0, import_node_path.resolve)(dir));
          unreadableFiles.add((0, import_node_path.resolve)(file));
        }
      }
    }
    const tombstones = await this.loadDeletedSignIns(signal);
    if (signal.aborted || rosterRevision !== this.rosterRevision) return this.accounts;
    if (tombstones === void 0) {
      this.lastScanAtMs = Date.now();
      return this.accounts;
    }
    const tornDown = /* @__PURE__ */ new Set();
    const released = /* @__PURE__ */ new Map();
    const held = [];
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const entry = tombstoneOf(tombstones, credential, id);
      if (entry === void 0) {
        held.push(credential);
        continue;
      }
      if (tombstoneBlocks(entry, credential)) {
        tornDown.add(id);
        continue;
      }
      if (entry.current) {
        released.set(entry.key, entry.record);
      }
      held.push(credential);
    }
    found.length = 0;
    found.push(...held);
    for (const id of tombstones.keys()) {
      if (!released.has(id)) tornDown.add(id);
    }
    if (released.size > 0) {
      await this.updateDeletedSignIns((entries) => {
        for (const [id, record] of released) {
          const current = entries.get(id);
          if (current === void 0) continue;
          const kept = dropDeletedSignIns(current, recordsOf(record));
          if (kept === void 0) entries.delete(id);
          else if (kept !== current) entries.set(id, kept);
        }
      }, signal);
    }
    if (signal.aborted || rosterRevision !== this.rosterRevision) return this.accounts;
    const latest = await this.loadDeletedSignIns(signal);
    if (signal.aborted || rosterRevision !== this.rosterRevision) return this.accounts;
    if (latest === void 0) {
      this.lastScanAtMs = Date.now();
      return this.accounts;
    }
    const walkedIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
    for (const id of latest.keys()) {
      if (!walkedIds.has(id)) tornDown.add(id);
    }
    for (let index = found.length - 1; index >= 0; index -= 1) {
      const credential = found[index];
      const id = workbuddyAccountId(credential);
      const entry = tombstoneOf(latest, credential, id);
      if (entry !== void 0 && tombstoneBlocks(entry, credential)) {
        tornDown.add(id);
        found.splice(index, 1);
      }
    }
    const sealedLiveIds = new Set(sealedFileIds.values());
    for (let index = found.length - 1; index >= 0; index -= 1) {
      const credential = found[index];
      if (isLiveAuthFile(credential.sourcePath)) continue;
      if (ownSignInPath(credential.sourcePath, ownSignInDir(this.dataPath?.() ?? ""))) continue;
      const id = workbuddyAccountId(credential);
      if (sealedLiveIds.has(id) || sealedDirs.has(this.homeOf(credential))) found.splice(index, 1);
    }
    await this.archiveCredentials(found, signal);
    if (signal.aborted || rosterRevision !== this.rosterRevision) return this.accounts;
    found.push(...await this.adoptOrphanedSignIns(
      found,
      tornDown,
      sealedLiveIds,
      sealedDirs,
      signal
    ));
    if (signal.aborted || rosterRevision !== this.rosterRevision) return this.accounts;
    const signInTokens = /* @__PURE__ */ new Map();
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const held2 = signInTokens.get(id);
      if (held2 === void 0) signInTokens.set(id, [credential]);
      else held2.push(credential);
    }
    const liveIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
    const appHeld = /* @__PURE__ */ new Map();
    for (const [file, id] of this.appHeldFiles) {
      if (sealedFiles.has(file) || unreadableFiles.has(file) || !readableDirs.has((0, import_node_path.resolve)((0, import_node_path.dirname)(file)))) {
        appHeld.set(file, id);
      }
    }
    for (const credential of found) {
      if (isLiveAuthFile(credential.sourcePath)) appHeld.set((0, import_node_path.resolve)(credential.sourcePath), workbuddyAccountId(credential));
    }
    for (const [file, id] of sealedFileIds) {
      if (isLiveAuthFile(file)) appHeld.set(file, id);
    }
    const unknownLiveFiles = /* @__PURE__ */ new Set();
    for (const file of this.unknownLiveFiles) {
      if (unreadableFiles.has(file) || !readableDirs.has((0, import_node_path.resolve)((0, import_node_path.dirname)(file)))) unknownLiveFiles.add(file);
    }
    for (const file of sealedFiles) {
      if (isLiveAuthFile(file) && !sealedFileIds.has(file)) unknownLiveFiles.add(file);
    }
    for (const file of unreadableFiles) {
      if (isLiveAuthFile(file)) unknownLiveFiles.add(file);
    }
    const unknownLiveSignIn = unknownLiveFiles.size > 0 || unavailableDirs.size > 0;
    const refreshBlockedIds = /* @__PURE__ */ new Set();
    for (const [file, id] of appHeld) {
      if (sealedFiles.has(file) || unreadableFiles.has(file) || unavailableDirs.has((0, import_node_path.resolve)((0, import_node_path.dirname)(file)))) {
        refreshBlockedIds.add(id);
      }
    }
    for (const account of this.accounts) {
      if (sealedFiles.has((0, import_node_path.resolve)(account.credential.sourcePath)) || unreadableFiles.has((0, import_node_path.resolve)(account.credential.sourcePath)) || unavailableDirs.has(this.homeOf(account.credential))) {
        refreshBlockedIds.add(account.id);
      }
    }
    const archived = await this.archivedCredentials(readableDirs);
    if (signal.aborted || rosterRevision !== this.rosterRevision) return this.accounts;
    for (const credential of archived) {
      const id = workbuddyAccountId(credential);
      if (tornDown.has(id)) continue;
      const entry = tombstoneOf(latest, credential, id);
      if (entry !== void 0 && tombstoneBlocks(entry, credential)) continue;
      if (!this.isOwnSignInPath(credential.sourcePath) && (sealedLiveIds.has(id) || sealedDirs.has(this.homeOf(credential)))) continue;
      if (found.some((entry2) => workbuddyAccountId(entry2) === id && entry2.accessToken === credential.accessToken)) continue;
      found.push(credential);
    }
    for (const credential of found) {
      const home = this.homeOf(credential);
      if (sealedDirs.has(home) || unavailableDirs.has(home)) {
        refreshBlockedIds.add(workbuddyAccountId(credential));
      }
    }
    const folded = foldSessionCopies(found, ownSignInDir(this.dataPath?.() ?? ""));
    found.length = 0;
    found.push(...folded);
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
          // A hold outlives `clear()`, which is how a source switch keeps a
          // cooling account cooling. The rebuilt row has to carry the hold's
          // deadline too, or it becomes eligible while `activeHold` still
          // reports it held.
          cooldownUntilMs: Math.max(0, this.heldIds.get(id)?.until ?? 0),
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
      this.logger?.info?.(`${import_log.LOG_PREFIX}: ${(0, import_log.accountLogTag)(account.label)} has a sign-in the upstream did not refuse; releasing the hold`);
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
    this.appHeldFiles = appHeld;
    this.unknownLiveSignIn = unknownLiveSignIn;
    this.unknownLiveFiles = unknownLiveFiles;
    this.refreshBlockedIds = refreshBlockedIds;
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
    if (!sameDirs(this.scanDirsFor(this.authDirs), dirs) || rosterRevision !== this.rosterRevision) return this.accounts;
    const tombstoneFile = this.deletedSignInsFile();
    const commit = () => {
      this.accounts = ordered;
      this.signInTokens = signInTokens;
      this.lastScanAtMs = Date.now();
    };
    if (tombstoneFile === void 0) {
      commit();
      return this.accounts;
    }
    let committed = false;
    try {
      await (0, import_file_lock.withFileLock)(`${tombstoneFile}.lock`, async () => {
        const finalTombstones = await this.loadDeletedSignIns(signal);
        if (signal.aborted || !sameDirs(this.scanDirsFor(this.authDirs), dirs) || rosterRevision !== this.rosterRevision) return;
        if (finalTombstones === void 0) {
          return;
        }
        if (await signInFileStamp(tombstoneFile) !== this.deletedSignInsStamp) return;
        for (let index = ordered.length - 1; index >= 0; index -= 1) {
          const account = ordered[index];
          const entry = tombstoneOf(finalTombstones, account.credential, account.id);
          if (entry !== void 0 && tombstoneBlocks(entry, account.credential)) {
            ordered.splice(index, 1);
            this.forgetAccount(account.id);
          }
        }
        commit();
        committed = true;
      });
    } catch (error) {
      if (!signal.aborted) {
        this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not lock the deleted sign-ins for the final roster check: ${String(error)}`);
      }
    }
    if (!committed && !signal.aborted) this.lastScanAtMs = Date.now();
    return this.accounts;
  }
  /** All accounts, cooldown state included. */
  list(region) {
    const kept = this.accounts.filter((account) => !this.storedIdMatches(this.removedIds, account));
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
    if (this.storedIdMatches(this.removedIds, account)) return "removed";
    if (this.storedIdMatches(this.disabledIds, account)) return "switched off";
    if (this.reserveHolds(account)) return "under its credit reserve";
    if (credentialUnusable(account.credential, now)) return "sign-in expired";
    if (region !== void 0 && (0, import_upstream.regionOf)(account.credential.domain) !== region) return "other region";
    if ((this.serverCooldowns.get(account.id) ?? 0) > now) return "server";
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
  async acquire(modelId, region, conversationKey, excludeIds) {
    const signal = this.scanAbort.signal;
    const eligibleNow = () => {
      const list = this.available(Date.now(), modelId, region);
      return excludeIds === void 0 ? list : list.filter((item) => !excludeIds.has(item.id));
    };
    if (this.accounts.length === 0) await this.scan();
    if (signal.aborted) return void 0;
    let pool = eligibleNow();
    if (pool.length === 0) {
      await this.scan();
      if (signal.aborted) return void 0;
      pool = eligibleNow();
    }
    if (pool.length === 0) return void 0;
    const preferredId = this.preferredIdFor(region);
    const remaining = new Set(pool.map((account) => account.id));
    while (remaining.size > 0) {
      const account = pool.find((item) => item.id === preferredId) ?? this.pick(pool, conversationKey, region);
      if (account === void 0) return void 0;
      remaining.delete(account.id);
      await this.ensureFresh(account);
      if (signal.aborted) return void 0;
      const eligible = eligibleNow();
      if (eligible.includes(account)) {
        this.servedOrder.set(account.id, ++this.servedCount);
        return account;
      }
      pool = eligible.filter((item) => remaining.has(item.id));
    }
    return void 0;
  }
  pick(pool, conversationKey, region) {
    if (this.distribution === "expiry") return this.pickByExpiry(pool);
    if (this.distribution === "sticky" && conversationKey !== void 0) {
      const bound = this.sticky.get(conversationKey);
      const kept = bound === void 0 ? void 0 : pool.find((account3) => account3.id === bound);
      if (kept !== void 0) {
        this.sticky.delete(conversationKey);
        this.sticky.set(conversationKey, kept.id);
        return kept;
      }
      const account2 = this.successor(pool, this.lastServedFor(region));
      if (account2 === void 0) return void 0;
      this.sticky.delete(conversationKey);
      this.sticky.set(conversationKey, account2.id);
      this.setLastServed(region, account2.id);
      while (this.sticky.size > 200) {
        const oldest = this.sticky.keys().next().value;
        if (oldest === void 0) break;
        this.sticky.delete(oldest);
      }
      return account2;
    }
    const account = this.distribution === "round-robin" ? this.successor(pool, this.lastServedFor(region)) : pool[0];
    if (account !== void 0 && this.distribution === "round-robin") this.setLastServed(region, account.id);
    return account;
  }
  /**
   * The first account after `previous` in roster order that is still in `pool`.
   *
   * `previous` can be missing from `pool` because this request already skipped
   * it: a sign-in whose refresh failed is excluded from the retry. Walking the
   * full roster keeps the rotation moving past it; looking only inside `pool`
   * would restart at its head and retry the same account every turn while the
   * accounts behind the skipped one never served.
   */
  successor(pool, previous) {
    if (pool.length === 0) return void 0;
    const start = previous === void 0 ? -1 : this.accounts.findIndex((account) => account.id === previous);
    if (start === -1) return pool[0];
    const present = new Set(pool.map((account) => account.id));
    for (let step = 1; step <= this.accounts.length; step += 1) {
      const candidate = this.accounts[(start + step) % this.accounts.length];
      if (candidate !== void 0 && present.has(candidate.id)) return candidate;
    }
    return pool[0];
  }
  /** The last account served through one region; absent regions share one. */
  lastServedFor(region) {
    return this.lastServed.get(region ?? "");
  }
  setLastServed(region, accountId) {
    this.lastServed.set(region ?? "", accountId);
  }
  pickByExpiry(pool) {
    return pickSoonestExpiry(pool, this.creditExpiries, Date.now());
  }
  /**
   * Next account the panel may name as "next up". Does not move the rotation.
   *
   * Sticky has no single next account - it is per conversation - so it names
   * nothing rather than pointing at a guess. The composer readout uses
   * `readoutPreview`, which can name the account that served last instead.
   */
  preview(eligible, region) {
    if (eligible.length === 0) return void 0;
    if (this.distribution === "expiry") return this.pickByExpiry(eligible);
    if (this.distribution === "priority") return eligible[0];
    if (this.distribution === "round-robin") return this.successor(eligible, this.lastServedFor(region));
    return void 0;
  }
  /**
   * The account the composer readout names. Does not move the rotation.
   *
   * Round-robin names the account the next request takes. Sticky names the one
   * that served most recently, because the current conversation is most likely
   * on it; before the first turn the rotation stands in.
   */
  readoutPreview(eligible, region) {
    if (eligible.length === 0) return void 0;
    if (this.distribution !== "sticky") return this.preview(eligible, region);
    let latest;
    let latestAt = -1;
    for (const account of eligible) {
      const servedAt = this.servedOrder.get(account.id) ?? -1;
      if (servedAt > latestAt) {
        latest = account;
        latestAt = servedAt;
      }
    }
    return latest ?? this.successor(eligible, this.lastServedFor(region));
  }
  /** Prefer one billing account per gateway; undefined restores automatic use. */
  prefer(accountId, region) {
    if (accountId === void 0) this.preferredIds.delete(region);
    else this.preferredIds.set(region, accountId);
  }
  /**
   * The stored preference for one region, translated from an older key.
   *
   * A preference saved before an identity change names a row that no rescan
   * produces any more. Leaving it untranslated meant the panel kept a selection
   * that could never be handed out, so automatic distribution silently served
   * another account while the panel named the old one.
   */
  preferredIdFor(region) {
    const stored = this.preferredIds.get(region);
    if (stored === void 0) return void 0;
    if (this.accounts.some((account) => account.id === stored)) return stored;
    const claimants = this.accounts.filter((item) => (region === void 0 || (0, import_upstream.regionOf)(item.credential.domain) === region) && previousAccountIds(item.credential).includes(stored));
    return claimants.length === 1 && claimants[0] !== void 0 ? claimants[0].id : stored;
  }
  /**
   * The current id a stored preference resolves to.
   *
   * The panel and the composer show this rather than the raw settings value:
   * after an upgrade that value can still be a 1.2.3 key, and showing it made
   * the row read as "unavailable" while `acquire` had already translated it and
   * served another account.
   */
  resolvedPreferredId(region) {
    return this.preferredIdFor(region);
  }
  /**
   * Refresh one account after a session-dead upstream answer, ignoring the
   * stored expiry: a revocation does not rewrite it. False when the access
   * token is unchanged, so the caller stops retrying the same dead token.
   */
  async refreshAccount(accountId) {
    return await this.refreshAccountOutcome(accountId) === "refreshed";
  }
  /**
   * The same refresh, keeping a refusal apart from a failure.
   *
   * The caller needs the difference: only the upstream turning the sign-in down
   * justifies a six-hour hold, while a timeout or an unreachable host says
   * nothing about the token and must leave the account in rotation.
   */
  async refreshAccountOutcome(accountId) {
    return await this.refreshForRetry(accountId);
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
    return outcome === "failed" ? "failed" : "refused";
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
   * Whether a refresh's rotated token still belongs to a sign-in on disk.
   *
   * The pool running the refresh need not be the one that deleted the sign-in,
   * so its roster cannot answer this. The file can: it holds the token the
   * refresh started from, the one it just minted, or something else (a re-login,
   * or nothing after the delete). Only the first two are still this pool's to
   * archive; anything else belongs to a session the user replaced or removed.
   */
  async refreshedSignInIsOnDisk(previous, refreshed) {
    const read = await readCredential(refreshed.sourcePath);
    if (read.kind !== "credential") return false;
    return read.credential.accessToken === previous.accessToken || read.credential.accessToken === refreshed.accessToken || read.credential.refreshToken !== "" && read.credential.refreshToken === refreshed.refreshToken;
  }
  /**
   * Archive a rotated token only while its sign-in is still on disk.
   *
   * Checked under the tombstone lock so a delete cannot commit between the
   * check and the archive write: before the lock, its record blocks the write;
   * after it, the re-login has already replaced the file the check sees.
   * Answers whether the rotated token still belongs to a live sign-in; false
   * means the caller must not keep serving it.
   */
  async archiveRefreshedCredential(previous, refreshed) {
    let kept = false;
    const archive = async () => {
      if (await this.refreshedSignInIsOnDisk(previous, refreshed)) {
        await this.archiveCredentials([refreshed]);
        kept = true;
      }
    };
    const file = this.deletedSignInsFile();
    if (file === void 0) {
      await archive();
      return kept;
    }
    try {
      await (0, import_file_lock.withFileLock)(`${file}.lock`, archive);
    } catch (error) {
      this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not lock the deleted sign-ins to archive a renewed token: ${String(error)}`);
      return false;
    }
    return kept;
  }
  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   *
   * Reports what it did, so a caller walking the pool for keep-alive can tell a
   * pass that refreshed something from one that had nothing to do. An in-flight
   * refresh another call started is awaited and its result is shared: this call
   * spent no upstream call of its own, but the account's outcome is the same.
   */
  async ensureFresh(account, forced = false) {
    if (this.client === void 0) return "fresh";
    if (this.refreshBlockedIds.has(account.id)) return "fresh";
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
          this.logger?.warn(`${import_log.LOG_PREFIX}: ${(0, import_log.accountLogTag)(account.label)} token expired with no refresh token; sign in again`);
        }
        return "noToken";
      }
      try {
        const outcome = await this.client.refreshToken(credential);
        if (account.credential !== credential || !this.accounts.includes(account)) return "failed";
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
        let written;
        try {
          written = await this.renewOwnSignIn(credential, account.credential);
        } catch (error) {
          this.logger?.warn?.(`${import_log.LOG_PREFIX}: could not persist the renewed token for ${(0, import_log.accountLogTag)(account.label)}`, error);
          if (!await this.archiveRefreshedCredential(credential, account.credential)) {
            account.credential = credential;
            this.forgetAccount(account.id);
          }
          throw error;
        }
        if (!written) {
          account.credential = credential;
          await this.scan();
          return "fresh";
        }
        if (!await this.archiveRefreshedCredential(credential, account.credential)) {
          account.credential = credential;
          this.forgetAccount(account.id);
          return "failed";
        }
        this.noRefreshWarned.delete(account.id);
        const sessionHold = this.heldIds.get(account.id);
        if (sessionHold !== void 0 && sessionHold.reason === "session") {
          this.heldIds.delete(account.id);
          if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= sessionHold.until) account.cooldownUntilMs = 0;
          this.logger?.info?.(`${import_log.LOG_PREFIX}: ${(0, import_log.accountLogTag)(account.label)} refreshed again; releasing the refused sign-in hold`);
        }
        this.logger?.info?.(`${import_log.LOG_PREFIX}: refreshed token for ${(0, import_log.accountLogTag)(account.label)}`);
        return "refreshed";
      } catch (error) {
        if (credential.expiresAtMs > Date.now() + 3e4) {
          this.logger?.warn?.(`${import_log.LOG_PREFIX}: token refresh failed but token still valid for ${(0, import_log.accountLogTag)(account.label)}`, error);
        } else {
          this.logger?.error?.(`${import_log.LOG_PREFIX}: token refresh failed and token expired for ${(0, import_log.accountLogTag)(account.label)}`, error);
        }
        const kind = (0, import_upstream.upstreamErrorKind)(error);
        return kind === "session_dead" ? "refused" : "failed";
      }
    })();
    this.refreshInflight.set(account.id, run);
    try {
      return await run;
    } finally {
      if (this.refreshInflight.get(account.id) === run) this.refreshInflight.delete(account.id);
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
  penalize(accountId, resetAtMs, modelId, hold = false, failure = "limit") {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return;
    const countsAsLimit = hold === false && failure === "limit";
    if (countsAsLimit) account.rateLimitHits += 1;
    const now = Date.now();
    const stated = resetAtMs !== void 0 && resetAtMs > now;
    if (countsAsLimit && !stated) {
      const sinceLast = now - (account.rateLimitStreakAtMs ?? 0);
      account.rateLimitStreak = sinceLast > RATE_LIMIT_STREAK_WINDOW_MS ? 1 : (account.rateLimitStreak ?? 0) + 1;
      account.rateLimitStreakAtMs = now;
    }
    const holdReason = hold === false ? void 0 : hold;
    const cap = holdReason !== void 0 ? POOL_HOLD_MS : PENALIZE_CAP_MS;
    const streak = Math.min(Math.max((account.rateLimitStreak ?? 1) - 1, 0), RATE_LIMIT_STREAK_STEPS);
    const backoff = countsAsLimit ? Math.min(this.cooldownMs * 2 ** streak, Math.max(this.cooldownMs, RATE_LIMIT_STREAK_CAP)) : this.cooldownMs;
    const until = stated ? Math.min(resetAtMs, now + cap) : holdReason !== void 0 ? now + cap : now + backoff;
    if (modelId !== void 0 && modelId !== "") {
      pruneModelCooldowns(account, now);
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
      this.logger?.warn(
        `${import_log.LOG_PREFIX}: ${(0, import_log.accountLogTag)(account.label)} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`
      );
      return;
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
    if (failure === "server" && hold === false) this.serverCooldowns.set(account.id, until);
    else this.serverCooldowns.delete(account.id);
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
      holdReason !== void 0 ? `${import_log.LOG_PREFIX}: account ${(0, import_log.accountLogTag)(account.label)} held (${holdReason}); held until ${new Date(until).toISOString()}` : `${import_log.LOG_PREFIX}: account ${(0, import_log.accountLogTag)(account.label)} rate-limited; cooling until ${new Date(until).toISOString()}`
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
    this.serverCooldowns.clear();
  }
  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status() {
    const now = Date.now();
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
      lastScanAtMs: this.lastScanAtMs,
      scanning: this.scanInflight !== void 0
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POOL_HOLD_MS,
  WorkBuddyAccountPool,
  candidateAuthDirs,
  legacyWorkBuddyAccountId,
  ownSignInDir,
  parseWorkBuddyAuth,
  renewOwnSignInFile,
  workbuddyAccountId,
  writeOwnSignIn
});
