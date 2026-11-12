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
var file_lock_exports = {};
__export(file_lock_exports, {
  FileLockReleaseError: () => FileLockReleaseError,
  replaceFile: () => replaceFile,
  withFileLock: () => withFileLock
});
module.exports = __toCommonJS(file_lock_exports);
var import_node_crypto = require("node:crypto");
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_trusted_process = require("./trusted-process");
const FILE_LOCK_WAIT_MS = 5e3;
const UNOWNED_FILE_LOCK_STALE_MS = 6e4;
const RETRY_MS = 25;
const PROCESS_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1e3);
const PROCESS_START_TOLERANCE_MS = 2e3;
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];
class FileLockReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileLockReleaseError";
  }
}
const ABANDONED_RECLAIMS = /* @__PURE__ */ new Map();
const ABANDONED_LOCKS = /* @__PURE__ */ new Map();
function abandonedMarker(file, token) {
  return `${file}.abandoned.${token}`;
}
async function markAbandoned(file, token) {
  ABANDONED_LOCKS.set((0, import_node_path.resolve)(file), token);
  try {
    await (0, import_promises.writeFile)(abandonedMarker(file, token), JSON.stringify({
      token,
      createdAtMs: Date.now()
    }), { flag: "wx", mode: 384 });
  } catch {
  }
}
async function hasAbandonedMarker(file, token) {
  try {
    await (0, import_promises.stat)(abandonedMarker(file, token));
    return true;
  } catch {
    return false;
  }
}
async function cleanupAbandonedMarkers(file) {
  const directory = (0, import_node_path.dirname)(file);
  const prefix = `${(0, import_node_path.basename)(file)}.abandoned.`;
  let names;
  try {
    names = await (0, import_promises.readdir)(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    await (0, import_promises.unlink)((0, import_node_path.join)(directory, name)).catch(() => {
    });
  }
  ABANDONED_LOCKS.delete((0, import_node_path.resolve)(file));
}
async function replaceFile(temporary, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await (0, import_promises.rename)(temporary, file);
      return;
    } catch (error) {
      const code = error.code;
      if (process.platform !== "win32" || code !== "EPERM" && code !== "EBUSY" || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve2) => setTimeout(resolve2, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return void 0;
  }
}
function processOutput(command, args, env, cwd, timeoutMs) {
  return new Promise((resolve2) => {
    (0, import_node_child_process.execFile)(command, [...args], { timeout: timeoutMs, maxBuffer: 1024, windowsHide: true, env, cwd }, (error, stdout) => {
      if (error !== null) resolve2(void 0);
      else resolve2(stdout.trim());
    });
  });
}
async function processStartedAt(pid, timeoutMs = 2e3) {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  if (process.platform === "win32") {
    const systemRoot = (0, import_trusted_process.trustedSystemRootOf)(process.env);
    const powershell = (0, import_trusted_process.trustedWindowsPowerShell)(process.env);
    if (systemRoot === void 0 || powershell === void 0) return void 0;
    const output2 = await processOutput(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\Modules'); $d=(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime(); ([DateTimeOffset]$d).ToUnixTimeMilliseconds()`
    ], (0, import_trusted_process.trustedWindowsChildEnv)(process.env, { inheritTemp: true, includeSystemDrive: true }), (0, import_node_path.join)(systemRoot, "System32"), timeoutMs);
    const match = output2?.match(/\d{10,}/);
    return match === void 0 || match === null ? void 0 : Number(match[0]);
  }
  const ps = ["/usr/bin/ps", "/bin/ps"].find(import_node_fs.existsSync);
  if (ps === void 0) return void 0;
  const output = await processOutput(ps, ["-p", String(pid), "-o", "lstart="], {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    TZ: "UTC"
  }, "/", timeoutMs);
  const started = output === void 0 ? Number.NaN : Date.parse(`${output.trim()} UTC`);
  return Number.isFinite(started) ? started : void 0;
}
async function lockState(file, probeTimeoutMs = 2e3, probe = processStartedAt) {
  let text;
  try {
    text = await (0, import_promises.readFile)(file, "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return "current";
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
  }
  if (owner?.state === "abandoned") return "stale";
  if (typeof owner?.token === "string") {
    if (ABANDONED_LOCKS.get((0, import_node_path.resolve)(file)) === owner.token) return "stale";
    if (await hasAbandonedMarker(file, owner.token)) return "stale";
  }
  const fileAge = await (0, import_promises.stat)(file).then((entry) => Date.now() - entry.mtimeMs, () => 0);
  const ownerAlive = typeof owner?.pid === "number" ? processIsAlive(owner.pid) : void 0;
  if (ownerAlive === false) return "stale";
  if (ownerAlive === true && typeof owner?.pid === "number") {
    const recordedStart = typeof owner.processStartedAtMs === "number" ? owner.processStartedAtMs : typeof owner.createdAtMs === "number" ? owner.createdAtMs : void 0;
    if (recordedStart !== void 0 && Math.abs(fileAge) > PROCESS_START_TOLERANCE_MS) {
      const actualStart = await probe(owner.pid, probeTimeoutMs);
      if (actualStart !== void 0 && actualStart - recordedStart > PROCESS_START_TOLERANCE_MS) return "stale";
    }
    if (recordedStart === void 0) return fileAge > UNOWNED_FILE_LOCK_STALE_MS ? "stale" : "current";
    return "current";
  }
  return fileAge > UNOWNED_FILE_LOCK_STALE_MS ? "stale" : "current";
}
async function createOwnedFile(file) {
  const token = (0, import_node_crypto.randomUUID)();
  try {
    await (0, import_promises.writeFile)(file, JSON.stringify({
      pid: process.pid,
      token,
      createdAtMs: Date.now(),
      processStartedAtMs: PROCESS_STARTED_AT_MS
    }), { flag: "wx", mode: 384 });
    return token;
  } catch (error) {
    const code = error.code;
    if (code === "EEXIST") return void 0;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return void 0;
    throw error;
  }
}
async function releaseOwnedFile(file, token) {
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  while (true) {
    let owner;
    try {
      const parsed = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
      owner = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR") return "missing";
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await markAbandoned(file, token);
        return "failed";
      }
    }
    if (owner !== void 0) {
      if (owner.token !== token) return "replaced";
      try {
        await (0, import_promises.unlink)(file);
        return "released";
      } catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR") return "missing";
        try {
          await (0, import_promises.writeFile)(file, JSON.stringify({ ...owner, state: "abandoned" }), { mode: 384 });
        } catch {
        }
      }
    }
    if (Date.now() >= deadline) {
      await markAbandoned(file, token);
      return "failed";
    }
    await new Promise((resolve2) => setTimeout(resolve2, RETRY_MS));
  }
}
async function newestReclaimGeneration(lock) {
  const directory = (0, import_node_path.dirname)(lock);
  const base = (0, import_node_path.basename)(lock);
  const prefix = `${base}.reclaim.`;
  const names = await (0, import_promises.readdir)(directory);
  let generation = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    generation = Math.max(generation, Number(suffix));
  }
  return generation;
}
async function cleanupTerminalReclaims(lock) {
  const directory = (0, import_node_path.dirname)(lock);
  const prefix = `${(0, import_node_path.basename)(lock)}.reclaim.`;
  let names;
  try {
    names = await (0, import_promises.readdir)(directory);
  } catch {
    return true;
  }
  const claimNames = names.filter((name) => {
    if (!name.startsWith(prefix)) return false;
    return /^\d+$/.test(name.slice(prefix.length));
  });
  const claimNameSet = new Set(claimNames);
  let blocked = false;
  for (const claimName of claimNames) {
    const claim = (0, import_node_path.join)(directory, claimName);
    const sidecars = names.filter((name) => name.startsWith(`${claimName}.abandoned.`));
    const temporaryFiles = names.filter((name) => name.startsWith(`${claimName}.`) && name.endsWith(".tmp"));
    let owner;
    try {
      const parsed = JSON.parse(await (0, import_promises.readFile)(claim, "utf8"));
      owner = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
    }
    const terminalState = owner?.state === "complete" || owner?.state === "abandoned";
    const rememberedAbandonment = owner?.token !== void 0 && ABANDONED_RECLAIMS.get(claim) === owner.token;
    if (sidecars.length === 0 && !terminalState && !rememberedAbandonment) continue;
    let claimRemoved = false;
    try {
      await (0, import_promises.unlink)(claim);
      claimRemoved = true;
    } catch (error) {
      const code = error.code;
      claimRemoved = code === "ENOENT" || code === "ENOTDIR";
    }
    if (!claimRemoved) {
      blocked = true;
      continue;
    }
    for (const sidecar of sidecars) await (0, import_promises.unlink)((0, import_node_path.join)(directory, sidecar)).catch(() => {
    });
    for (const temporary of temporaryFiles) await (0, import_promises.unlink)((0, import_node_path.join)(directory, temporary)).catch(() => {
    });
    ABANDONED_RECLAIMS.delete(claim);
  }
  for (const name of names) {
    const marker = name.indexOf(prefix);
    const abandoned = name.indexOf(".abandoned.", marker + prefix.length);
    if (marker !== 0 || abandoned === -1) continue;
    if (claimNameSet.has(name.slice(0, abandoned))) continue;
    await (0, import_promises.unlink)((0, import_node_path.join)(directory, name)).catch(() => {
    });
  }
  return !blocked;
}
async function claimStaleReclaim(lock, probeTimeoutMs = 2e3, probe = processStartedAt) {
  const directory = (0, import_node_path.dirname)(lock);
  const base = (0, import_node_path.basename)(lock);
  const prefix = `${base}.reclaim.`;
  const names = await (0, import_promises.readdir)(directory);
  const generation = names.reduce((highest, name) => {
    if (!name.startsWith(prefix)) return highest;
    const suffix = name.slice(prefix.length);
    const match = suffix.match(/^(\d+)(?:\.abandoned\..+)?$/);
    return match === null ? highest : Math.max(highest, Number(match[1]));
  }, 0);
  const claims = names.filter((name) => {
    if (!name.startsWith(prefix)) return false;
    return /^\d+$/.test(name.slice(prefix.length));
  }).map((name) => (0, import_node_path.join)(directory, name));
  for (const claim of claims) {
    const claimName = (0, import_node_path.basename)(claim);
    if (names.some((name) => name.startsWith(`${claimName}.abandoned.`))) return void 0;
    let owner = {};
    try {
      const parsed = JSON.parse(await (0, import_promises.readFile)(claim, "utf8"));
      owner = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      if (error.code === "ENOENT") {
        ABANDONED_RECLAIMS.delete(claim);
        continue;
      }
    }
    if (owner.state === "complete" || owner.state === "abandoned") return void 0;
    if (owner.token !== void 0 && ABANDONED_RECLAIMS.get(claim) === owner.token) return void 0;
    if (await lockState(claim, probeTimeoutMs, probe) === "current") return void 0;
    try {
      await (0, import_promises.unlink)(claim);
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return void 0;
    }
    for (const name of names) {
      if (!name.startsWith(`${claimName}.`) || !name.endsWith(".tmp")) continue;
      await (0, import_promises.unlink)((0, import_node_path.join)(directory, name)).catch(() => {
      });
    }
    ABANDONED_RECLAIMS.delete(claim);
  }
  const file = `${lock}.reclaim.${String(generation + 1).padStart(12, "0")}`;
  const token = await createOwnedFile(file);
  return token === void 0 ? void 0 : { file, token, generation: generation + 1 };
}
async function completeReclaim(reclaim) {
  try {
    const owner = JSON.parse(await (0, import_promises.readFile)(reclaim.file, "utf8"));
    if (owner.token !== reclaim.token) return;
    const temporary = `${reclaim.file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
    try {
      await (0, import_promises.writeFile)(temporary, JSON.stringify({
        pid: process.pid,
        token: reclaim.token,
        createdAtMs: Date.now(),
        processStartedAtMs: PROCESS_STARTED_AT_MS,
        state: "complete"
      }), { mode: 384 });
      await replaceFile(temporary, reclaim.file);
    } catch (error) {
      await (0, import_promises.unlink)(temporary).catch(() => {
      });
      throw error;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function abandonReclaim(reclaim, cause) {
  let marked = false;
  try {
    await (0, import_promises.writeFile)(reclaim.file, JSON.stringify({
      pid: process.pid,
      token: reclaim.token,
      createdAtMs: Date.now(),
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      state: "abandoned"
    }), { mode: 384 });
    marked = true;
  } catch {
  }
  const released = await releaseOwnedFile(reclaim.file, reclaim.token);
  if (released === "released" || released === "missing") throw cause;
  if (!marked) {
    const marker = `${reclaim.file}.abandoned.${reclaim.token}`;
    try {
      await (0, import_promises.writeFile)(marker, JSON.stringify({
        token: reclaim.token,
        createdAtMs: Date.now(),
        processStartedAtMs: PROCESS_STARTED_AT_MS
      }), { flag: "wx", mode: 384 });
      marked = true;
    } catch (error) {
      if (error.code === "EEXIST") marked = true;
    }
  }
  if (marked) {
    ABANDONED_RECLAIMS.delete(reclaim.file);
    throw cause;
  }
  ABANDONED_RECLAIMS.set(reclaim.file, reclaim.token);
  throw new Error("could not complete or release the lock recovery claim", { cause });
}
async function withFileLock(lock, work) {
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(lock), { recursive: true, mode: 448 });
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  const probes = /* @__PURE__ */ new Map();
  const probe = (pid, timeoutMs) => {
    let pending = probes.get(pid);
    if (pending === void 0) {
      pending = processStartedAt(pid, timeoutMs);
      probes.set(pid, pending);
    }
    return pending;
  };
  let token;
  while (token === void 0) {
    token = await createOwnedFile(lock);
    if (token !== void 0) break;
    const remaining = Math.max(250, deadline - Date.now());
    const current = await lockState(lock, remaining, probe);
    if (current === "stale") {
      const cleaned = await cleanupTerminalReclaims(lock);
      const reclaim = cleaned ? await claimStaleReclaim(lock, Math.max(250, deadline - Date.now()), probe) : void 0;
      if (reclaim !== void 0) {
        try {
          if (await newestReclaimGeneration(lock) === reclaim.generation && await lockState(lock, Math.max(250, deadline - Date.now()), probe) === "stale" && await newestReclaimGeneration(lock) === reclaim.generation) {
            await (0, import_promises.unlink)(lock).catch(() => {
            });
          }
        } finally {
          try {
            await completeReclaim(reclaim);
          } catch (error) {
            await abandonReclaim(reclaim, error);
          }
        }
      }
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for the credential document lock");
    await new Promise((resolve2) => setTimeout(resolve2, RETRY_MS));
  }
  await cleanupAbandonedMarkers(lock);
  await cleanupTerminalReclaims(lock);
  try {
    await work();
  } catch (error) {
    const released2 = await releaseOwnedFile(lock, token);
    if (released2 !== "released" && released2 !== "missing") {
      const wrapped = new Error("work failed and the credential document lock was not released", { cause: error });
      const code = error.code;
      if (code !== void 0) wrapped.code = code;
      throw wrapped;
    }
    throw error;
  }
  const released = await releaseOwnedFile(lock, token);
  if (released !== "released" && released !== "missing") {
    throw new FileLockReleaseError("work completed but the credential document lock was not released");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FileLockReleaseError,
  replaceFile,
  withFileLock
});
