"use strict";

/**
 * pi-desktop-wtq-pool - PI-Desktop plugin entry.
 *
 * PI-Desktop port of `dsh-workbuddy-xdpool` (MIT). Same behaviour as the
 * original, rewritten against the PI-Desktop plugin host:
 *
 *   1. discover EVERY WorkBuddy desktop sign-in on this machine (read-only),
 *   2. serve each gateway (domestic / international) from its own loopback
 *      OpenAI-compatible endpoint,
 *   3. publish those endpoints as two providers in this plugin's own manifest
 *      (`contributes.providers`) - the only provider channel the host exposes,
 *   4. rotate to the next account whenever the upstream answers 429.
 *
 * The host spawns plugins in a Node utility process with a stripped
 * environment, so every path is rebuilt from the home directory rather than
 * from %LOCALAPPDATA%/APPDATA% (see lib/accounts.js).
 *
 * Upstream traffic uses the platform `fetch` in that process rather than the
 * host's `net.fetch` bridge: the bridge buffers a response into text, and the
 * provider contract needs the upstream SSE body relayed as it arrives. Nothing
 * leaves this machine except to WorkBuddy's own endpoints.
 */

const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { AsyncLocalStorage } = require("node:async_hooks");

const { WorkBuddyAccountPool, candidateAuthDirs, ownSignInDir, writeOwnSignIn } = require("./lib/accounts");
const { atRestKeyFailure } = require("./lib/at-rest");
const {
  WorkBuddyCatalog,
  applyOverride,
  catalogFromUpstream,
  hasOverride,
} = require("./lib/catalog");
const { createWorkBuddyShim } = require("./lib/shim");
const {
  CHECKIN_POLL_MS,
  checkinSlotId,
  dueCheckinSlot,
  normaliseCheckinHours,
  zonedDay,
  zonedDayHour,
} = require("./lib/checkin-time");
const { WorkBuddyUpstreamClient, regionOf, isBuddyThresholdIncomplete } = require("./lib/upstream");
const { promoStatusFor } = require("./lib/promo");
const { discoverTraeCredentials, traeRegionOfCredential, traeStorageCandidates, traeWindowsAppNames, resetTraeCredentialCache } = require("./lib/trae-discovery");
const { createTraeGateway } = require("./lib/trae-gateway");
const { resolveTraeIdentity, pickTraeStorageIdentity, TRAE_STORAGE_MISSING_PREFIX } = require("./lib/trae-identity");
const { TraeSoloUpstreamClient, TRAE_CHECKIN_DEVICE_CLAIMED, traeVariantFor } = require("./lib/trae-upstream");
const { discoverQoderCredentials, resetQoderCredentialCache } = require("./lib/qoder-credentials");
const { createQoderGateway } = require("./lib/qoder-gateway");
const { QoderUpstreamClient, qoderClaimableCampaignIdOf, qoderCheckinStateFrom, qoderNormalizeClaimResult, qoderRewardExpiryMs, qoderRewardValidityDaysOf } = require("./lib/qoder-client");
const { safeMessage } = require("./lib/loopback");
const { startDeviceLogin, pollDeviceLogin } = require("./lib/login");
const { createSourcePool } = require("./lib/source-pool");

/** The ids this plugin used before it was renamed, newest first; only the migration reads them. */
const PREVIOUS_PLUGIN_IDS = ["io.github.chengzhi-c.pi-desktop-xdpool", "local.pi-desktop-xdpool", "local.pi-desktop-workbuddy", "local.pi-workbuddy-xdpool"];
/** The one background service the manifest declares. */
const SERVICE_ID = "provider-host";

/** The two gateways, matching the provider ids written into the manifest. */
const REGIONS = ["cn", "global"];
const PROVIDER_ID_BY_REGION = { cn: "xdpool-cn", global: "xdpool-global" };
const PROVIDER_NAME_BY_REGION = {
  cn: "WTQ Pool (CN)",
  global: "WTQ Pool (Global)",
};
/** The settings key each source's switch is stored under. */
const SOURCE_SETTING_KEYS = {
  workbuddy: "sourceWorkbuddy",
  trae: "sourceTrae",
  qoder: "sourceQoder",
};
/**
 * The settings key behind one source name, or undefined for anything else.
 *
 * The own-property test is load-bearing: a bare `SOURCE_SETTING_KEYS[source]`
 * answers for `toString`, `constructor` and `__proto__` from the prototype, so a
 * crafted `source` would save under a junk key instead of being refused.
 */
function sourceSettingKey(source) {
  return typeof source === "string" && Object.hasOwn(SOURCE_SETTING_KEYS, source)
    ? SOURCE_SETTING_KEYS[source]
    : undefined;
}
/** Whether one source is switched on in settings. Unknown sources stay off, so a typo can never enable a gateway. */
function sourceEnabled(source) {
  const key = sourceSettingKey(source);
  return key !== undefined && settings.enabled !== false && settings[key] !== false;
}
/**
 * Regions switched off on their own, as `source:region` keys.
 *
 * The source switch covers a whole vendor; this covers one edition of it, so a
 * region whose sign-in is expired or unwanted can be parked without silencing
 * the other one. A parked region gets no gateway, no scan and no provider row.
 */
function disabledRegionKeys() {
  const value = settings.disabledRegions;
  return Array.isArray(value) ? value.filter((key) => typeof key === "string" && key !== "") : [];
}

/** Whether one source region may run: its source is on and the region is not parked. */
function regionEnabled(source, region) {
  return sourceEnabled(source) && !disabledRegionKeys().includes(sourceRegionKey(source, region));
}

/** Regions whose source is switched on and which are not parked. */
function activeRegions() {
  return REGIONS.filter((region) => regionEnabled("workbuddy", region));
}
/**
 * Preferred loopback port, one per gateway.
 *
 * The host reads a provider's base URL from the manifest BEFORE the plugin
 * process starts, so the published row is only correct if the endpoint comes
 * back on the same port every run - an ephemeral port would leave the row
 * pointing at nothing. They sit outside the range the single-account connector
 * uses (41811/41812, 41821/41822) so both plugins can be installed at once.
 *
 * These are the *preferred* ports and the only ones ever published: a run that
 * cannot reclaim its port still declares it, because the manifest has to
 * describe the address the NEXT run will bind.
 */
const REGION_PORTS = { cn: 41831, global: 41841 };

/**
 * Trae's gateways, kept beside the WorkBuddy pair rather than inside it.
 *
 * Trae's regions are `cn` / `ai` - a different pair from WorkBuddy's
 * `cn` / `global` - and its credentials never enter the WorkBuddy account
 * pool, so they get their own map, ports and provider ids. The two existing
 * WorkBuddy rows above are untouched: nothing migrates and nothing is renamed.
 */
const TRAE_REGIONS = ["cn", "ai"];
const TRAE_PROVIDER_ID_BY_REGION = { cn: "xdpool-trae-cn", ai: "xdpool-trae-ai" };
const TRAE_PROVIDER_NAME_BY_REGION = {
  cn: "WTQ Pool Trae (CN)",
  ai: "WTQ Pool Trae (Global)",
};
/** Fixed ports, clear of 41811/41812, 41821/41822 and the WorkBuddy pair. */
const TRAE_PORTS = { cn: 41851, ai: 41861 };
const traeGateways = new Map();
/** Regions whose source is switched on and which are not parked. */
function activeTraeRegions() {
  return TRAE_REGIONS.filter((region) => regionEnabled("trae", region));
}
/**
 * Qoder's gateways, kept beside the WorkBuddy pair rather than inside it.
 *
 * Qoder's regions are `cn` / `global` - the same pair as WorkBuddy's - but
 * its credentials never enter the WorkBuddy account pool, so they get their
 * own map, ports and provider ids all the same. Nothing above is touched.
 */
const QODER_REGIONS = ["cn", "global"];
const QODER_PROVIDER_ID_BY_REGION = { cn: "xdpool-qoder-cn", global: "xdpool-qoder-global" };
const QODER_PROVIDER_NAME_BY_REGION = {
  cn: "WTQ Pool Qoder (CN)",
  global: "WTQ Pool Qoder (Global)",
};
/** Fixed ports, clear of 41811/41812, 41821/41822 and the two pairs above. */
const QODER_PORTS = { cn: 41871, global: 41881 };
/** region -> { region, gateway, baseUrl, portFallback, lastError }. */
const qoderGateways = new Map();
/** Regions whose source is switched on and which are not parked. */
function activeQoderRegions() {
  return QODER_REGIONS.filter((region) => regionEnabled("qoder", region));
}

/**
 * How hard one run tries to reclaim its preferred port.
 *
 * A busy preferred port is almost always the previous instance still exiting,
 * which is a wait of milliseconds rather than a permanent condition. Giving up
 * instantly made a run fall back to a spare port and publish it, which
 * stranded the host on an address nothing listens on.
 */
const PORT_RESERVE_ATTEMPTS = 6;
const PORT_RESERVE_INTERVAL_MS = 250;

/** Levels the host's thinking picker accepts, in the order it shows them. */
const HOST_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Bounds the host's manifest validator enforces. */
const MAX_MODELS = 64;
/** Ids one gateway's stored selection may name, well past the published cap. */
const MAX_STORED_MODEL_IDS = 512;
const MAX_TOKEN_BUDGET = 0xffffffff;
/** Longest model id the declaration can publish; anything past it is unroutable. */
const MAX_MODEL_ID_LENGTH = 256;
/**
 * Highest credit floor the panel may store: the reserve is compared against a
 * real balance, so a floor past any balance parks the account for good.
 */
const MAX_CREDIT_RESERVE = 1e9;
const CONSERVATIVE_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32000;
const CATALOG_TTL_MS = 30 * 60 * 1000;
/**
 * How long a failed roster read waits before the next attempt.
 *
 * A failed read must not be stamped as freshly read: that parks the static
 * fallback - and with it the wrong model list, for the gateways and for the
 * host's picker - for the whole TTL after one slow start.
 */
const CATALOG_RETRY_MS = 15 * 1000;
/** How many times a roster that could not be read is asked for again. */
const MODEL_RETRY_ATTEMPTS = 4;
/** Used until a shim binds: the host rejects a provider with no base URL. */
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1/v1";

/**
 * How long one account's billing answers (credits, check-in) are reused.
 *
 * The panel renders from these cached answers and they refresh behind the first
 * paint, so opening it never waits on a billing call per account.
 */
const PROBE_TTL_MS = 60000;
/** How often the desktop sign-ins are re-read while the service runs. */
const ACCOUNT_WATCH_MS = 60000;
/**
 * Bound on one model-catalog request, so a stalled host cannot stall a load.
 *
 * Ten seconds is well past a healthy roster read, and it also has to fit the
 * budget the host gives `onLoad`: the two regions are read at once, so this
 * timeout is the ceiling on init rather than twice it.
 */
const MODELS_TIMEOUT_MS = 10000;
/**
 * The share of `onLoad`'s and the service's own budgets a roster read may take.
 *
 * The host waits 15 s for `onLoad` and 5 s for the service to start, and both
 * run before the panel can be opened. A read that outruns its share is left to
 * finish behind the answer: the declaration still publishes from what it has,
 * and the refresh that follows `service.start` fills the roster in.
 */
const LOAD_ROSTER_BUDGET_MS = 6000;
const SERVICE_ROSTER_BUDGET_MS = 3000;
/**
 * The share of the same two budgets the steps in front of the roster read may
 * take: the gateway reconcilers, the account scan, and the runtime starts.
 *
 * Those steps are disk and port work that can stall on a pathological machine,
 * and without a bound of their own they could spend the whole hook before the
 * roster read even starts. A step that outruns the budget keeps running behind
 * the answer; the refresh after `service.start` reconciles whatever it missed
 * and republishes the declaration.
 */
const LOAD_BOOTSTRAP_BUDGET_MS = 5000;
const SERVICE_BOOTSTRAP_BUDGET_MS = 1500;
/**
 * One whole refresh pass.
 *
 * The host allows a panel call 30 s. Every stage inside a pass is sized against
 * this one deadline, and the port reservations in front of it are capped by
 * their own attempt count - a few seconds at worst when another process holds
 * the preferred ports - which is what keeps the sum inside the host's budget.
 */
const REFRESH_PASS_BUDGET_MS = 18000;
/**
 * How long a started panel login stays pollable.
 *
 * The browser half is the user's to finish, so it is measured in minutes
 * rather than the seconds a network call gets. Past it the state is dropped and
 * the panel asks the user to start again: the upstream keeps answering
 * `login ing...` for a state that will never complete, so a poll with no
 * deadline would look alive forever.
 */
const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
/**
 * One account-directory walk, on its own clock.
 *
 * A walk reads every `.info` in every auth directory and, on a cold key, asks
 * the OS for the at-rest key, which is the slow part. The host allows a panel
 * call 30 s and the pass that follows has 18 s of its own, so this is sized to
 * leave the walk the larger share and let the pass take what is left.
 */
const POOL_SCAN_BUDGET_MS = 8000;

let settings = {};
/**
 * Bumped by every local mutation of `settings`.
 *
 * A refresh pass reads the document from the host and then awaits for seconds;
 * a save landing in that window is newer than the document the read returns.
 * Comparing this counter across the read is what stops the pass from reverting
 * a switch the user just flipped.
 */
let settingsRevision = 0;
let dataPath = "";
/** The package root, so the declaration can rewrite this plugin's manifest. */
let packageRoot = "";
/** One runtime per gateway: its shim and catalog. */
const runtimes = new Map();
/** Runtime binds in flight, by region, so two callers share one bind. */
const runtimeStarts = new Map();
/**
 * Gateway closes `reconcileRuntimes` started but could not wait for.
 *
 * That function runs synchronously inside settings application, yet a source
 * toggled off and straight back on starts a new gateway while the old one's
 * close is still releasing the port. `startRuntimes` drains this list first, so
 * the new bind lands on a port the old shim has actually let go of instead of
 * falling back to a temporary one nothing was told about.
 */
const pendingRuntimeStops = [];
/**
 * Why one gateway's last start attempt failed, by region.
 *
 * A gateway that could not bind has no runtime at all, which is the same shape
 * as one that has not been started yet - and the two mean opposite things to
 * everything downstream. Without this map a failed start read as "still
 * warming" for as long as the source stayed switched on: its saved roster was
 * republished over a port nothing was listening on, and the panel reported no
 * drift while every request to that address was refused.
 */
const gatewayStartFailures = new Map();

/**
 * The same record for Trae and Qoder, keyed `source:region`.
 *
 * `gatewayStartFailures` is keyed by region alone because WorkBuddy is the only
 * source whose regions collide. Trae and Qoder needed their own map and did not
 * have one: a failed start left `spec.gateways` without an entry, which
 * `warmingGatewayIds` read as "still on its way", so the saved roster was
 * republished against a port nothing was listening on while the doctor and the
 * panel both reported the session healthy.
 *
 * Entries are cleared wherever the gateway is installed or removed, so a
 * switched-off source never reads as a failed one.
 */
const sourceStartFailures = new Map();

function sourceKey(source, region) {
  return source + ":" + region;
}

/**
 * True while no background service is running.
 *
 * `onServiceStop` clears `runtimes`, but a refresh pass already in flight goes on
 * to create its own runtimes and writes them back - and `runtimes.clear()` has
 * already run, so nothing would ever close those shims again. Every creator reads
 * this flag first, the way it reads `runtime.stopped` after an await.
 */
let serviceStopped = true;
/**
 * Counts activations, so a pass from a retired one can tell that it is stale.
 *
 * A refresh suspends at network awaits, and unload cannot wait for it. Without
 * this the pass resumes after teardown and re-creates what teardown just closed:
 * it binds a fresh gateway on the port and fills maps that were cleared - all
 * ownerless, because unload has already run. Every pass therefore carries the
 * generation it started in and stops at its own await points once that number
 * moves.
 */
let loadGeneration = 0;

/**
 * True while `generation` is still the live activation.
 *
 * Every long pass checks this after an await before it touches shared state, so
 * a pass that outlived its activation gives up instead of re-opening gateways
 * and timers the teardown has already closed.
 */
function stillLoaded(generation) {
  return !serviceStopped && generation === loadGeneration;
}
/** Shared upstream client and account pool, built in onLoad. */
const core = { client: null, pool: null };

/** Handle for the one deferred refresh, so a burst of opens coalesces. */
let refreshTimer = null;
/** The background refresh in flight, so two passes never overlap. */
let refreshInflight = null;
/** The host settings listener, kept so onUnload can detach it. */
let settingsChangedHandler = null;

/** The daily check-in timer, and what it has already collected. */
let autoCheckinTimer = null;
/**
 * Timer that re-reads the desktop sign-ins while the service runs.
 *
 * Once a minute because a switch in the client overwrites the global sign-in
 * file in place: the pool only has the account if it read the file before that.
 */
let accountWatchTimer = null;
/**
 * True while a check-in pass is running, whichever entry point started it.
 *
 * One flag for all three — the scheduled tick, the host command and the panel's
 * "run now" — because two passes writing `autoCheckinLast` would leave the log
 * describing whichever finished last rather than what the user asked for.
 */
let checkinPassRunning = false;
/** Which pass owns the running flag; see `runCheckinPass`. */
let checkinPassToken = 0;
/**
 * True while the growth centre runs on its own, from the panel's card.
 *
 * Separate from `checkinPassRunning` because the two are different passes over
 * the same accounts: a growth run started beside a check-in pass would stack
 * two unpaced request clusters on one account, which is what the upstream
 * reads as a burst. The card refuses while either is running.
 */
let growthPassRunning = false;
/** Which run owns `growthPassRunning`, on the same rule as `checkinPassToken`. */
let growthPassToken = 0;
/**
 * The last standalone growth run, in the shape the scheduled pass records its
 * own growth half in. In memory only: after a restart the card falls back to
 * the growth half of the last scheduled pass, which is persisted with it.
 */
let growthLast = null;
/**
 * The growth centre's last successful read, kept so a repaint or a fresh panel
 * paints it instead of asking the user to read again.
 *
 * In memory only: the card re-reads on entry once the figure is a couple of
 * minutes old anyway, so a copy on disk bought one narrow case and brought a
 * stale-account path with it.
 */
let growthRead = null;
/**
 * Which read the answer in flight belongs to.
 *
 * A read walks several accounts and can take seconds, so a user can park a region
 * while it runs. Comparing this counter around the await is what stops that
 * answer - computed against the pool as it was - from being written back over the
 * drop that just happened.
 */
let growthReadEpoch = 0;

/**
 * Forget the cached read because the accounts behind it changed.
 *
 * Parking a region or switching the WorkBuddy source off changes which accounts
 * a read would return, so the rows in hand describe a pool that no longer
 * exists - and they are recent enough to look current. Dropping them makes the
 * next entry re-read; keeping them showed an account the user had just switched
 * off.
 */
function dropGrowthRead() {
  growthRead = null;
  // Bumped so a read already in flight cannot write its answer back over the drop:
  // it was computed against the pool that existed before the user's change.
  growthReadEpoch += 1;
}
/**
 * Set when the plugin is going away, so a pass already in flight stops early.
 *
 * Nothing awaits `runCheckinPass` - Trae alone paces its accounts five seconds
 * apart - so without this a pass kept calling the upstream after the shutdown
 * was asked for, for accounts whose result nobody will ever read.
 */
let checkinAbort = new AbortController();
const checkinScope = new AsyncLocalStorage();
function currentCheckinSignal() {
  return checkinScope.getStore() ?? checkinAbort.signal;
}
/** Slots this process has collected, as `YYYY-MM-DDTHH` in the campaign's zone. */
const autoCheckinSlots = new Set();
/**
 * Where the collected slots outlive the process, and for how long.
 *
 * The set above is memory only, so a restart after 09:00 read as a fresh day:
 * the earliest hour was unconsumed and the whole pass ran again. The filename
 * and shape are the ones the DSH twin writes, so two plugins installed side by
 * side agree on what today has already collected.
 */
const CHECKIN_SLOTS_FILE = "checkin-slots.json";
const CHECKIN_SLOTS_KEEP_DAYS = 3;
/** The last automatic pass, for the panel's status line. */
let autoCheckinLast = null;
/** The last token keep-alive pass, for the panel's status line. */
let keepAliveLast = null;
/**
 * When a deferred pass is owed, in ms; 0 = nothing pending.
 *
 * Qoder's daily round only exists from 10:00 Beijing, so an automatic pass at
 * 09:00 cannot collect it. Rather than adding a second timer, this remembers
 * the opening time and the same timer comes back for it then.
 */
let qoderRetryAt = 0;
/**
 * How long a deferred Qoder round waits before the tick comes back for it
 * after a failure.
 *
 * The deferral is owed once a day, so a failed attempt has to stay owed - but
 * a read that throws every time must not be retried every minute either.
 */
const QODER_RETRY_BACKOFF_MS = 10 * 60 * 1000;
/**
 * Cat-travel pacing: one pass per account, same throttle as the upstream's own
 * scheduler. A single `travelOne` already fans out to several RPCs, so a tight
 * loop would look like a burst to the upstream.
 */
const TRAVEL_ACCOUNT_DELAY_MS = 800;
/** Pause between two Qoder accounts' check-ins, so a batch does not read as a burst. */
const QODER_ACCOUNT_DELAY_MS = 1000;
/**
 * Pause between two WorkBuddy accounts' check-ins.
 *
 * The same pacing the other sources get: a pass over several accounts with no
 * gap between them is a burst from the upstream's side, and the growth pass
 * that follows walks the same accounts again seconds later.
 */
const CHECKIN_ACCOUNT_DELAY_MS = 700;
/** Trae's check-in pace: 5 s between accounts, ±2 s jitter (the spacing its endpoint is proven with). */
const TRAE_ACCOUNT_DELAY_MS = 5000;
const TRAE_ACCOUNT_JITTER_MS = 2000;
/** Wait after the adopt preflight report before calling buddy/first. */
const TRAVEL_ADOPT_GAP_MS = 1050;
/** Between the check-in burst and the growth burst on the same accounts. */
const GROWTH_AFTER_CHECKIN_MS = 1500;
/** Between one domestic account and the next inside the growth pass. */
const GROWTH_ACCOUNT_DELAY_MS = 400;
/**
 * Pause after lighting the streak before reading it back.
 *
 * The upstream scores the reported chat against the account's streak in its own
 * time: a read issued in the same tick still answers the previous day's
 * counter, so the tier state read right after the report is stale by one day
 * and the pass reports nothing redeemed on the day the tier actually opened.
 */
const STREAK_REPORT_READ_GAP_MS = 1200;
/** Account ids that hit the adopt conversation threshold today (CST day). */
const travelAdoptTried = new Map();

function log(level, message) {
  try {
    console.log("[wtq-pool] " + level + ": " + message);
  } catch {
    /* logging must never break a request */
  }
}

/**
 * One gateway logger line from what a gateway passed it.
 *
 * The gateways call `warn(message, error)`, and an adapter that took only the
 * first argument threw away the only explanation a closed socket or a failed
 * upstream read ever had. Detail goes through the same redaction every other
 * error text gets, so nothing unredacted reaches the log through it.
 */
function gatewayLogLine(prefix, args) {
  return prefix + args.map(safeMessage).join(" ");
}

function regionOfKey(value) {
  return value === "global" ? "global" : "cn";
}

// ---------------------------------------------------------------- settings

/**
 * Take over the settings file written under one of this plugin's former ids,
 * newest first.
 *
 * The host derives the plugin data directory from the plugin id, so renaming
 * the plugin would otherwise start it with an empty settings file and the model
 * selection, per-model reasoning levels and usage mode the user had saved would
 * look lost.
 *
 * Only the settings file is carried over, and only when this id has none of its
 * own: a normal load never reads the old directory, and a second load is a
 * no-op. The old copy stays in place rather than being moved, so reverting the
 * rename would still find it.
 */
/** Returns true when this load had to take over a previous id's file. */
async function adoptPreviousDataDir() {
  if (dataPath === "") return false;
  const own = path.join(dataPath, "settings.json");
  if (fs.existsSync(own)) return false;
  const source = PREVIOUS_PLUGIN_IDS
    .map((id) => path.join(path.dirname(dataPath), id, "settings.json"))
    .find((candidate) => fs.existsSync(candidate));
  if (source === undefined) return false;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.copyFileSync(source, own);
    log("info", "carried settings over from the previous plugin id");
    return true;
  } catch (error) {
    log("warn", "could not carry settings over from the previous id: " + safeMessage(error));
  }
  return false;
}

/**
 * Read the settings document.
 *
 * `undefined` means the read failed, which is not the same answer as an empty
 * document and must not be treated as one - see {@link adoptHostSettings}.
 */
async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return undefined;
  }
}

/**
 * Replace this process's settings with a fresh read, unless that read failed or
 * a local write landed while it was in flight. Returns whether it replaced them.
 *
 * Two failures are ruled out here. A failed read is not an empty document:
 * returning `{}` let one transient host RPC error wipe this process's copy of
 * `disabledAccountIds`, `removedAccounts`, `creditReserves`, `modelSelection`
 * and the parked regions, and because the panel's save helpers spread that copy
 * before writing one key, the next save made the loss permanent. A read that
 * raced a save is also older than that save by definition, so taking it reverted
 * the switch the user had just flipped.
 */
async function adoptHostSettings() {
  const revision = settingsRevision;
  const next = await loadSettings();
  if (next === undefined) {
    log("warn", "could not read settings; keeping the last known document");
    return false;
  }
  if (settingsRevision !== revision) return false;
  settings = next;
  return true;
}

/**
 * Persist a partial settings patch.
 *
 * Returns false instead of throwing so a request path can never be broken by a
 * rejected write, but the caller still learns that nothing was stored.
 *
 * Every write goes through `enqueueWrite`, because a dictionary-shaped setting
 * is read as a whole, edited and written back as a whole. Two of those in
 * flight at once had the second one overwrite the first with the stale copy it
 * read, and the panel answered success for a change that was gone.
 */
async function saveSettings(patch) {
  return enqueueWrite(async () => {
    try {
      await pi.plugin.setSettings(patch);
      settings = { ...settings, ...patch };
      settingsRevision += 1;
      return true;
    } catch (error) {
      log("warn", "could not save settings: " + safeMessage(error));
      return false;
    }
  });
}

/**
 * Serialise the settings writes, and re-read before each one runs.
 *
 * The queue is what makes a read-edit-write of a dictionary key safe: the work
 * inside it sees the document the previous write left behind, including one the
 * host's own settings UI made while this one was waiting. A rejected write does
 * not block the next one, because a failed save is a normal outcome the caller
 * already reports.
 */
let writeChain = Promise.resolve();
function enqueueWrite(work) {
  const run = writeChain.then(work, work);
  // The chain carries the outcome of the last write for the NEXT writer, so it
  // must never be a rejected promise itself.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Read, edit and write one settings key as a single serialised step.
 *
 * A dictionary-shaped setting is written back whole, so the read has to happen
 * inside the queue rather than before it: two channels that both read the old
 * document and then both wrote had the second overwrite the first, and the
 * panel answered success for a change that was already gone. Re-reading before
 * the edit also picks up whatever the host's own settings UI stored while this
 * one was waiting.
 *
 * `mutate` receives the value in force and answers the next one; answering
 * `undefined` means "no change", which skips the write entirely.
 */
async function mutateSettings(key, mutate) {
  return enqueueWrite(async () => {
    // A failed read is not fatal: the last known document is still the best
    // answer available, and refusing the edit would drop a change the user can
    // see they made.
    await adoptHostSettings();
    const current = settings[key];
    const next = await mutate(current);
    if (next === undefined) return true;
    try {
      await pi.plugin.setSettings({ [key]: next });
      settings = { ...settings, [key]: next };
      settingsRevision += 1;
      return true;
    } catch (error) {
      log("warn", "could not save settings: " + safeMessage(error));
      return false;
    }
  });
}

/**
 * Apply a settings payload the host pushed at this process.
 *
 * The host validates and stores first, then announces the merged document, so a
 * selection edited in the host's own settings UI reaches the running plugin
 * here instead of only after a reload. The selection is re-applied and the
 * declaration republished straight away, because a narrower model list has to
 * reach the picker or the user still sees the models they just disabled.
 */
async function onHostSettingsChanged(next) {
  if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
  // A source switch in the host's own settings UI has to reach discovery the
  // same way the panel's does: the cached sign-in list was read while the source
  // was off, and the cache says nothing about that. The host announces the merged
  // document, so the switch is a changed value rather than a present key - and a
  // caller passing an empty patch (the panel's own switches) resets for itself.
  const toggled = Object.values(SOURCE_SETTING_KEYS)
    .some((key) => Object.hasOwn(next, key) && settings[key] !== next[key]);
  settings = { ...settings, ...next };
  settingsRevision += 1;
  if (toggled) resetDiscoveryCaches();
  applySettingsToCore();
  traeAccountRows = traeAccountRows.filter((row) => regionEnabled("trae", row.region));
  qoderAccountRows = qoderAccountRows.filter((row) => regionEnabled("qoder", row.region));
  // A parked region must lose its gateway now, not at the next refresh: its
  // port would otherwise stay bound and its endpoint would keep serving.
  // Skipped while no service runs - `applySettingsToCore` above already retired
  // what was there, and reconciling would start gateways for a stopped plugin.
  if (!serviceStopped) {
    await reconcileTraeGateways();
    await reconcileQoderGateways();
  }
  syncDeclaration();
  // The cached billing answers belong to the accounts the last switch left in
  // the pool, so only a switch invalidates them. Blanking them on every edit
  // made the panel show `—` for every account until the next probe refilled it,
  // which is what a cooldown edited in the host's own settings card used to do.
  if (toggled) probeCache.clear();
  // A source or region switched from the host's own settings card changes which
  // accounts a read would return, exactly as the panel's switch does. Without this
  // an answer already in flight writes its rows back as freshly read, and the
  // card shows accounts the user just parked for the whole throttle window.
  if (toggled) dropGrowthRead();
  scheduleRefresh("settings");
  return true;
}

/** Subscribe to the host's settings event, tolerating a host without it. */
function subscribeToHostSettings() {
  // A reload can arrive without the previous unload, so the handler this call
  // replaces has to be detached first: an orphaned closure kept reacting to
  // every host edit, running a second reconcile and a second declaration write,
  // and it survived the unload that followed.
  unsubscribeFromHostSettings();
  settingsChangedHandler = (next) => {
    // Reconciling the gateways awaits, so the promise is handled here rather
    // than returning anything meaningful to the event source.
    onHostSettingsChanged(next)
      .then((applied) => { if (applied) log("info", "settings changed in the host UI; selection re-applied") })
      .catch((error) => log("warn", "applying host settings failed: " + safeMessage(error)));
  };
  try {
    if (pi.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", settingsChangedHandler);
      return true;
    }
  } catch (error) {
    log("warn", "could not subscribe to settings changes: " + safeMessage(error));
  }
  settingsChangedHandler = null;
  return false;
}

/** Detach the host settings handler, if one is held. */
function unsubscribeFromHostSettings() {
  const handler = settingsChangedHandler;
  settingsChangedHandler = null;
  if (handler === null) return;
  try {
    if (pi.events && typeof pi.events.off === "function") pi.events.off("plugin:settingsChanged", handler);
  } catch (error) {
    log("warn", "could not unsubscribe from settings changes: " + safeMessage(error));
  }
}

function cooldownMs() {
  const value = Number(settings.cooldownSeconds);
  if (!Number.isFinite(value) || value <= 0) return 60000;
  return Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.round(value * 1000)));
}

/** The modes other than `priority`, which is what an unrecognised or absent value means. */
const WORKBUDDY_DISTRIBUTIONS = ["round-robin", "expiry", "sticky"];

function distributionSetting() {
  const value = settings.distribution;
  return WORKBUDDY_DISTRIBUTIONS.includes(value) ? value : "priority";
}

/** Hours in force now: what the user configured, or the default. */
function checkinHours() {
  const raw = settings.autoCheckin?.hours;
  return normaliseCheckinHours(Array.isArray(raw) ? raw : []);
}

function autoCheckinEnabled() {
  return settings.autoCheckin?.enabled === true;
}

/** The day keys the slot file still keeps, in the check-in zone. */
function recentCheckinDays() {
  const days = [];
  for (let back = 0; back < CHECKIN_SLOTS_KEEP_DAYS; back += 1) {
    days.push(zonedDayHour(new Date(Date.now() - back * 86400000)).day);
  }
  return new Set(days);
}

/**
 * Read the slots earlier runs collected, keeping only the recent days.
 *
 * An absent or unreadable file is the same answer as a day with no entry, so it
 * leaves the set alone rather than being read as a day already spent.
 */
function loadCheckinSlots() {
  if (dataPath === "") return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dataPath, CHECKIN_SLOTS_FILE), "utf8"));
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const kept = recentCheckinDays();
  for (const [day, slots] of Object.entries(parsed)) {
    if (!kept.has(day) || !Array.isArray(slots)) continue;
    for (const slot of slots) {
      if (typeof slot === "string" && slot !== "") autoCheckinSlots.add(slot);
    }
  }
}

/** Record the collected slots, pruned to the retention window. */
function saveCheckinSlots() {
  if (dataPath === "") return;
  const kept = recentCheckinDays();
  const byDay = {};
  for (const slot of autoCheckinSlots) {
    const day = slot.slice(0, 10);
    if (!kept.has(day)) continue;
    (byDay[day] = byDay[day] || []).push(slot);
  }
  // Declared out here, where the catch can see it: the cleanup it does on a
  // failed write is the whole point, and a staging name the catch cannot reach
  // leaves the file behind for as long as the plugin is installed.
  const target = path.join(dataPath, CHECKIN_SLOTS_FILE);
  const staging = target + ".tmp";
  try {
    // The host normally creates this directory; the one case it does not is a
    // data path taken over from a previous plugin id, whose copy is made by
    // `adoptPreviousDataDir`. Without this the slots would silently never persist.
    fs.mkdirSync(dataPath, { recursive: true });
    // Written beside its target and renamed, like the declaration: a process
    // killed mid-write leaves the previous file whole rather than a truncated
    // one that reads as a day with no entries.
    fs.writeFileSync(staging, JSON.stringify(byDay, null, 2) + "\n", "utf8");
    fs.renameSync(staging, target);
  } catch (error) {
    // A write that failed halfway leaves the staging file behind, and nothing
    // ever renames or overwrites it: the data directory then keeps a stale
    // copy of a day's record next to the real one, for as long as the plugin
    // is installed.
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      /* nothing to clean up */
    }
    // A file that cannot be written costs the next restart its memory of today,
    // which is one duplicate pass - not worth breaking a check-in over.
    log("warn", "could not record the collected check-in slots: " + safeMessage(error));
  }
}

function preferredAccountId(region) {
  const value = settings.preferredAccountIds?.[region];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Storage key for one source region's picked account. */
function sourceRegionKey(source, region) {
  return source + ":" + region;
}

/** The account the user picked for one source region; "" means automatic. */
function preferredSourceAccount(source, region) {
  const value = settings.preferredSourceAccounts?.[sourceRegionKey(source, region)];
  return typeof value === "string" ? value : "";
}

/** The picked account per active region of one source, for the panel's picker. */
function sourcePreferredMap(source) {
  const regions = source === "trae" ? activeTraeRegions() : activeQoderRegions();
  const map = {};
  for (const region of regions) map[region] = preferredSourceAccount(source, region);
  return map;
}

/**
 * The Trae/Qoder accounts this run found, for one source.
 *
 * Both the composer chip and the panel picker name an account by this label, and
 * both have to store it. Reading them from here is what lets a choice be checked
 * against the sign-ins that actually exist instead of being written blind.
 */
function sourceAccountLabels(source, region) {
  const rows = source === "trae" ? traeAccountRows : qoderAccountRows;
  return rows
    .filter((row) => row.region === region && row.expired !== true)
    .map((row) => row.label);
}

/**
 * Whether a named account may be stored as the preferred one.
 *
 * An empty label clears the preference, which is always allowed. Any other label
 * has to name an account this run found and that has not expired: storing a name
 * nothing can match leaves the picker silently falling back to its own default,
 * so the click looks like it worked and the same account keeps serving.
 */
function sourceAccountMayBePreferred(source, region, label) {
  if (label === "") return true;
  return sourceAccountLabels(source, region).includes(label);
}

/** Usage modes one source can follow. `expiry` spends the soonest one-off pack first. */
const SOURCE_DISTRIBUTIONS = ["round-robin", "expiry"];

/** How one source spreads requests when no account is picked for the region. */
function sourceDistribution(source) {
  const value = settings.sourceDistributions?.[source];
  return SOURCE_DISTRIBUTIONS.includes(value) ? value : "priority";
}

/** Soonest remaining one-off pack. Monthly and never-expiring pools do not count. */
function nearestPackExpiry(packages) {
  let best;
  const now = Date.now();
  for (const pack of packages || []) {
    if (pack.monthly === true || pack.neverExpires === true) continue;
    const when = typeof pack.expiresAtMs === "number" ? pack.expiresAtMs
      : typeof pack.roundExpiresAtMs === "number" ? pack.roundExpiresAtMs
      : undefined;
    if (typeof when !== "number" || when <= now) continue;
    if (typeof pack.remain === "number" && pack.remain <= 0) continue;
    if (best === undefined || when < best) best = when;
  }
  return best;
}

/**
 * The account pool the Trae and Qoder gateways share.
 *
 * WorkBuddy's own pool cools an account the moment the upstream refuses it, so
 * the next request never pays the same failure twice. These two sources rotate
 * only inside one request, so their failure holds, pack expiries and rotation
 * cursor live here instead - the same decisions, kept apart from the pool that
 * makes them for WorkBuddy.
 *
 * The settings each decision reads stay the plugin's own, so they are handed to
 * the pool once, at load.
 */
const {
  sourceCreditExpiry,
  sourceRotation,
  sourceFailureHold,
  sourceCredentialExpired,
  accountStateKey,
  noteSourceFailure,
  orderSourceCredentials,
} = createSourcePool({ cooldownMs, preferredSourceAccount, sourceDistribution, sourceRegionKey });

function noteSourceExpiry(source, region, label, packages) {
  const at = nearestPackExpiry(packages);
  const key = accountStateKey(source, region, label);
  if (at === undefined) sourceCreditExpiry.delete(key);
  else sourceCreditExpiry.set(key, at);
}

/** Account ids switched off on the panel; the pool never picks them. */
function disabledAccountIds() {
  const value = settings.disabledAccountIds;
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id !== "");
}

/** Per-account credit floor from the panel, keyed by account id. */
function creditReserves() {
  const value = settings.creditReserves;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const clean = {};
  for (const [id, raw] of Object.entries(value)) {
    const floor = Number(raw);
    // Clamped to the same ceiling the panel's save path enforces: a hand-edited
    // document could otherwise store a floor past any balance a user could hold,
    // and the account would be parked for good with nothing to act on.
    if (id !== "" && Number.isFinite(floor) && floor > 0) clean[id] = Math.min(Math.floor(floor), MAX_CREDIT_RESERVE);
  }
  return clean;
}

/**
 * Accounts removed from the pool for good, with label and gateway kept so the
 * panel can still offer a restore after the account stops being scanned.
 */
function removedAccounts() {
  const value = settings.removedAccounts;
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry !== null && typeof entry === "object"
    && typeof entry.id === "string" && entry.id !== ""
    && REGIONS.includes(entry.region));
}

/**
 * The saved model selection for one gateway.
 *
 * The original kept a single selection for the whole pool; the port keys it per
 * gateway so the two picker groups can be filtered independently. Absent means
 * "everything enabled" - an unconfigured install must never show an empty list.
 */
function selectionFor(region) {
  return gatewaySelectionFor(regionOfKey(region));
}

/** The stored selection for one raw gateway key, absent means "everything on". */
function gatewaySelectionFor(key) {
  const all = settings.modelSelection && typeof settings.modelSelection === "object" ? settings.modelSelection : {};
  return normalizeSelection(all[key]);
}

/**
 * The ids one gateway's stored selection keeps; null means publish everything.
 * A selection naming no live model is treated as unset, mirroring
 * savedSelectionMatches, so a renamed catalog never empties the group.
 */
function gatewayEnabledIds(key, catalogIds) {
  const enabled = gatewaySelectionFor(key).enabledModelIds;
  if (!Array.isArray(enabled)) return null;
  if (enabled.length === 0) return new Set();
  const known = new Set(catalogIds);
  const kept = enabled.filter((id) => known.has(id));
  return kept.length > 0 ? new Set(kept) : null;
}

/**
 * The selection as the gateway really publishes it, for the panel to render.
 *
 * The declaration normalizes a stored selection whose every id has been renamed
 * away back to "everything on", and the panel has to show that same answer. It
 * used to read the raw stored value, so a catalog rename showed every model
 * unticked while the gateway published all of them, with no way back: ticking
 * them produced the same normalized selection again.
 */
function publishedSelectionFor(key, catalogIds) {
  const stored = gatewaySelectionFor(key);
  const enabled = gatewayEnabledIds(key, catalogIds);
  if (enabled !== null) return { ...stored, enabledModelIds: [...enabled] };
  // Null means "publish everything", which the panel reads as an absent list.
  const { enabledModelIds, ...rest } = stored;
  return rest;
}

/** Stored per-model overrides for one gateway key ("trae:cn", ...), by model id. */
function gatewayOverrides(key) {
  const overrides = gatewaySelectionFor(key).overrides;
  return overrides !== null && typeof overrides === "object" ? overrides : {};
}

/**
 * One Trae/Qoder model as the panel edits it: the value in force, the value the
 * gateway reported, and whether the user changed it. The manifest declaration
 * and the status document both read this, so what the editor shows is what gets
 * published.
 */
function sourceModelView(key, model, native) {
  const id = String(model.id || "").trim();
  const override = gatewayOverrides(key)[id] ?? {};
  const nativeName = typeof model.name === "string" && model.name !== "" ? model.name : id;
  const alias = typeof override.alias === "string" && override.alias.trim() !== "" ? override.alias.trim() : undefined;
  // The highest window the model accepts: its Max tier when the directory states
  // one, otherwise the default the row was built at. A stored override may reach
  // this but never past it, so a declaration cannot size the host's budget for
  // room the gateway would refuse.
  const nativeCeiling = Math.max(
    positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
    positiveInteger(native.maxContextWindow, 0),
  );
  // Field names are the pool's, not the gateways': one model shape means the
  // panel's editor reads a Trae row exactly as it reads a WorkBuddy one.
  //
  // Both the panel's editor and the manifest declaration read what follows, so
  // the host's own bounds are applied here: a hand-edited or legacy settings.json
  // with an out-of-range figure would otherwise be published verbatim, and the
  // host rejects a declaration that breaks its bounds. The catalog's figure is the
  // ceiling as well: `sourceModelView` is only reached from a live directory scan,
  // so `native` is what the gateway really accepts, and a larger declared window
  // would size the host's budget past what the gateway can take.
  //
  // The output budget belongs to the function that serves the window in force:
  // above the model's default the Max function states its own, smaller one.
  const declaredWindow = Math.min(
    positiveInteger(
      Number.isFinite(override.contextWindow) ? override.contextWindow : native.contextWindow,
      CONSERVATIVE_CONTEXT_WINDOW,
    ),
    nativeCeiling,
  );
  const outputCeiling = positiveInteger(
    declaredWindow > positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW)
      ? native.maxTokensAtCeiling
      : native.maxTokens,
    positiveInteger(native.maxTokens, DEFAULT_MAX_TOKENS),
  );
  return {
    id,
    name: alias ?? nativeName,
    ...alias === undefined ? {} : { alias },
    nativeName,
    contextWindow: declaredWindow,
    maxOutputTokens: Math.min(
      positiveInteger(
        Number.isFinite(override.maxOutputTokens) ? override.maxOutputTokens : outputCeiling,
        DEFAULT_MAX_TOKENS,
      ),
      outputCeiling,
    ),
    nativeContextWindow: native.contextWindow,
    // The output ceiling of the DEFAULT tier, which is what the editor compares a
    // draft window against. Naming the window-dependent figure here made the field
    // report the Max tier's smaller budget while the draft was back on the default
    // window, and the panel then refused a value the gateway accepts.
    nativeMaxOutputTokens: positiveInteger(native.maxTokens, DEFAULT_MAX_TOKENS),
    // And the one that applies once the draft reaches above the default window.
    ...native.maxTokensAtCeiling === undefined ? {} : { maxOutputAtCeiling: positiveInteger(native.maxTokensAtCeiling, outputCeiling) },
    // The model's real ceiling, which for a Max-capable model is above the
    // default tier. The editor sizes its field to this so the user can pick the
    // Max window; the declared value stays whatever is in force above.
    ...nativeCeiling > positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW)
      ? { maxContextWindow: nativeCeiling }
      : {},
    supportsImages: typeof override.supportsImages === "boolean" ? override.supportsImages : native.supportsImages,
    nativeSupportsImages: native.supportsImages,
    // The levels the gateway itself advertises, so the panel's editor can offer
    // the control on the same term the WorkBuddy roster does. Without them a
    // Trae or Qoder model that advertises a reason menu showed no way to edit
    // it, and the override the panel did save never reached the declaration.
    ...Array.isArray(native.thinkingLevels) && native.thinkingLevels.length > 0
      ? { nativeThinkingLevels: [...native.thinkingLevels] }
      : {},
    // The user's level list, when they set one. Every other field here has a
    // `native` twin beside it; this one has none because a gateway publishes
    // whatever levels it advertises rather than a stored default, and the
    // declaration decides what to do with an edited list.
    ...Array.isArray(override.thinkingLevels) && override.thinkingLevels.length > 0
      ? { thinkingLevels: override.thinkingLevels }
      : {},
    // The upstream cost, read-only: it is the gateway's price, not a setting, so
    // there is no override and no `nativeMultiplier` beside it. WorkBuddy models
    // carry the same field, which is what the panel's cost chip reads.
    ...native.multiplier === undefined ? {} : { multiplier: native.multiplier },
    advanced: Object.keys(override).length > 0,
  };
}
/** One gateway's models in that shape; `nativeOf` reports what the gateway itself said. */
function sourceRosterFor(key, models, nativeOf) {
  // The roster is the same list the declaration is published from, so it is
  // filtered on the same term: an entry with no id cannot be published, saved or
  // matched to a model, and a roster row that leads nowhere only reads as junk.
  const source = key.split(":")[0];
  return models
    .filter((model) => String(model.id || "").trim() !== "")
    .map((model) => sourceModelView(key, model, nativeOf(model)))
    .filter((view) => isSelectableSourceModel(source, view));
}
/**
 * A source gateway's roster plus the selection that gateway really publishes.
 * One roster pass answers both, so the panel ticks exactly what the declaration
 * emits: a stored selection whose every id has been renamed away normalizes to
 * "publish everything" instead of every model showing unticked while the
 * gateway serves them all.
 */
function sourcePublishedModels(key, models, nativeOf) {
  const roster = sourceRosterFor(key, models, nativeOf);
  return { roster, selection: publishedSelectionFor(key, roster.map((view) => view.id)) };
}

/**
 * Trae's internal slots, by the names the IDE gives them.
 *
 * They are the IDE's own, stable across versions, and are what distinguishes a
 * helper slot from a model — a helper sometimes carries a borrowed display name,
 * so the name alone cannot answer it. The IDE appends a variant suffix to some of
 * them over time (`fast_apply_new`), so the names are matched by prefix.
 */
const TRAE_INTERNAL_MODEL_ID_RE = /^(custom_model|search_agent|summary|fast_apply|title_generation|input_optimization|laziness_detection)(_|$)|_(subagent|agent)(_|$)|-(for-)?auto$/;

/**
 * Whether one gateway model is something to offer in the picker.
 *
 * Trae's directory is the IDE's slot table rather than a model catalogue: beside
 * the models it lists the slots the IDE fills in for itself — the
 * `custom_model_*` placeholders it binds to a provider at runtime, the
 * `search_agent_*` and `*_subagent` helpers it drives, the `-auto` entries it
 * routes on its own, and housekeeping endpoints like `summary`. Offering those
 * fills the picker with rows that answer nothing.
 *
 * A model with no name to show is dropped on either source: Trae lists `sagitta`
 * and `aquila` as `—`, which is the whole of what the picker could say about them.
 *
 * Qoder's ids are exempt from the shape test. They are its real names — `qmodel`,
 * `gfmodel`, `kmodel_latest` — and an underscore test written for Trae would
 * delete every one of them.
 */
function isSelectableSourceModel(source, view) {
  // The placeholder test is about the catalog's own names. An alias is a label
  // the user chose, so a punctuation-only one must not delete the model from the
  // roster, the picker and the declaration; the name shown still has to exist.
  const native = typeof view.nativeName === "string" ? view.nativeName.trim() : "";
  const name = typeof view.name === "string" ? view.name.trim() : "";
  if (name === "" || native === "" || !/[\p{L}\p{N}]/u.test(native)) return false;
  if (source !== "trae") return true;
  return !TRAE_INTERNAL_MODEL_ID_RE.test(view.id);
}

/**
 * Fold a stored selection into the shape the rest of the plugin reads.
 *
 * `overrides` is the only per-model shape written now, but a settings file from
 * an earlier version stores the same two edits as `imageModelIds` and
 * `contextBudgets`. Both are read and folded in, so upgrading never silently
 * discards edits the user already made.
 */
function normalizeSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  if (Array.isArray(value.enabledModelIds)) out.enabledModelIds = value.enabledModelIds;
  // Null prototype: an id of `__proto__` is an own key of a JSON-parsed document
  // but assigns the prototype on a plain `map[id] = …`, so that edit vanished
  // while both the save and the read reported success.
  const overrides = Object.create(null);
  if (value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)) {
    for (const [id, entry] of Object.entries(value.overrides)) {
      if (typeof id === "string" && id !== "" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        overrides[id] = { ...entry };
      }
    }
  }
  for (const id of Array.isArray(value.imageModelIds) ? value.imageModelIds : []) {
    if (typeof id === "string" && id !== "") {
      overrides[id] = { ...(overrides[id] || {}), supportsImages: true };
    }
  }
  // An array is not a map: `Object.entries` over one folds its elements into the
  // keys "0" and "1", which would store overrides for model ids that do not
  // exist. The DSH entry refuses the shape for the same reason.
  const budgets = value.contextBudgets && typeof value.contextBudgets === "object" && !Array.isArray(value.contextBudgets) ? value.contextBudgets : {};
  for (const [id, budget] of Object.entries(budgets)) {
    // The same bar `parseOverride` applies on a panel save: a non-integer or an
    // unbounded value is refused there, so accepting one here reads back a
    // figure no save could have produced.
    if (typeof id === "string" && id !== "" && typeof budget === "number"
      && Number.isInteger(budget) && budget > 0 && budget <= MAX_TOKEN_BUDGET) {
      overrides[id] = { ...(overrides[id] || {}), contextWindow: budget };
    }
  }
  if (Object.keys(overrides).length > 0) out.overrides = overrides;
  return out;
}

/**
 * The selection actually applied to one gateway's catalog.
 *
 * A stored selection can name models the live roster no longer carries (the
 * upstream renames and retires models). Applying that verbatim would filter
 * every model out: the picker group would vanish, the panel would show nothing
 * enabled, and no save could be made to look like it took effect. When none of
 * the saved ids exist any more, the selection is treated as unset so the group
 * stays usable, and `selectionStale` tells the panel to say why.
 *
 * Takes the catalog explicitly rather than looking it up in `runtimes`: it is
 * called while a runtime is still being constructed, before it is registered.
 */
function savedSelectionMatches(region, catalog) {
  const enabled = selectionFor(region).enabledModelIds;
  if (!Array.isArray(enabled) || enabled.length === 0 || !catalog) return true;
  const known = new Set(catalog.current().map((model) => model.id));
  return enabled.some((id) => known.has(id));
}

function effectiveSelectionFor(region, catalog) {
  return selectionJudgeable(catalog) && savedSelectionMatches(region, catalog) ? selectionFor(region) : {};
}

/**
 * Whether a saved selection can be judged against this roster at all.
 *
 * Only a roster the upstream answered with can retire an id. The static
 * fallback is this plugin's own guess, and judging against it reported every
 * model the vendor had added since as retired: the user's choice was replaced by
 * the fallback's list and the panel said so on every start, for as long as the
 * live read kept timing out.
 */
function selectionJudgeable(catalog) {
  return catalog !== undefined && catalog.hasLiveRoster() === true;
}

/** True when a gateway's stored selection no longer matches its live roster. */
function selectionStale(region, catalog) {
  return selectionJudgeable(catalog) && !savedSelectionMatches(region, catalog);
}

/**
 * Apply the user's selection to one gateway's catalog, after checking it
 * against the roster that gateway actually has.
 *
 * Called when settings change, when a runtime is built, and after the roster is
 * (re)read, because a selection is only meaningful relative to the current
 * catalog: a re-read can retire every id a saved selection names.
 */
function applyEffectiveSelection(region, runtime) {
  const target = runtime ?? runtimes.get(regionOfKey(region));
  if (!target) return;
  target.catalog.applySelection(effectiveSelectionFor(region, target.catalog));
  if (selectionStale(region, target.catalog)) {
    target.lastWarning = "the saved model selection no longer matches the live model list; showing every model";
  }
}

// ------------------------------------------------------------------ network

/** The port one gateway prefers, and the only address it ever publishes. */
function preferredPort(region) {
  const port = REGION_PORTS[region];
  return typeof port === "number" ? port : 0;
}

/**
 * A pause, for the retry loops below.
 *
 * The timer is unref'd: a pause nobody is waiting for any more - the plugin is
 * unloading, or the whole pass it belongs to has already been abandoned - must
 * not be the reason the process stays alive.
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Unref: a pause is never the reason a process should stay alive.
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Wait for `work`, but no longer than `budgetMs`.
 *
 * Resolves to the value when the work finishes in time and `undefined` when the
 * budget runs out. The work is never cancelled - a plugin pass must finish what
 * it started - so the caller's job is to answer on time and let the late result
 * land in whatever cache the panel reads next.
 */
async function settleWithin(work, budgetMs) {
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try to bind one specific port once.
 *
 * Resolves the port on success and 0 on failure, so the caller can decide
 * whether to wait and try again instead of moving on immediately.
 */
function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      try {
        server.close();
      } catch {
        /* already gone */
      }
      resolve(0);
    });
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Ask the OS for the gateway's one preferred port.
 *
 * A port busy for a quarter of a second is the previous instance shutting
 * down. Giving up on the first refusal made a run bind an ephemeral port while
 * the declaration kept naming this one, leaving the host on an address nothing
 * listens on.
 *
 * Resolves 0 when the port stays taken. The shim then uses an ephemeral port
 * for this session, and the declaration still names the preferred port.
 */
function reservePort(port) {
  if (typeof port !== "number" || port <= 0) return Promise.resolve(0);
  return (async () => {
    for (let attempt = 0; attempt < PORT_RESERVE_ATTEMPTS; attempt += 1) {
      const bound = await tryPort(port);
      if (bound !== 0) return bound;
      if (attempt < PORT_RESERVE_ATTEMPTS - 1) await delay(PORT_RESERVE_INTERVAL_MS);
    }
    return 0;
  })();
}

// -------------------------------------------------------------- declaration

/** Thinking levels the picker may offer for one model, in host order. */
function thinkingLevelsFor(model) {
  const declared = Array.isArray(model.supportedEfforts)
    ? model.supportedEfforts.filter((level) => HOST_THINKING_LEVELS.includes(level))
    : [];
  if (declared.length === 0) return ["off"];
  // Only a declared set is a choice; "off" is offered only when the upstream
  // says thinking can be switched off. Otherwise the lowest declared level is
  // the floor and an invented "off" would promise a control that does nothing.
  const wanted = model.canDisableThinking === true ? ["off", ...declared] : declared;
  return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}
/**
 * Whether a level list is worth publishing.
 *
 * One real level is still a choice and keeps the model a reasoning one; a lone
 * "off" only says the model cannot think, which the host already reads from an
 * absent level list.
 */
function offersThinking(levels) {
  return levels.some((level) => level !== "off");
}

/** Model label as the picker shows it: name plus the upstream cost suffix. */
function modelDisplayName(model) {
  const label = model.name || model.id;
  if (typeof model.multiplier !== "number" || !Number.isFinite(model.multiplier)) return label;
  return label + " · x" + model.multiplier.toFixed(2);
}

/**
 * The label the picker shows.
 *
 * An alias the user typed is used verbatim: it is a name, not a catalog row, so
 * appending a cost suffix to it would edit the user's own text back. Without an
 * alias the catalog name keeps its suffix, which is the existing behaviour. The
 * one exception is not this function's: a name two account pools both publish
 * gains its region in `disambiguateModelLabels`, because the chip beside the
 * composer has nothing else to tell the two pools apart.
 */
function modelLabel(model) {
  const alias = typeof model.alias === "string" ? model.alias.trim() : "";
  return alias === "" ? modelDisplayName(model) : alias;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  // Clamped to the ceiling the host's own validator enforces: a catalog figure
  // of 1e20 was rounded and published verbatim into the manifest.
  return Math.min(MAX_TOKEN_BUDGET, Math.round(number));
}

/** The models one gateway publishes, after the user's selection is applied. */
function declarationModels(region) {
  const catalog = runtimes.get(region)?.catalog;
  if (!catalog) return [];
  const models = [];
  const seen = new Set();
  for (const model of catalog.visible()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const thinkingLevels = thinkingLevelsFor(model);
    const entry = {
      id,
      name: modelLabel(model),
      contextWindow: positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
      maxTokens: positiveInteger(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
      supportsImages: model.supportsImages === true,
      ...offersThinking(thinkingLevels) ? { thinkingLevels } : {},
    };
    // A default that is not one of the offered levels is dropped rather than
    // published: the host stores it verbatim and the picker would then open on
    // a level it does not list.
    if (typeof model.defaultThinkingLevel === "string"
      && thinkingLevels.includes(model.defaultThinkingLevel)) {
      entry.defaultThinkingLevel = model.defaultThinkingLevel;
    }
    models.push(entry);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/**
 * The tag a pool's models carry when two of them publish one name.
 *
 * Derived from the source and region rather than the provider id, so the entry
 * that builds the label and the entry that reads it back compute the same text
 * from the only two facts they share.
 */
function modelTag(source, region) {
  if (source === "trae") return region === "ai" ? "Trae Global" : "Trae CN";
  if (source === "qoder") return region === "global" ? "Qoder Global" : "Qoder CN";
  return region === "global" ? "Global" : "CN";
}

/**
 * One published name with this row's own region tag removed.
 *
 * The declaration is written from two halves: the rosters this run read (whose
 * names are plain) and the rows kept for a warming gateway (whose names already
 * carry the tag from an earlier write). Stripping the tag before counting makes
 * the pass idempotent: run on its own output it returns the same labels, so a
 * pass that changed nothing compares equal and does not rewrite the manifest.
 * Only this row's own tag is removed, and only in the two shapes this pass
 * produces, so a name that happens to end in parentheses keeps it.
 */
function stripModelTag(name, tag) {
  if (tag === "" || !name.endsWith(")")) return name;
  const head = name.lastIndexOf(" (" + tag);
  if (head <= 0) return name;
  const tail = name.slice(head + tag.length + 2);
  return tail === ")" || /^ · [^()]*\)$/.test(tail) ? name.slice(0, head).trim() : name;
}

/**
 * Make every published model label unique across the whole declaration.
 *
 * Two WorkBuddy regions publish one catalog, so the same name reaches the host
 * twice. The host keys a model by provider and id and is happy with that, but
 * the chip beside the composer prints the alias and nothing else, so a repeated
 * name there cannot be traced back to one account pool.
 *
 * Only the names that actually collide are tagged, so a model one pool serves
 * alone keeps its text. Every spelling of a colliding name is tagged rather than
 * only the later ones: an untagged text would otherwise name the first pool by
 * position alone, and a chip the host had not re-imported yet would answer with
 * that pool's balance while another one is selected. Tagged on both sides, an
 * ambiguous name answers nothing, which is the rule this readout follows.
 */
function disambiguateModelLabels(providers) {
  const keyOf = (label) => String(label ?? "").trim().toLowerCase();
  const flat = [];
  providers.forEach((provider, providerIndex) => {
    const route = routeOfProviderId(provider.id);
    const tag = route === undefined ? "" : modelTag(route.source, route.region);
    (provider.models || []).forEach((model, modelIndex) => {
      const raw = String(model.name || model.id || "").trim();
      flat.push({
        providerIndex,
        modelIndex,
        tag,
        id: String(model.id || "").trim(),
        base: stripModelTag(raw, tag),
        label: "",
      });
    });
  });
  const countOf = (labels) => {
    const counts = new Map();
    for (const label of labels) counts.set(keyOf(label), (counts.get(keyOf(label)) ?? 0) + 1);
    return counts;
  };
  const baseCounts = countOf(flat.map((row) => row.base));
  for (const row of flat) {
    row.label = baseCounts.get(keyOf(row.base)) > 1 && row.tag !== ""
      ? row.base + " (" + row.tag + ")"
      : row.base;
  }
  // One provider that published the same name twice is still ambiguous here,
  // and the model id is the only thing left that separates those rows.
  const taggedCounts = countOf(flat.map((row) => row.label));
  for (const row of flat) {
    if (taggedCounts.get(keyOf(row.label)) <= 1) continue;
    const detail = row.tag === "" ? row.id : row.tag + " · " + row.id;
    row.label = row.base + " (" + detail + ")";
  }
  const out = providers.map((provider) => ({ ...provider, models: [...(provider.models || [])] }));
  for (const row of flat) {
    const models = out[row.providerIndex].models;
    // The alias is what the host's model chip prints, so the label has to travel
    // there too: with only `name` tagged, a shared name's chip falls back to the
    // model id and the credit readout has nothing to look up.
    models[row.modelIndex] = { ...models[row.modelIndex], name: row.label, alias: row.label };
  }
  return out;
}

/**
 * One provider declaration, as the manifest carries it.
 *
 * The base URL is the gateway's PREFERRED port, never the port this run
 * happened to bind. The host reads the manifest before the plugin process
 * starts, so a declaration that echoed the live binding would be one run
 * stale: after a fallback run it would publish a spare port, and the host
 * keeps that address until something makes it re-read the manifest. Naming
 * the preferred port keeps the declaration describing the next run, which is
 * the only run the host can act on. `statusDocument` reports the mismatch
 * loudly when a run really did end up elsewhere.
 */
function descriptorFor(region) {
  const runtime = runtimes.get(region);
  const preferred = preferredPort(region);
  const baseUrl = preferred > 0
    ? "http://127.0.0.1:" + preferred + "/v1"
    : runtime?.baseUrl || PLACEHOLDER_BASE_URL;
  return {
    id: PROVIDER_ID_BY_REGION[region],
    name: PROVIDER_NAME_BY_REGION[region],
    baseUrl,
    apiStyle: "chat_completions",
    authKind: "none",
    models: declarationModels(region),
  };
}


/**
 * One value as JSON with every object's keys in sorted order.
 *
 * `JSON.stringify` on its own is a byte comparison: two declarations that mean
 * the same thing but list their keys in a different order - one written by an
 * earlier version of this plugin, or reformatted by any external tool - read as
 * changed, so `manifest.json` was rewritten on every pass and the panel footer
 * claimed "the model list was just updated" forever. Sorting the keys first
 * compares what the declaration says rather than how it is spelled.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Write the current provider declaration into this plugin's own manifest.
 *
 * The host reads `contributes.providers` from the package manifest when the
 * plugin loads, and that is the only way a plugin can put a provider into the
 * model list. This is a local edit inside the plugin's own package; nothing
 * outside it is touched, and it only happens when the declaration changed.
 */
function writeDeclaration(provided) {
  if (packageRoot === "") return { ok: false, error: "the plugin package path is unknown" };
  // The labels reach the host from here and nowhere else, so this is the one
  // place a collision between two regions' catalogs can be settled.
  const descriptors = disambiguateModelLabels(provided);
  const manifestPath = path.join(packageRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    // No fs text: a read failure quotes the absolute install path, and the
    // report is copyable from the panel. The errno code is the actionable half.
    return { ok: false, error: "manifest.json could not be read (" + errorCodeOf(error) + ")" };
  }
  const previous = canonicalJson((manifest.contributes && manifest.contributes.providers) || []);
  const next = canonicalJson(descriptors);
  if (previous === next) return { ok: true, changed: false, providerCount: descriptors.length };
  manifest.contributes = manifest.contributes || {};
  manifest.contributes.providers = descriptors;
  const temporary = manifestPath + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* nothing to clean up */
    }
    return { ok: false, error: "manifest.json could not be written (" + errorCodeOf(error) + ")" };
  }
  // The copy just written is the truth now, so the next read is served from it
  // rather than from the disk this rename only just finished.
  manifestCache = manifest;
  return { ok: true, changed: true, providerCount: descriptors.length };
}

/**
 * Result of the last declaration write, for the panel footer.
 *
 * Starts as not-ok because nothing has been written yet: `ok: true` here read as
 * "the last write succeeded" before any write had been attempted, so a cold load
 * whose first pass failed showed the footer as up to date. The reason travels
 * with it, because a disabled plugin never writes at all and the panel and
 * doctor print the message verbatim - without it the report said "undefined".
 */
const runtimeState = { write: { ok: false, changed: false, error: "the declaration has not been published yet" } };

/**
 * Cache for the auxiliary per-account probes (credits, check-in).
 *
 * Keyed by account id. A panel open reads this cache and schedules the upstream
 * calls behind it, instead of blocking the first paint on 2 calls per account.
 */
const probeCache = new Map();

/**
 * Publish every gateway that is actually usable.
 *
 * The host rejects a provider declaration with an empty model list AND rejects
 * the whole manifest with it, which would take the plugin down. A gateway that
 * is signed out, unreachable or still starting is therefore left out; the host
 * removes the provider row of a plugin that no longer declares it, which is
 * also how a signed-out edition disappears from the picker.
 */
function syncDeclaration() {
  const publishable = activeRegions().filter((region) => {
    const runtime = runtimes.get(region);
    return runtime && runtime.signedIn && declarationModels(region).length > 0;
  });
  // Trae publishes on the same terms: only with the switch on, only once its
  // directory has answered, and never with an empty model list.
  const publishableTrae = activeTraeRegions().filter((region) => traeDeclarationModels(region).length > 0);
  // Qoder publishes on the same terms: only with the switch on, only once its
  // directory has answered, and never with an empty model list.
  const publishableQoder = activeQoderRegions().filter((region) => qoderDeclarationModels(region).length > 0);
  const anyActive = activeRegions().length > 0 || activeTraeRegions().length > 0 || activeQoderRegions().length > 0;
  // A deliberate switch-off must erase the declaration: leaving a provider row
  // for a source the user disabled would keep serving nothing from that row.
  if (!anyActive) {
    const result = writeDeclaration([]);
    runtimeState.write = result.ok
      ? { ...result, skipped: "every source is switched off; the declaration is cleared" }
      : result;
    return runtimeState.write;
  }
  const activeIds = new Set([
    ...activeRegions().map((region) => PROVIDER_ID_BY_REGION[region]),
    ...activeTraeRegions().map((region) => TRAE_PROVIDER_ID_BY_REGION[region]),
    ...activeQoderRegions().map((region) => QODER_PROVIDER_ID_BY_REGION[region]),
  ]);
  const current = [
    ...publishable.map(descriptorFor),
    ...publishableTrae.map(descriptorForTrae),
    ...publishableQoder.map(descriptorForQoder),
  ];
  const currentIds = new Set(current.map((provider) => provider.id));
  // One warming gateway must not lose its saved roster when a sibling connects.
  // Retention is scoped to that case alone: a gateway whose runtime exists and
  // has answered is definitively signed out or unreachable, and keeping its row
  // published a stale model list for as long as the source stayed switched on -
  // which is what the rule above says must not happen.
  const warming = warmingGatewayIds();
  const retained = manifestProviders().filter((provider) => activeIds.has(provider.id)
    && !currentIds.has(provider.id)
    && warming.has(provider.id));
  const result = writeDeclaration([...current, ...retained]);
  runtimeState.write = result;
  return result;
}

/**
 * The provider ids of the active gateways that are still warming up.
 *
 * "Warming" is the only reason a row is republished for a gateway that cannot
 * publish right now: its roster has not landed yet, so dropping the row would
 * cost a roster it already had. A gateway that has answered is signed out or
 * unreachable, and the rule on {@link syncDeclaration} says its row goes - and
 * so does one whose start failed, which used to read as warming forever.
 */
function warmingGatewayIds() {
  const ids = new Set();
  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    // No runtime yet, or one mid-connect: the roster is still on its way. A
    // region whose start failed is not on its way - it is not coming.
    if (gatewayStartFailures.has(region)) continue;
    if (runtime === undefined || runtime.connecting !== null) ids.add(PROVIDER_ID_BY_REGION[region]);
  }
  for (const [source, gateways, regions, idByRegion] of [
    ["trae", traeGateways, activeTraeRegions(), TRAE_PROVIDER_ID_BY_REGION],
    ["qoder", qoderGateways, activeQoderRegions(), QODER_PROVIDER_ID_BY_REGION],
  ]) {
    for (const region of regions) {
      // A region whose start failed is not on its way, exactly as above.
      if (sourceStartFailures.has(sourceKey(source, region))) continue;
      const entry = gateways.get(region);
      // No gateway yet, or one whose directory read has neither answered nor
      // failed: both are a roster still in flight.
      if (entry === undefined || (entry.gateway.models().length === 0 && entry.lastError === "")) {
        ids.add(idByRegion[region]);
      }
    }
  }
  return ids;
}

/**
 * Ask one Trae/Qoder gateway for its directory once, and record what it said.
 *
 * The message is overwritten either way round: a directory that failed while
 * load was still opening the other gateways and answers a minute later must
 * not keep reporting the first failure for the rest of the process. That is
 * what WorkBuddy's `connect` also does, by clearing before every attempt.
 */
async function warmSourceDirectory(entry, signal) {
  if (signal && signal.aborted) return false;
  // The timeout is not optional: folded into the composite signal it would be
  // dropped for a caller that passes no lifecycle signal — the user-invoked
  // refresh — leaving that path bounded only by the outer pass budget. So it
  // always applies, and the lifecycle signal is added on top when there is one.
  const bounds = [AbortSignal.timeout(DIRECTORY_WARM_TIMEOUT_MS)];
  if (signal) bounds.push(signal);
  try {
    const warm = await fetch(entry.baseUrl + "/v1/models", {
      signal: bounds.length === 1 ? bounds[0] : AbortSignal.any(bounds),
    });
    entry.lastError = warm.ok ? "" : "directory answered HTTP " + warm.status;
  } catch (error) {
    if (signal && signal.aborted) return false;
    // A read this pass gave up on is not a directory that failed: the gateway
    // is still holding a roster, or still fetching one, and a message the user
    // cannot act on is worse than no message.
    entry.lastError = entry.gateway.models().length > 0 ? "" : "directory unavailable: " + safeMessage(error);
    if (entry.lastError !== "") log("warn", "[" + entry.source + ":" + entry.region + "] " + entry.lastError);
  }
  // A roster that lands after the load-time publish would otherwise leave its
  // provider row missing until some later pass happened to refresh: the group
  // reads as having disappeared across a restart. Publishing here is what makes
  // the row appear as soon as the directory really answered; a write that changes
  // nothing is a no-op.
  if (entry.lastError === "" && entry.gateway.models().length > 0) syncDeclaration();
  return entry.lastError === "";
}

/**
 * How long one directory read may take before a refresh pass gives up on it.
 *
 * The Trae directory walks several upstream endpoints behind the gateway's
 * `/v1/models`, and a gateway whose read has not been bounded leaves every
 * user-invoked refresh waiting on it. This is the ceiling on that wait, not on
 * the read itself: a gateway that stops here keeps fetching and every later
 * refresh sees the roster it lands with.
 */
const DIRECTORY_WARM_TIMEOUT_MS = 8000;

/** Startup warm-up attempts and the gap between them, for a cold machine. */
const DIRECTORY_WARM_ATTEMPTS = 3;
const DIRECTORY_WARM_BACKOFF_MS = 1500;

/**
 * Aborted on unload, and re-created on the next load.
 *
 * The startup warm-up runs detached — it must not hold up the host's answer —
 * so nothing else owns its lifetime. Left alone it outlives the plugin: up to
 * three 8 s attempts plus backoff kept fetching a gateway that had already been
 * closed, and wrote `lastError` onto an entry no map held any more, which is how
 * the next load's log picked up warnings about a run that had just ended.
 */
let warmAbort = new AbortController();

/** Stop every warm-up still in flight. Called from `onUnload`. */
function abortWarmups() {
  warmAbort.abort();
}

/**
 * Warm one gateway's directory, retrying while a startup burst can be blamed.
 *
 * The first attempt runs while load is still reading every other source's
 * storage and opening its sockets, so one failure is not taken as the answer.
 * Whatever survives the retries stays on the entry until a later refresh
 * clears it.
 */
async function warmSourceDirectoryAtStartup(entry, signal) {
  for (let attempt = 1; attempt <= DIRECTORY_WARM_ATTEMPTS; attempt += 1) {
    if (signal && signal.aborted) return false;
    if (await warmSourceDirectory(entry, signal)) return true;
    if (attempt >= DIRECTORY_WARM_ATTEMPTS) break;
    // The pause is part of the chain an abort has to stop, so it races the signal
    // instead of sitting out its full gap after unload. The listener is removed
    // when the pause ends normally: an abort that never comes would otherwise
    // leave one behind per attempt on a signal the plugin keeps for its life.
    if (!signal) {
      await delay(DIRECTORY_WARM_BACKOFF_MS * attempt);
      continue;
    }
    await checkinPause(DIRECTORY_WARM_BACKOFF_MS * attempt, signal);
  }
  return false;
}

// ------------------------------------------------------------------ runtime

/**
 * Everything that separates Trae's gateways from Qoder's.
 *
 * Both sources run the same shape of gateway - one loopback endpoint per
 * region, a directory read warmed behind it, a declaration published from its
 * roster - and differ only in which table or reader answers a question. Those
 * answers are collected here so one implementation serves both: a change to how
 * a gateway starts, or to what it publishes, is made once instead of twice.
 */
const SOURCE_SPECS = {
  trae: {
    ports: TRAE_PORTS,
    providerIds: TRAE_PROVIDER_ID_BY_REGION,
    providerNames: TRAE_PROVIDER_NAME_BY_REGION,
    gateways: traeGateways,
    activeRegions: activeTraeRegions,
    createGateway: createTraeGateway,
    declarationModels: traeDeclarationModels,
    nativeOf: traeNativeOf,
    /** The user's alias, else the catalog name with its cost suffix - Trae's directory states a rate. */
    labelOf: modelLabel,
    /** This region's sign-ins, in the order the panel's account pick and usage mode ask for. */
    orderCredentials: async (region, rotate) => orderSourceCredentials(
      "trae",
      region,
      (await discoverTraeCredentials()).credentials.filter((credential) => traeRegionOfCredential(credential) === region),
      traeRowLabel,
      rotate,
    ),
    /** Request identity is read from the machine's own Trae installs. */
    storageCandidates: () => traeStorageCandidates().filter((entry) => entry.source === "desktop"),
    /** The gateway holds raw credentials, so the label is the row's own. */
    failureLabel: traeRowLabel,
  },
  qoder: {
    ports: QODER_PORTS,
    providerIds: QODER_PROVIDER_ID_BY_REGION,
    providerNames: QODER_PROVIDER_NAME_BY_REGION,
    gateways: qoderGateways,
    activeRegions: activeQoderRegions,
    createGateway: createQoderGateway,
    declarationModels: qoderDeclarationModels,
    nativeOf: qoderNativeOf,
    /** No cost suffix: Qoder's directory publishes no rate. */
    labelOf: (view) => view.name,
    /** This region's sign-ins, in the order the panel's account pick and usage mode ask for. */
    orderCredentials: async (region, rotate) => orderSourceCredentials(
      "qoder",
      region,
      (await discoverQoderCredentials()).credentials.filter((credential) => credential.region === region),
      qoderRowLabel,
      rotate,
    ).map(qoderClientCredential),
    /** The gateway holds mapped credentials, so the label is rebuilt the way `qoderRowLabel` builds it. */
    failureLabel: (credential) => typeof credential.name === "string" && credential.name !== ""
      ? credential.name
      : credential.userID,
  },
};

/**
 * Create one gateway's runtime: its own loopback endpoint and its own directory.
 *
 * Each gateway is scoped to its own account slice of the pool, so a CN request
 * can never be served by a global account and vice versa - the two gateways are
 * not interchangeable - and a failing gateway cannot take the other one down.
 *
 * Credentials and identity come from the machine's own installs, read per
 * request rather than cached here, so switching the source off really does stop
 * the scanning. The directory is warmed through the gateway's own `/v1/models`
 * route right after start: until it answers there is no model list, and a
 * gateway with no models is simply not published.
 */
async function createSourceRuntime(source, region) {
  const spec = SOURCE_SPECS[source];
  const prefix = "[" + source + ":" + region + "] ";
  const preferred = spec.ports[region];
  // Reserved before the listener exists, for the same reason as WorkBuddy:
  // a run that can have the preferred port must have it, or the address in the
  // manifest would be describing a run that is not this one.
  const bound = await reservePort(preferred);
  // The candidate list is a directory scan, so it is read once per runtime
  // rather than once per credential: a request that walks five sign-ins would
  // otherwise pay for it five times.
  const desktopCandidates = spec.storageCandidates?.();
  const gateway = spec.createGateway({
    // Qoder's gateway scopes its upstream client by region; Trae's takes the
    // same option and ignores it.
    region,
    // Only this region's sign-ins: the two gateways are not interchangeable, so
    // a CN request must never be answered by an international token.
    credentials: async (purpose) => spec.orderCredentials(region, purpose === "chat"),
    // Qoder's gateway signs its own requests, so it is told nothing here.
    ...desktopCandidates === undefined ? {} : {
      identity: (credential) => resolveTraeIdentity(desktopCandidates, credential.edition),
    },
    listedIds: () => spec.declarationModels(region).map((model) => model.id),
    // The window the HOST is holding for this model, not the one this process has
    // just written. Max mode is billed on the larger tier's terms, so asking for it
    // has to match what the host actually sized a budget for: keying it on the live
    // directory opened it the moment a save was written (the host reads the manifest
    // only at its next launch) and shut it again whenever a directory function
    // happened to fail. See `captureHostWindows`.
    publishedWindowOf: (modelId) => hostWindowOf(spec.providerIds[region], modelId),
    onAttemptFailure: (credential, outcome) => {
      noteSourceFailure(source, region, spec.failureLabel(credential), outcome.retryAfter);
    },
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine(prefix, args)),
      warn: (...args) => log("warn", gatewayLogLine(prefix, args)),
      error: (...args) => log("error", gatewayLogLine(prefix, args)),
    },
  });
  await gateway.ready;
  const entry = { region, gateway, baseUrl: gateway.baseUrl(), portFallback: bound !== preferred, preferredPort: preferred, lastError: "", source };
  // The same report WorkBuddy's runtime gives for its own fallback: a silent one
  // left the panel's address-drift row as the only hint that the published port
  // was not the one being served.
  if (entry.portFallback) {
    log("warn", prefix + "preferred port " + preferred + " is held by another process; " +
      "serving this session on port " + gateway.port());
  }
  // Never let the directory read hold up init: the host gives the plugin only
  // seconds to answer it, and a slow or failing directory must not spend that
  // budget. The gateway is listening by now, so the roster lands behind the
  // answer - the message above reports a failure while one lasts, and every
  // refresh asks again.
  // A rejection here would be an unhandled one in the plugin's own process,
  // which is how a plugin dies; the warm-up itself never throws, and this keeps
  // a future edit from turning it into one.
  warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", prefix + "directory warm-up failed: " + safeMessage(error)));
  return entry;
}

/** Start and stop one source's gateways so its map matches the source switch exactly. */
async function reconcileSourceGateways(source) {
  const spec = SOURCE_SPECS[source];
  const generation = loadGeneration;
  if (!stillLoaded(generation)) return;
  const active = spec.activeRegions();
  for (const [region, entry] of Array.from(spec.gateways)) {
    if (active.includes(region)) continue;
    spec.gateways.delete(region);
    sourceStartFailures.delete(sourceKey(source, region));
    try {
      await entry.gateway.close();
    } catch (error) {
      log("warn", "[" + source + ":" + region + "] gateway did not close cleanly: " + safeMessage(error));
    }
  }
  for (const region of active) {
    // A stopped service, a source switch flipped off while the directory read
    // was awaited, or a gateway another pass already installed: the entry this
    // call just created would otherwise keep the port bound with nobody left to
    // close it. Same resolution as `startRuntimes`.
    if (serviceStopped || !regionEnabled(source, region) || spec.gateways.has(region)) continue;
    try {
      const entry = await createSourceRuntime(source, region);
      if (!stillLoaded(generation) || !regionEnabled(source, region) || spec.gateways.has(region)) {
        await entry.gateway.close();
      } else {
        spec.gateways.set(region, entry);
        sourceStartFailures.delete(sourceKey(source, region));
      }
    } catch (error) {
      // Recorded before the log line, so nothing downstream has to read the log
      // to tell a failed start from one that has not finished. See
      // `sourceStartFailures`.
      sourceStartFailures.set(sourceKey(source, region), safeMessage(error));
      log("warn", "[" + source + ":" + region + "] gateway could not start: " + safeMessage(error));
    }
  }
}

/** Start and stop Trae gateways so the map matches the source switch exactly. */
async function reconcileTraeGateways() {
  await reconcileSourceGateways("trae");
}

/** Start and stop Qoder gateways so the map matches the source switch exactly. */
async function reconcileQoderGateways() {
  await reconcileSourceGateways("qoder");
}

/** What a Trae gateway itself reported for one model. */
function traeNativeOf(model) {
  const devWindow = positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW);
  // The larger window the same model accepts with Max mode on. Trae sells Max as
  // a separate tier: the row states both, and the default is not the ceiling.
  const maxWindow = positiveInteger(model.maxContextWindow, 0);
  const ceiling = Math.max(devWindow, maxWindow);
  return {
    contextWindow: devWindow,
    maxTokens: positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS),
    // The highest window this model accepts, so the panel's ceiling is the model's
    // real room rather than the default tier's.
    ...maxWindow > devWindow ? { maxContextWindow: maxWindow } : {},
    // The same model states a smaller output budget through the function that
    // serves its Max tier, so the budget follows the window in force: keeping the
    // default gets the wider budget, reaching for Max gets that function's own.
    ...maxWindow > devWindow
      ? { maxTokensAtCeiling: positiveInteger(traeVariantFor(model, ceiling)?.maxTokens, positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS)) }
      : {},
    // The directory's own vision flag. An OpenAI image content block goes
    // through this gateway untouched (`prepareSoloBody` keeps the message list,
    // only turning a string into a text block), and a live request with a solid
    // red PNG came back naming the colour - so the flag is published as the
    // directory states it rather than guessed from a model name. A row that
    // states nothing stays false.
    supportsImages: model.supportsImages === true,
    // The levels this model advertises, in the host's own names, so the panel's
    // editor can offer the control and a stored override has something to edit.
    thinkingLevels: (model.reasoning ? model.reasoning.supported : [])
      .filter((level) => HOST_THINKING_LEVELS.includes(level)),
    // The directory's own effective (post-discount) rate, the same figure the
    // IDE prints beside a model. A row that states none stays unlabelled rather
    // than being given a guessed cost, so this is spread rather than defaulted.
    ...Number.isFinite(model.creditMultiplier) ? { multiplier: model.creditMultiplier } : {},
  };
}

/** The models one source's gateway publishes, after its directory has been read. */
function sourceDeclarationModels(source, region) {
  const spec = SOURCE_SPECS[source];
  const key = source + ":" + region;
  const gateway = spec.gateways.get(region)?.gateway;
  if (!gateway) return [];
  const models = [];
  const seen = new Set();
  const roster = gateway.models().map((model) => String(model.id || "").trim());
  const enabled = gatewayEnabledIds(key, roster);
  for (const model of gateway.models()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    if (enabled !== null && !enabled.has(id)) continue;
    seen.add(id);
    // The stored per-model edits apply here, exactly as they do for WorkBuddy:
    // the panel edits a model and this is what the provider row then declares.
    const native = spec.nativeOf(model);
    const view = sourceModelView(key, model, native);
    // The directory is the IDE's slot table, so it is filtered on the same term
    // the panel's roster is — see `isSelectableSourceModel`.
    if (!isSelectableSourceModel(source, view)) continue;
    // The levels this model actually advertises. Without them the host opens
    // its whole ladder - including `max`, which Trae has no word for - and the
    // picker would offer choices SOLO ignores.
    const advertised = native.thinkingLevels;
    // The user's edit, when they made one: the panel saves it and the row then
    // shows "advanced", so a stored list that never reaches the declaration is
    // an edit that reads as saved and changes nothing.
    const edited = Array.isArray(view.thinkingLevels) && view.thinkingLevels.length > 0
      ? view.thinkingLevels.filter((level) => HOST_THINKING_LEVELS.includes(level))
      : [];
    const levels = edited.length > 0 ? HOST_THINKING_LEVELS.filter((level) => edited.includes(level)) : advertised;
    models.push({
      id: view.id,
      // Same label rule as WorkBuddy's declaration: the user's alias verbatim,
      // otherwise the catalog name - which keeps its cost suffix for a source
      // whose directory states a rate. See `labelOf`.
      name: spec.labelOf(view),
      contextWindow: view.contextWindow,
      maxTokens: view.maxOutputTokens,
      supportsImages: view.supportsImages,
      // An empty list is read by the host as "offer every level". A lone
      // "off" is how a model with no levels is kept off that ladder.
      thinkingLevels: offersThinking(levels) ? levels : ["off"],
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function traeDeclarationModels(region) {
  return sourceDeclarationModels("trae", region);
}

function qoderDeclarationModels(region) {
  return sourceDeclarationModels("qoder", region);
}

/** One source's provider declaration, same shape as {@link descriptorFor}. */
function descriptorForSource(source, region) {
  const spec = SOURCE_SPECS[source];
  const preferred = spec.ports[region];
  return {
    id: spec.providerIds[region],
    name: spec.providerNames[region],
    // The preferred port, never the one this run happened to bind - see the
    // same reasoning on `descriptorFor`.
    baseUrl: "http://127.0.0.1:" + preferred + "/v1",
    apiStyle: "chat_completions",
    authKind: "none",
    models: spec.declarationModels(region),
  };
}

/** One Trae provider declaration, same shape as {@link descriptorFor}. */
function descriptorForTrae(region) {
  return descriptorForSource("trae", region);
}

/** One Qoder provider declaration, same shape as {@link descriptorFor}. */
function descriptorForQoder(region) {
  return descriptorForSource("qoder", region);
}

/** One discovered Qoder sign-in, shaped as the client and gateway consume it. */
function qoderClientCredential(credential) {
  return {
    userID: credential.userID,
    token: credential.token,
    ...credential.name === "" ? {} : { name: credential.name },
    ...credential.email === "" ? {} : { email: credential.email },
    ...credential.machineID === undefined ? {} : { machineID: credential.machineID },
  };
}

function qoderNativeOf(model) {
  return {
    // The window the model runs at, not the input budget inside it: Qoder's
    // catalog publishes `context_config` with the sizes and marks the one in
    // force; `max_input_tokens` is a separate input budget.
    contextWindow: positiveInteger(model.contextWindow ?? model.maxInputTokens, CONSERVATIVE_CONTEXT_WINDOW),
    // The directory publishes no output limit anywhere — all eleven of its
    // groups carry the same keys and none of them is one — so this is the
    // plugin's own ceiling rather than the model's, and the panel's per-model
    // override is where a user sets the real one.
    maxTokens: DEFAULT_MAX_TOKENS,
    // The directory marks vision-capable models; anything else stays false
    // rather than guessing from the model name.
    supportsImages: model.supportsImages === true,
    // The levels this model advertises, in the host's own names, so the panel's
    // editor can offer the control and a stored override has something to edit.
    thinkingLevels: qoderThinkingLevelsFor(model),
  };
}

/**
 * Thinking levels one Qoder model may offer, in host order.
 *
 * Qoder's ladder spells "off" as "none", which the host does not use, so the
 * table is filtered to the host's own names first. A row whose catalog entry
 * carries no level table only takes thinking on or off, which the declaration
 * publishes as a lone "off" - an absent list would open the host's whole
 * ladder on a model that has no levels to offer.
 */
function qoderThinkingLevelsFor(model) {
  const declared = Array.isArray(model.effortLevels)
    ? model.effortLevels.filter((level) => HOST_THINKING_LEVELS.includes(level))
    : [];
  if (declared.length === 0) return [];
  const wanted = model.alwaysThinking === true ? declared : ["off", ...declared];
  return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}

async function createRuntime(region) {
  const runtime = {
    region,
    baseUrl: PLACEHOLDER_BASE_URL,
    catalog: new WorkBuddyCatalog(),
    signedIn: false,
    // Retired once `stopRuntime` has closed it; declared here so every reader sees
    // the field rather than reading `undefined` until the first close.
    stopped: false,
    lastError: "",
    lastWarning: "",
    portFallback: false,
    connecting: null,
    catalogFetchedAtMs: 0,
  };
  applyEffectiveSelection(region, runtime);
  // The preferred port is reserved before the listener is created, so a run
  // that can have it does have it - which is what keeps the address in the
  // manifest true.
  const preferred = preferredPort(region);
  const bound = await reservePort(preferred);
  // A port of 0 hands the shim an ephemeral port: the gateway still works this
  // session, but it is no longer the address the manifest names, so the state
  // is recorded rather than hidden.
  runtime.portFallback = bound === 0;
  if (runtime.portFallback) {
    log("warn", "[" + region + "] preferred port " + preferred + " is held by another process; " +
      "serving this session on an ephemeral port");
  }
  runtime.shim = createWorkBuddyShim({
    pool: core.pool,
    client: core.client,
    catalog: runtime.catalog,
    listedIds: () => declarationModels(region).map((model) => model.id),
    region,
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine("[" + region + "] ", args)),
      warn: (...args) => log("warn", gatewayLogLine("[" + region + "] ", args)),
      error: (...args) => log("error", gatewayLogLine("[" + region + "] ", args)),
    },
  });
  await runtime.shim.ready;
  runtime.baseUrl = runtime.shim.baseUrl() + "/v1";
  return runtime;
}

/**
 * Start every active WorkBuddy gateway that is not running yet.
 *
 * One gateway's failure is logged and left out, on the same terms as the Trae
 * and Qoder reconciles: the shim's `listen` can lose the port race that
 * `reservePort` opened between reserving and binding, and that must not take the
 * whole plugin down - the other region still has a roster to publish, and a
 * plugin that fails to load publishes nothing at all. Read end to end the two
 * regions cost one bound rather than two, which is why the reads run together.
 */
async function startRuntimes() {
  const generation = loadGeneration;
  if (!stillLoaded(generation)) return;
  // Gateways a settings change retired may still be closing; their ports are
  // only reusable once those closes settle. See `pendingRuntimeStops`.
  if (pendingRuntimeStops.length > 0) await Promise.all(pendingRuntimeStops.splice(0));
  await Promise.all(activeRegions().map(async (region) => {
    if (runtimes.has(region)) return;
    try {
      const runtime = await startRuntimeOnce(region);
      await settleStartedRuntime(region, runtime, !stillLoaded(generation) || !activeRegions().includes(region));
    } catch (error) {
      gatewayStartFailures.set(region, safeMessage(error));
      log("warn", "[workbuddy:" + region + "] gateway could not start: " + safeMessage(error));
    }
  }));
}

/**
 * One bind per region, whoever asks first.
 *
 * A rescan and the refresh pass can both reach a region with no runtime at the
 * same moment. Each used to reserve the preferred port and bind its own shim,
 * so one of them lost the bind and recorded a start failure for a region that
 * was actually serving; the panel then showed address drift over a healthy
 * gateway. Sharing the in-flight promise makes the second caller the first
 * one's answer.
 */
function startRuntimeOnce(region) {
  const existing = runtimeStarts.get(region);
  if (existing !== undefined) return existing;
  // Deleted by identity: a teardown clears the whole map, so by the time this
  // one settles a newer activation's start may be the entry here, and removing
  // that would let a third caller bind the same region a second time.
  const started = createRuntime(region).finally(() => {
    if (runtimeStarts.get(region) === started) runtimeStarts.delete(region);
  });
  runtimeStarts.set(region, started);
  return started;
}

/**
 * Take ownership of a runtime that has finished binding, or release it.
 *
 * Both callers of `startRuntimeOnce` land here with the same object, so
 * "somebody already put a runtime in the map" cannot be read as "mine is not
 * wanted": the other caller's entry is this very runtime. Releasing on that
 * reading closed a gateway that was serving and left a stopped object in the map
 * no later pass would rebuild.
 *
 * `unwanted` covers the reasons nobody is waiting for a gateway at all: the
 * activation it was started for is gone, the service stopped, or the region was
 * switched off while the shim was binding.
 *
 * A runtime already in the map outranks both: a reload reuses the gateways rather
 * than closing them, so a bind that an older activation started can be registered
 * by the newer activation's caller; the older caller then arrives with its own
 * generation already stale, and `held === runtime` is what stops it closing what is
 * now serving. `runtimes.has` is every later pass's only re-entry test, so a
 * stopped entry there would take the region out until the next teardown.
 */
async function settleStartedRuntime(region, runtime, unwanted) {
  const held = runtimes.get(region);
  if (held === runtime) return true;
  // A runtime that another caller already released is not adopted, whoever asks:
  // that caller's activation had ended, so the map has to stay empty for a later
  // pass to rebuild from.
  if (runtime.stopped === true) return false;
  // Both remaining releases close the gateway and leave the map alone, so they are
  // one branch: `unwanted` says nobody is waiting for it, and `held` says another
  // runtime already serves the region. Neither can keep it.
  if (unwanted || held !== undefined) {
    await stopRuntime(runtime);
    return false;
  }
  runtimes.set(region, runtime);
  gatewayStartFailures.delete(region);
  return true;
}

async function stopRuntime(runtime) {
  // Idempotent, because one release path can outlive another: a refresh pass that
  // gave up waiting registers an observer for the same bind a second caller may
  // have just released, and closing a closed shim depends on internals of `net`
  // rather than on anything this file states.
  if (runtime.stopped === true) return;
  runtime.stopped = true;
  runtime.signedIn = false;
  // The next start for this region begins from a clean slate: a failure left
  // recorded here would keep a gateway that is being closed on purpose out of
  // the "still warming" set the whole time it is down.
  gatewayStartFailures.delete(runtime.region);
  if (runtime.shim) await runtime.shim.close().catch((error) => {
    log("warn", "[workbuddy:" + runtime.region + "] gateway did not close cleanly: " + safeMessage(error));
  });
}

/**
 * Come back for a roster that could not be read.
 *
 * Retries are cheap: a gateway with no account answers without a request, and
 * one whose read succeeded skips it on the freshness check.
 *
 * The handles are tracked so a stop or an unload can clear them: a retry that
 * outlived its activation fired into the next one and triggered a full refresh
 * pass nobody asked for.
 */
const modelRetryTimers = new Set();
function scheduleModelRetries(attempt = 1) {
  if (serviceStopped) return;
  const timer = setTimeout(() => {
    modelRetryTimers.delete(timer);
    scheduleRefresh("model-list-retry");
    if (attempt < MODEL_RETRY_ATTEMPTS) scheduleModelRetries(attempt + 1);
  }, CATALOG_RETRY_MS);
  if (typeof timer.unref === "function") timer.unref();
  modelRetryTimers.add(timer);
}

/** Drop every pending roster retry. */
function clearModelRetries() {
  for (const timer of modelRetryTimers) clearTimeout(timer);
  modelRetryTimers.clear();
}

/**
 * Bring one gateway online: seed its catalog from that gateway's own account.
 *
 * The catalog is per gateway because the two do not advertise the same roster;
 * seeding both from one account showed a CN list on the international
 * provider. A gateway with no account keeps its static fallback, which is what
 * keeps its model list non-empty (and therefore publishable) before any
 * upstream call succeeds.
 */
async function connect(runtime, force) {
  // Stopped before this call began: everything below writes shared state this
  // runtime no longer owns. The two guards after the await catch the same stop
  // landing while the model fetch was in flight.
  if (runtime.stopped) return false;
  runtime.lastError = "";
  runtime.lastWarning = "";
  const regionAccounts = core.pool.list(runtime.region);
  // The first account whose sign-in the upstream still accepts, not simply the
  // first on file: a refused sign-in reads the roster with a token the gateway
  // turns away, and the static fallback then stands in for a roster a healthy
  // account on the same gateway would have read. With every account refused the
  // first one still reads, so the failure names the sign-in rather than
  // reporting the region as unsigned.
  const account = regionAccounts.find((item) => core.pool.activeHold(item.id)?.reason !== "session") ?? regionAccounts[0];
  if (account === undefined) {
    runtime.signedIn = false;
    runtime.lastError = "no " + runtime.region + " WorkBuddy sign-in found";
    // A region with no sign-in yet is not the same as one that will never have
    // one: the load-time account scan can still be running, and parking the
    // gateway for the whole TTL here left it serving the static fallback - the
    // wrong model list - for half an hour after every slow start. Only a
    // finished scan may park it.
    if (core.pool.status().lastScanAtMs === 0) {
      runtime.catalogFetchedAtMs = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
      scheduleModelRetries();
      return false;
    }
    // Mark this gateway as settled even though nothing was fetched: a gateway
    // with no account can never become "fresh" on its own, and without this the
    // panel would poll to its attempt cap every time it opens for a pool that
    // is legitimately empty on one side.
    runtime.catalogFetchedAtMs = Date.now();
    return false;
  }
  runtime.signedIn = true;
  // Cached opens reuse the roster; a manual refresh still bypasses its TTL.
  if (force === true || !catalogFresh(runtime)) {
    try {
      const models = await core.pool.readAfterRefresh(account.id, (credential) =>
        core.client.fetchModels(
          credential,
          AbortSignal.timeout(MODELS_TIMEOUT_MS),
        ));
      // Stopped while the fetch was in flight: the runtime is held by no map
      // any more, so nothing here may claim a roster for it.
      if (runtime.stopped) return false;
      runtime.catalog.update(catalogFromUpstream(models));
      runtime.catalogFetchedAtMs = Date.now();
    } catch (error) {
      runtime.lastWarning = "model list failed: " + safeMessage(error);
      // Keep the previous roster (or the static fallback), but do not count a
      // failed read as a fresh one: stamping it fresh parked that fallback - and
      // with it the wrong model list, for the gateways and for the host's
      // picker - for the whole TTL after one slow start. The next attempt comes
      // on the retry clock instead.
      runtime.catalogFetchedAtMs = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
      scheduleModelRetries();
    }
  }
  if (runtime.stopped) return false;
  // Re-check the saved selection against the roster now in force: a re-read may
  // have retired ids it names, and a failure leaves the previous roster up.
  applyEffectiveSelection(runtime.region, runtime);
  return true;
}

/** True while one gateway's model roster is still inside its cache lifetime. */
function catalogFresh(runtime) {
  if (runtime.catalogFetchedAtMs === 0) return false;
  return Date.now() - runtime.catalogFetchedAtMs < CATALOG_TTL_MS;
}

/**
 * Whether the panel should come back for a refreshed document.
 *
 * True while a pass is running (its result has not been rendered yet) and while
 * anything it would fill in is missing or stale: a stale model roster, or
 * billing probes that are cold or past their TTL. Scheduling is de-duplicated
 * separately in `scheduleRefresh`, so reporting an in-flight pass here is safe
 * and is what keeps the poll alive until the numbers actually land.
 */
function refreshNeeded() {
  // A stopped service has nothing left to refresh, and the passes that would
  // have cleared this state are refused while it is stopped - so answering
  // "still detecting" here left the panel's header busy for good.
  if (serviceStopped) return false;
  if (refreshInflight !== null) return true;
  for (const runtime of runtimes.values()) {
    if (runtime.connecting) return true;
    if (!catalogFresh(runtime)) return true;
  }
  return probesStale() || cooldownPending();
}

/** True while any pool account's cached billing answers are missing or old. */
function probesStale() {
  const now = Date.now();
  for (const account of core.pool.list()) {
    // A cooling account is never probed (see statusDocument), so it can never
    // have a cache entry: counting it would keep every state call reporting a
    // detection pass in progress while the cooling lasts. A switched-off
    // account is skipped for the same reason, and counting it held the panel's
    // polling open for a row that never probes.
    if (account.cooldownUntilMs > now
      || core.pool.isDisabled(account.id)
      || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    const cached = probeCache.get(account.id);
    if (cached === undefined || now - cached.atMs >= PROBE_TTL_MS) return true;
  }
  return false;
}

/**
 * Whether anything the panel is showing is waiting on a cooldown to lapse.
 *
 * A pool whose every account is cooling answers "nothing to refresh", so the
 * panel stopped polling and the figures stayed stale until the user clicked
 * Refresh or the poll hit its attempt cap. The cooldown's own end is what
 * un-stales them, so it is the deadline the panel waits for.
 */
function cooldownPending() {
  const now = Date.now();
  for (const account of core.pool.list()) {
    if (account.cooldownUntilMs > now) return true;
  }
  return false;
}

/**
 * What a pass answers once its activation is gone.
 *
 * The document is deliberately not built: this plugin is no longer loaded, so
 * nobody is reading the answer, and reading the shared state it was built from
 * is exactly what must not happen during a teardown.
 */
function stalePass() {
  return { stale: true };
}

/**
 * Run a refresh behind the current turn, at most one at a time.
 *
 * Deferring it to the next tick is what keeps a panel open cheap: the caller
 * answers from cache first and the detection lands behind the rendered page.
 * This is the *background* flavour, so it respects each gateway's refresh
 * window instead of forcing a roster fetch that load already did.
 */
function scheduleRefresh(reason) {
  // A stopped service owns no gateways: the timer would fire, run a pass that
  // returns at its own guard, and hold the loop for nothing.
  if (serviceStopped) return;
  if (refreshTimer !== null || refreshInflight !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshAll(reason, false).catch((error) => log("warn", "background refresh failed: " + safeMessage(error)));
  }, 0);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

async function refreshRuntime(runtime, reason, force) {
  if (runtime.connecting !== null) {
    const inFlight = runtime.connecting;
    if (force !== true) return inFlight;
    // A forced pass may not collapse onto a background read that skipped the
    // roster because it was still fresh: waiting for it answers the click with
    // the figures it already had, and the button exists precisely for the case
    // where a background read failed. It waits for that read to end and then
    // runs its own, which is the one that re-reads.
    await inFlight.catch(() => {});
    // Another pass claimed the gateway while this one waited: that read is the
    // newest there is, so it is awaited rather than duplicated.
    if (runtime.connecting !== null) return runtime.connecting;
  }
  runtime.connecting = (async () => {
    try {
      const ok = await connect(runtime, force === true);
      return { ok, reason };
    } finally {
      runtime.connecting = null;
    }
  })();
  return runtime.connecting;
}

/**
 * Re-read settings, re-apply them, re-seed every gateway's catalog, then
 * republish. `force` decides whether each gateway's roster is refetched even
 * inside its refresh window: `true` for a user-invoked pass, `false` for the
 * background one that follows a panel open.
 *
 * Concurrent passes are collapsed: the background pass would otherwise
 * duplicate the work of the pass a Refresh click just started. The collapse
 * keeps awaiting the pass it found, whichever kind this call is, so a forced
 * click can never end up running a second pass beside the first. The one
 * exception is a forced click meeting a background pass: waiting for it to the
 * end would answer the click with figures it already had, so that click runs
 * its own pass. What it must not do is release the slot when its own work ends
 * - the background pass is still running, and a caller arriving in that window
 * would start a pass beside it. The slot therefore outlives both.
 */
async function refreshAll(reason, force) {
  // A pass already in flight is collapsed onto and awaited to the end. Two
  // forced clicks collapse the same way: the second one's figures would be the
  // first one's, and running both reconciled the same gateways twice and wrote
  // the declaration twice, in an order that need not match the last pass.
  let previous = null;
  if (refreshInflight !== null) {
    if (force !== true || refreshInflight.force) return await refreshInflight.promise;
    previous = refreshInflight.promise.catch(() => {});
  }
  // A stopped service owns no gateways, so there is nothing to refresh and
  // nothing that may be created: answering the cached document is what the
  // caller expects (`xd.state` spreads it). Falls through to `statusDocument`
  // so the answer keeps the shape of every other pass.
  if (serviceStopped) return await statusDocument({ allowNetwork: false });
  // The activation this pass belongs to. Every stage below checks it after its
  // await: unload bumps the counter, and a pass that resumes afterwards must not
  // re-open the gateways and timers it just closed.
  const generation = loadGeneration;
  const run = async () => {
    const wantForce = force === true;
    // One deadline for the whole pass. The host allows a panel call 30 s, and
    // the stages below would otherwise add their own budgets up to well past
    // that; each stage now gets what is left of this one and a stage that runs
    // out of time leaves its result for the next pass. The port reservations
    // before it are capped by their own attempt count, and cost a few seconds
    // at worst when another process holds the preferred ports.
    const deadline = Date.now() + REFRESH_PASS_BUDGET_MS;
    const left = () => Math.max(0, deadline - Date.now());
    await adoptHostSettings();
    if (!stillLoaded(generation)) return stalePass();
    applySettingsToCore();
    // The pool was emptied by a switch-off, so the regions coming back have no
    // accounts to sign their gateways in with. `pool.acquire` scans lazily, but
    // only once a chat request arrives through a gateway - too late to publish a
    // model list, which is what the panel and the picker read.
    if (poolNeedsScan) {
      poolNeedsScan = false;
      await settleWithin(core.pool.scan(), left());
      if (!stillLoaded(generation)) return stalePass();
    }
    for (const region of activeRegions()) {
      // Gateways a settings change retired may still be closing; their ports
      // are only reusable once those closes settle. `startRuntimes` drains the
      // same list before it binds, for the same reason - see
      // `pendingRuntimeStops`.
      if (pendingRuntimeStops.length > 0) {
        await Promise.all(pendingRuntimeStops.splice(0));
        // Checked before the bind rather than only after it: a service that
        // stopped during the drain used to cost one full port reservation and
        // shim bind before the pass discovered it was stale.
        if (!stillLoaded(generation)) return stalePass();
      }
      if (runtimes.has(region)) continue;
      // A pass that runs out of budget mid-start must not leak what it built:
      // by the time `createRuntime` awaits it has already reserved a port and
      // bound a shim, and the late runtime arrives with nobody to own it. The
      // started work is kept so it can be released instead of abandoned.
      const started = startRuntimeOnce(region);
      let runtime;
      try {
        runtime = await settleWithin(started, left());
      } catch (error) {
        // A shim that could not bind (its port taken between the reservation and
        // the listen) rejects here. Letting it through failed the whole pass,
        // and with it the declaration write for every region that was fine.
        log("warn", region + " failed to start during refresh: " + safeMessage(error));
        gatewayStartFailures.set(region, safeMessage(error));
        continue;
      }
      if (runtime === undefined) {
        // The late arrival is released only when nobody registered it: a second
        // caller shares this promise, and its own `runtimes.set` is the one that
        // matters.
        started.then((late) => { if (runtimes.get(region) !== late) return stopRuntime(late); }, () => { /* it failed; nothing was bound */ });
        continue;
      }
      // The stop can land while the shim binds: `runtimes.clear()` has already
      // run by then, so this runtime would stay open forever. Same rule as
      // `startRuntimes`, through the same helper: a stale generation is one more
      // reason nobody wants this gateway, and it resolves the same two races the
      // other caller does (switched off, or already registered by a reload).
      await settleStartedRuntime(region, runtime, !stillLoaded(generation) || !activeRegions().includes(region));
    }
    // Trae gateways follow the same switch, and are reconciled before the
    // declaration is written so their rows can join this run's publish.
    await settleWithin(reconcileTraeGateways(), left());
    if (!stillLoaded(generation)) return stalePass();
    // Qoder gateways follow the same switch on the same terms.
    await settleWithin(reconcileQoderGateways(), left());
    if (!stillLoaded(generation)) return stalePass();
    // The Trae and Qoder strips list their own local sign-ins, which no pool
    // cache holds; read them here so the panel can show who is found. A failed
    // read leaves the previous list rather than claiming "no sign-in".
    await settleWithin(refreshSourceAccounts(), left());
    if (!stillLoaded(generation)) return stalePass();
    // A gateway whose directory never answered - it failed, or the read that
    // runs behind init is still in flight - is asked again here, so a cold or
    // failing directory recovers on its own instead of being reported for the
    // rest of the process. Gateways that already hold a roster are left
    // alone, and the batch is concurrent, so the cost is one read.
    await settleWithin(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())]
      .filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0)
      .map((entry) => warmSourceDirectory(entry))), left());
    if (!stillLoaded(generation)) return stalePass();
    // Concurrent, not one after the other: two rosters read end to end can
    // spend a whole panel call on their own.
    await settleWithin(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, reason, wantForce))), left());
    if (!stillLoaded(generation)) return stalePass();
    syncDeclaration();
    return await statusDocument({ allowNetwork: true, budgetMs: left() });
  };
  const entry = { promise: null, force: force === true };
  // A pass invoked directly (the panel's wait-for-refresh, a rescan, a manual
  // check-in run) leaves the deferred background timer armed, and that timer
  // fired a second full pass behind the one just run. Cancelled here, where the
  // direct pass starts, rather than inside the timer: the timer's whole job is
  // to be the deferred version of this call.
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  entry.promise = (async () => {
    try {
      return await run();
    } finally {
      // The slot is released only once everything this pass started beside has
      // finished. Releasing it when this pass's own work ended is what let a
      // third caller start a pass while the background one was still running.
      if (previous !== null) await previous;
      if (refreshInflight === entry) refreshInflight = null;
    }
  })();
  refreshInflight = entry;
  return await entry.promise;
}

/**
 * The sign-ins found on this machine for the sources that are not pool
 * accounts, reduced to what the panel shows: a label, the region, and whether
 * the token is still fresh. No token material leaves this function.
 */
let traeAccountRows = [];
let qoderAccountRows = [];

/**
 * The name one Trae account is listed and claimed under.
 *
 * A Trae-generated `username` can read as a stranger (`zhang san xyz`), so the
 * email is what the panel shows next to it; the label itself stays the app's
 * own name so it matches what the desktop app displays.
 */
function traeRowLabel(credential) {
  return credential.accountName ?? credential.email ?? credential.userId;
}

/**
 * The app one Trae sign-in came from.
 *
 * One account keeps a copy in every Trae app it was signed into (and one in the
 * CLI), and the scanner folds those copies into a single account. Naming the
 * copy that won is what makes that fold readable: without it the account just
 * looks like it lost a row.
 */
function traeAppLabelOf(credential) {
  if (credential.source === "cli") return "Trae CLI";
  return traeWindowsAppNames(credential.edition)[0];
}

/** The name one Qoder account is listed and claimed under. */
function qoderRowLabel(credential) {
  return credential.name === "" ? credential.userID : credential.name;
}

/**
 * How long the Trae and Qoder sign-in lists may take in total.
 *
 * Each account's probe is already bounded, but a machine with several sign-ins
 * to a source would add those bounds end to end, and the host allows a panel
 * call 30 s. Past this budget a row keeps the figures it already has. The
 * figure is deliberately a slice of a refresh pass rather than most of it: the
 * pass still has a roster read and a document to answer with.
 */
const SOURCE_ACCOUNTS_BUDGET_MS = 8000;

/**
 * How long one Trae or Qoder account's probe may take.
 *
 * Trae's probes read at once, so this bounds that whole list; Qoder paces its
 * reads, so the deadline above is what bounds that list instead.
 */
const SOURCE_PROBE_TIMEOUT_MS = 8000;
/**
 * Read one Trae account's check-in state and quota for its card. Quota is the
 * verified pay endpoint (`web_user_ent_usage`, same surface dsh-connect-trae
 * ships); the check-in row is CN-only. A failed probe keeps the previous
 * row's figures — a flaky network is not "no quota".
 */
async function traeRowProbe(credential, previous) {
  if (sourceCredentialExpired(credential, Date.now())) return previous;
  try {
    const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
    const client = new TraeSoloUpstreamClient({
      credential: async () => credential,
      identity: () => resolveTraeIdentity(desktopCandidates, credential.edition),
    });
    // The international region is subscription-based: it has no Work-credit
    // totals and no daily check-in, so its usage surface is the plan the pay
    // host reports. CN reads the check-in and the credit totals instead.
    if (traeRegionOfCredential(credential) !== "cn") {
      const pay = await client.fetchPayStatus(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS));
      return {
        checkin: undefined,
        usage: pay.plan === "" ? undefined : { plan: { name: pay.plan, inTrial: pay.inTrial } },
      };
    }
    const [status, usage] = await Promise.all([
      client.fetchCheckinStatus(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
      client.fetchUsageSummary(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
    ]);
    return {
      checkin: {
        active: status.enable !== false,
        todayCheckedIn: status.checkedIn === true,
        deviceCheckedIn: status.didCheckedIn === true,
        credits: status.credits,
        // The card's "what today is worth" line reads `amount`, the same name
        // Qoder's campaign answer uses. `credits` is the reward the status
        // endpoint reports for today's check-in; the member bonus is left out
        // because nothing in this plugin's reads proves the account is a member.
        amount: status.credits,
        unit: "credits",
      },
      // The same credit shape a pool account uses, so one renderer draws
      // both: the total is what is left, and every pack carries its own
      // expiry — a daily check-in reward is one of those packs.
      usage: { credits: traeSourceCredits(usage) },
    };
  } catch {
    return previous;
  }
}

/**
 * One Trae usage answer folded into the credit shape the panel renders, so a
 * source account and a pool account are drawn by the same code. Each pack
 * keeps its own expiry because that is the only place it exists: the daily
 * check-in reward lands as a pack of its own, so "when do the check-in credits
 * run out" is answered per row rather than per account.
 */
function traeSourceCredits(usage) {
  const packages = usage.packs.map((pack) => ({
    packageName: pack.name,
    remain: pack.remaining,
    size: pack.total,
    ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
  }));
  return {
    total: usage.remainingAmount,
    packages,
  };
}

/** Read one Qoder account's quota and today's campaign, reduced for the card. */
async function qoderRowProbe(credential, previous) {
  if (sourceCredentialExpired(credential, Date.now())) return previous;
  try {
    const client = new QoderUpstreamClient({ region: credential.region, credential: async () => qoderClientCredential(credential) });
    // Usage is the row the card cannot do without. The campaign only answers
    // the check-in state and how long its reward lives, so a campaign failure
    // costs those two and not the whole read - but it has to be told apart from
    // "this account has no campaign", or a read that failed looks exactly like
    // an account with nothing to collect.
    let campaignsUnavailable = false;
    const [usage, campaigns] = await Promise.all([
      client.fetchUsage(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
      client.fetchCampaigns(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)).catch(() => {
        campaignsUnavailable = true;
        return undefined;
      }),
    ]);
    const state = qoderCheckinStateFrom(campaigns);
    // Both pools are this account's credits, and the check-in lands in the
    // add-on one, so each becomes a row of its own instead of the plan bucket
    // taking the only line. `nameKey` is a locale key rather than a name
    // because the upstream labels neither pool. A pool the route names is a
    // row even at zero: an account on no plan reports 0/0, and that row is
    // where "does not expire" belongs — the plan is the pool that never
    // expires, the check-in credits are the ones that run out.
    //
    // Each row carries its own expiry, because the two pools expire on
    // different terms: the add-on credits are what the daily check-in pays out
    // and are valid for a fixed number of days from each claim, while the
    // plan's date is the account-wide one the usage route sends. The pool is
    // only ever reported as a sum, so the newest claimed round's own deadline
    // is the date it gets; with no round claimed yet the rule is all there is.
    const validDays = qoderRewardValidityDaysOf(campaigns);
    const rewardExpiresAtMs = qoderRewardExpiryMs(campaigns);
    // Named so the row shape stays readable: one expiry field per row, chosen
    // by what the upstream could say about that pool rather than by a chain of
    // fallbacks nobody can read.
    const planExpiry = usage.expiresAtMs !== undefined
      ? { expiresAtMs: usage.expiresAtMs }
      : usage.neverExpires === true ? { neverExpires: true } : {};
    const rewardExpiry = rewardExpiresAtMs !== undefined
      ? { roundExpiresAtMs: rewardExpiresAtMs }
      : validDays === undefined ? {} : { validDays };
    const packages = [
      ...usage.userQuota === undefined ? [] : [{
        nameKey: "credits.planQuota",
        remain: usage.userQuota.remaining,
        size: usage.userQuota.total,
        ...planExpiry,
      }],
      ...usage.addOnQuota === undefined ? [] : [{
        nameKey: "credits.addOnQuota",
        remain: usage.addOnQuota.remaining,
        size: usage.addOnQuota.total,
        ...rewardExpiry,
      }],
      ...usage.dedicatedPackages.slice(0, 3).map((pack) => ({
        packageName: pack.name,
        remain: pack.remaining,
        size: pack.total,
        ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
      })),
    ];
    // No pool at all reports no credits rather than a total of zero, which
    // would read as "spent it all".
    const credits = packages.length === 0 ? undefined : {
      total: packages.reduce((sum, pack) => sum + pack.remain, 0),
      packages,

    };
    return {
      ...(credits === undefined ? {} : { usage: { credits } }),
      // The card shows the hour, not the instant: the panel has no timezone of
      // its own, and the campaign clock is Beijing's.
      checkin: {
        ...state,
        ...campaignsUnavailable ? { campaignsUnavailable: true } : {},
        ...state.opensAt === undefined ? {} : { opensAtHour: zonedDayHour(new Date(state.opensAt)).hour },
      },
    };
  } catch {
    return previous;
  }
}

async function refreshSourceAccounts() {
  const now = Date.now();
  try {
    const regions = activeTraeRegions();
    if (regions.length > 0) {
      const found = await discoverTraeCredentials();
      // These probes are independent, and none of them paces the upstream, so
      // they read at once rather than adding one bound per account: a machine
      // with several Trae sign-ins would otherwise spend the whole panel budget
      // here. `Promise.all` keeps the discovery order.
      const rows = await Promise.all(found.credentials.filter((credential) => regions.includes(traeRegionOfCredential(credential))).map(async (credential) => {
        const label = traeRowLabel(credential);
        const region = traeRegionOfCredential(credential);
        const previous = traeAccountRows.find((row) => row.label === label && row.region === region);
        const probe = await traeRowProbe(credential, previous);
        noteSourceExpiry("trae", region, label, probe?.usage?.credits?.packages);
        return {
          label,
          region,
          app: traeAppLabelOf(credential),
          ...credential.email === undefined || credential.email === label ? {} : { email: credential.email },
          expiresAt: credential.expiresAtMs,
          expired: sourceCredentialExpired(credential, now),
          ...(probe?.checkin ? { checkin: probe.checkin } : {}),
          ...(probe?.usage ? { usage: probe.usage } : {}),
        };
      }));
      traeAccountRows = rows.filter((row) => regionEnabled("trae", row.region));
    } else {
      traeAccountRows = [];
    }
  } catch (error) {
    log("warn", "listing Trae sign-ins failed: " + safeMessage(error));
  }
  try {
    const regions = activeQoderRegions();
    if (regions.length > 0) {
      const found = await discoverQoderCredentials();
      const rows = [];
      // Qoder's probes are paced on purpose, so this one cannot read at once the
      // way Trae's does; it is bounded instead. Past the deadline a row keeps
      // the figures it already has rather than the list being dropped whole.
      const deadline = Date.now() + SOURCE_ACCOUNTS_BUDGET_MS;
      // Counted, not flagged: an account whose region is switched off must not
      // decide whether the next one waits.
      let seen = 0;
      for (const credential of found.credentials) {
        if (!regions.includes(credential.region)) continue;
        if (seen > 0) await delay(QODER_ACCOUNT_DELAY_MS);
        seen += 1;
        const label = qoderRowLabel(credential);
        const previous = qoderAccountRows.find((row) => row.label === label && row.region === credential.region);
        const probe = Date.now() < deadline ? await qoderRowProbe(credential, previous) : previous;
        noteSourceExpiry("qoder", credential.region, label, probe?.usage?.credits?.packages);
        rows.push({
          label,
          region: credential.region,
          expiresAt: credential.expiresAtMs,
          expired: sourceCredentialExpired(credential, now),
          ...(probe?.checkin ? { checkin: probe.checkin } : {}),
          ...(probe?.usage ? { usage: probe.usage } : {}),
        });
      }
      qoderAccountRows = rows.filter((row) => regionEnabled("qoder", row.region));
    } else {
      qoderAccountRows = [];
    }
  } catch (error) {
    log("warn", "listing Qoder sign-ins failed: " + safeMessage(error));
  }
  pruneSourceState();
}

/**
 * Drop the per-sign-in bookkeeping of a sign-in that is no longer there.
 *
 * Both maps are keyed by source and label, and a label is not unique to one
 * sign-in: a departed account's hold was inherited by the next one that happened
 * to carry the same name, which demoted it for the rest of the hold despite
 * never having failed, and its pack expiry corrupted `expiry`-mode ordering and
 * the composer's active row.
 */
function pruneSourceState() {
  const live = new Set();
  for (const row of traeAccountRows) live.add(accountStateKey("trae", row.region, row.label));
  for (const row of qoderAccountRows) live.add(accountStateKey("qoder", row.region, row.label));
  for (const key of [...sourceFailureHold.keys()]) {
    if (!live.has(key)) sourceFailureHold.delete(key);
  }
  for (const key of [...sourceCreditExpiry.keys()]) {
    if (!live.has(key)) sourceCreditExpiry.delete(key);
  }
}

/**
 * Drop the Trae and Qoder credential-discovery caches.
 *
 * Discovery is cached for a short while, so a source switched on - or a
 * deliberate rescan - would otherwise be answered from a read taken while it was
 * off.
 */
function resetDiscoveryCaches() {
  resetQoderCredentialCache();
  resetTraeCredentialCache();
  // The identity probe is memoised per edition; a desktop sign-in made
  // after the last probe must not keep the hint for the rest of the process.
  traeIdentityBlockers.clear();
}

/**
 * Directories the WorkBuddy pool reads, in order.
 *
 * The desktop app's own directories come first, and that is only the walk
 * order: which copy of an account serves is decided by issue time, with the
 * source breaking a tie. The plugin's own directory is appended rather than
 * substituted: an account added from the panel is read on exactly the same
 * terms as a desktop sign-in, and removing it is a file deletion the user can
 * see. A repointed `authFile` narrows the walk to that one directory plus the
 * plugin's own, the way the pool reads whatever it writes.
 */
function poolAuthDirs(authFile) {
  if (authFile !== "") return [path.dirname(authFile)];
  const own = ownSignInDir(dataPath);
  const dirs = candidateAuthDirs();
  if (own === "" || dirs.includes(own)) return dirs;
  return [...dirs, own];
}

/** Push the settings that affect discovery, cooldown and the picker. */
function applySettingsToCore() {
  const authFile = typeof settings.authFile === "string" ? settings.authFile.trim() : "";
  const emptied = core.pool.applyConfig({
    authDirs: poolAuthDirs(authFile),
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
    disabledAccountIds: disabledAccountIds(),
    creditReserves: creditReserves(),
  });
  core.pool.applyRemoved(removedAccounts().map((entry) => entry.id));
  for (const region of REGIONS) {
    core.pool.prefer(preferredAccountId(region), region);
    applyEffectiveSelection(region);
  }
  // A repointed auth file empties the pool, and nothing downstream reads the
  // disk on its own: without this both WorkBuddy provider rows dropped out of
  // the picker and the panel reported "no sign-in found" until a chat request
  // happened to scan, or the user pressed "Detect accounts again".
  if (emptied) poolNeedsScan = true;
  // A source switched off keeps no runtime, no accounts and no probes: the next
  // scan rebuilds from disk when it is switched back on.
  reconcileRuntimes();
  // The daily check-in timer follows the switch, so a settings change takes
  // effect without a reload.
  applyAutoCheckin();
}

/**
 * Retire runtimes whose source is switched off.
 *
 * Called on every settings application, so toggling the source needs no reload:
 * the gateway stops, its accounts leave the pool, and its probes are dropped.
 */
function reconcileRuntimes() {
  const active = new Set(activeRegions());
  for (const [region, runtime] of runtimes) {
    if (!active.has(region)) {
      // The close is recorded rather than awaited: this runs synchronously from
      // settings application, and `startRuntimes` drains the list before it
      // binds, which is where the port the close is releasing gets reused.
      pendingRuntimeStops.push(stopRuntime(runtime));
      runtimes.delete(region);
    }
  }
  if (active.size === 0 && core.pool) {
    core.pool.clear();
    probeCache.clear();
    // `pool.list()` does not read the disk, and nothing on the way back does
    // either - so without this the re-enabled gateways come up signed out and
    // the panel shows an empty strip until the user rescans by hand.
    poolNeedsScan = true;
  }
}

/**
 * True while the pool is empty because its last active region was switched off.
 *
 * A local directory read one pass later is what turns the pool back on; the flag
 * keeps that read to the passes that actually follow a switch-off, rather than
 * re-reading the disk on every pass for a machine with no sign-in at all.
 */
let poolNeedsScan = false;

// ------------------------------------------------------------------- status

/**
 * The errno code of a failure, and nothing else. An fs error quotes the
 * absolute path it hit, which is the install path when the write target is
 * this plugin's own manifest; the code is the part a report can act on.
 */
function errorCodeOf(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && code !== "" ? code : "unknown";
}

/**
 * Margin for the whole per-account probe batch inside one panel call.
 *
 * The host allows a panel call 30 s and a refresh pass spends part of that on
 * the roster, so the probes get the rest rather than all of it.
 */
const PROBE_BATCH_BUDGET_MS = 20000;

/** Fold one probe's answer into the row it was read for. */
function applyProbe(row, probe) {
  if (probe.pending === true) {
    row.probePending = true;
    return;
  }
  if (probe.credits !== undefined) row.credits = probe.credits;
  if (probe.creditsError !== undefined) row.creditsError = probe.creditsError;
  if (probe.checkin !== undefined) row.checkin = probe.checkin;
  if (probe.checkinError !== undefined) row.checkinError = probe.checkinError;
}

/**
 * One account's credits and check-in, served from cache while it is fresh.
 *
 * `allowNetwork: false` never waits on the upstream: a cold entry reports
 * `pending` so the panel can say it is still reading, and the caller refreshes
 * behind the first paint.
 */
async function accountProbe(account, allowNetwork, checkinOnly = false) {
  const cached = probeCache.get(account.id);
  if (allowNetwork !== true) {
    return cached === undefined ? { pending: true } : cached.value;
  }
  if (cached !== undefined && Date.now() - cached.atMs < PROBE_TTL_MS) return cached.value;
  // A sign-in the upstream refused is held, and the row carries the hold: no
  // read is spent on it, so the panel stops paying two upstream calls every
  // couple of minutes for an answer the account cannot give. The first refusal
  // itself is what placed the hold, through `readAfterRefresh` below.
  //
  // The answer is deliberately not cached. A hold is released by a new sign-in
  // or a refresh that works, and a cached empty row would keep showing a
  // recovered account as blank for as long as the probe entry lives.
  if (signInRefused(account)) return {};
  const value = {};
  // A cooling account may not spend a turn, but its check-in state is exactly
  // what the user opens the panel to see, and the daily reward is claimable
  // while it cools. The balance read is the one worth skipping: it costs an
  // upstream call and the account cannot serve a request anyway.
  if (!checkinOnly) {
    try {
      const credits = await core.pool.readAfterRefresh(account.id, (credential) =>
        core.client.fetchCredits(credential));
      value.credits = {
        ...credits.total === undefined ? {} : { total: credits.total },
        packages: (credits.packages || []).map((pack) => ({
          packageName: pack.packageName,
          ...pack.remain === undefined ? {} : { remain: pack.remain },
          ...pack.size === undefined ? {} : { size: pack.size },
          ...pack.monthly === undefined ? {} : { monthly: pack.monthly },
          ...pack.refreshAtMs === undefined ? {} : { refreshAtMs: pack.refreshAtMs },
          ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
        })),
        ...credits.expiringSoon === undefined ? {} : { expiringSoon: credits.expiringSoon },
        ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
      };
    } catch (error) {
      value.creditsError = safeMessage(error);
    }
    // A balance read here is what an account's reserve floor is checked against,
    // so it is handed to the pool instead of staying a display-only number.
    if (value.credits !== undefined && typeof value.credits.total === "number") {
      core.pool.setCreditBalance(account.id, value.credits.total, value.credits.nearestExpiryMs);
    }
  }
  try {
    const checkin = await core.pool.readAfterRefresh(account.id, (credential) =>
      core.client.fetchCheckinStatus(credential));
    value.checkin = {
      active: checkin.active,
      todayCheckedIn: checkin.todayCheckedIn,
      streakDays: checkin.streakDays,
      dailyCredit: checkin.dailyCredit,
      todayCredit: checkin.todayCredit,
      isStreakDay: checkin.isStreakDay,
      nextStreakDay: checkin.nextStreakDay,
      streakBonusCredit: checkin.streakBonusCredit,
    };
  } catch (error) {
    value.checkinError = safeMessage(error);
  }
  probeCache.set(account.id, { atMs: Date.now(), value });
  // An account that left the pool (sign-in removed, region switched off) keeps
  // its entry otherwise: the map only ever grew, and every stale check walked
  // the dead entries with the live ones.
  if (probeCache.size > core.pool.list().length) {
    const live = new Set(core.pool.list().map((item) => item.id));
    for (const id of Array.from(probeCache.keys())) {
      if (!live.has(id)) probeCache.delete(id);
    }
  }
  return value;
}

/**
 * Per-gateway roster warnings, for gateways that have one right now.
 *
 * Empty spread when nothing is wrong, so a healthy panel carries no
 * `warnings` key at all rather than an empty object to check.
 */
function catalogWarnings() {
  const warnings = {};
  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    // A gateway that could not sign in at all reads as an empty tab with no
    // explanation; a roster that could not be re-read still serves a stale list.
    // Both are per-gateway facts the panel has no other way to learn.
    const message = runtime?.lastError || runtime?.lastWarning;
    if (typeof message === "string" && message !== "") warnings[region] = message;
  }
  return Object.keys(warnings).length === 0 ? {} : { warnings };
}

/**
 * Whether this account's sign-in is one the upstream has refused.
 *
 * The hold is the pool's own record that a refresh could not save the sign-in,
 * so every pass that walks the pool asks before it spends a call: a held
 * account cannot answer, and the panel row already says why.
 */
function signInRefused(account) {
  return core.pool.activeHold(account.id)?.reason === "session";
}

/**
 * The row fields that describe a hold the pool itself decided, if one is in
 * force for this account right now.
 *
 * Empty spread when the account is simply cooling on an upstream window: that
 * state already reads as one on the row, and its remedy is to wait. The reason
 * travels with it because a refused sign-in, a spent balance and a vendor
 * restriction need three different remedies, and the row prints the reason
 * rather than "rate-limited" for all three.
 */
function activeHoldOf(accountId, now) {
  const hold = core.pool.activeHold(accountId);
  if (hold === null || hold.untilMs <= now) return {};
  return { hold: hold.reason };
}

async function statusDocument(options) {
  // `allowNetwork: false` answers from the caches only, so a panel open paints
  // immediately; the caller schedules the real refresh behind it.
  const allowNetwork = options?.allowNetwork === true;
  // A caller inside a bounded pass hands over what is left of its deadline, so
  // the probe batch cannot outlast the pass that asked for it.
  const probeBudget = typeof options?.budgetMs === "number"
    ? Math.min(PROBE_BATCH_BUDGET_MS, Math.max(0, options.budgetMs))
    : PROBE_BATCH_BUDGET_MS;
  const now = Date.now();
  // The reserve floors are read once for the whole document: the dictionary is
  // rebuilt from settings on every call, and one row per account asked for it
  // twice.
  const reserves = creditReserves();
  // Promotions are announced on the campaign clock, so every model row in this
  // document is judged against one reading of it rather than a per-row clock
  // that could straddle an hour boundary mid-render.
  const campaignClock = zonedDayHour(new Date(now));
  const accounts = [];
  const models = [];
  const selectionByRegion = {};
  const preferredAccountIds = {};
  /** region -> the account `pool.acquire` would pick next, for the "next up" row. */
  const runtimeNextUpId = new Map();
  /** Gateways whose stored selection names models the roster no longer has. */
  const staleSelectionRegions = [];
  /** Row -> the credits/check-in read that row is still waiting on. */
  const pendingProbes = [];

  for (const region of activeRegions()) {
    // Report the selection actually in force, not the raw stored one: if the
    // stored ids no longer exist upstream, the panel would otherwise open with
    // every model shown as disabled while the plugin is really serving all of
    // them.
    preferredAccountIds[region] = preferredAccountId(region) || "";
    selectionByRegion[region] = effectiveSelectionFor(region, runtimes.get(region)?.catalog);
    if (selectionStale(region, runtimes.get(region)?.catalog)) staleSelectionRegions.push(region);
    // Without a target model, only account-wide cooldowns can be previewed.
    // The pool's own eligibility, not a second filter here: it already drops
    // removed, switched-off and reserve-holding accounts, and a copy of that
    // rule in this file once marked a switched-off account as next up.
    const available = core.pool.available(now, undefined, region);
    const preferred = available.find((account) => account.id === preferredAccountIds[region]);
    // Priority and expiry name the account the next request will use. The
    // rotating modes do not, so they mark nothing rather than point at a guess.
      const nextUp = preferred ?? core.pool.preview(available);
    runtimeNextUpId.set(region, nextUp === undefined ? undefined : nextUp.id);

    for (const account of core.pool.list(region)) {
      const cooling = account.cooldownUntilMs > now;
      const modelCooldowns = Object.entries(account.modelCooldowns)
        .filter(([, until]) => until > now)
        .sort((a, b) => a[1] - b[1])
        .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }));
      const row = {
        id: account.id,
        label: account.label,
        region,
        ...account.credential.expiresAtMs === 0
          ? {}
          : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
        cooling,
        ...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
        ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
        rateLimitHits: account.rateLimitHits,
        // The pool's own hold, when one is in force. A `session` hold is the one
        // the user has to act on - the sign-in was refused and only a new one
        // releases it - so the row says so instead of showing the raw upstream
        // sentence on every poll. `spent` needs no field of its own: the row
        // already reads as cooling, and a balance read releases it.
        ...activeHoldOf(account.id, now),
        active: runtimeNextUpId.get(region) === account.id,
        preferred: preferredAccountIds[region] === account.id,
        disabled: core.pool.isDisabled(account.id),
        // Kept only in the pool's archive: its sign-in was overwritten when the
        // app switched accounts, so the row stays visible but is never picked.
        ...account.archived === true ? { archived: true } : {},
        // A sign-in this plugin wrote, so the row may offer to delete the file.
        // A desktop app's own sign-in is never offered that: deleting it would
        // sign the user out of the app.
        ...core.pool.ownsSignIn(account.id) ? { own: true } : {},
        // Hoisted out of the row: the reserves dictionary was rebuilt for every
        // account in the pool, twice per row.
        ...reserves[account.id] === undefined ? {} : { creditReserve: reserves[account.id] },
      };
      // Credits and check-in are read behind the row, not inside it: the batch
      // runs after every row is built, so one account's read cannot hold up the
      // next one's (see below).
      // A switched-off account is never picked, so probing it spent two upstream
      // calls a minute on a row that only exists so the user can switch it back
      // on; and because a stale probe kept `probesStale` true, it held the
      // panel's polling open with it.
      //
      // A cooling account is read for its check-in only. Skipping it entirely
      // left the row with no check-in state, and the panel renders that as "this
      // account has no check-in programme" with no claim button, over an account
      // whose daily reward is still unclaimed and still claimable.
      if (!core.pool.isDisabled(account.id)) {
        const checkinOnly = cooling;
        pendingProbes.push(accountProbe(account, allowNetwork, checkinOnly).then((probe) => {
          applyProbe(row, probe);
        }));
      }
      accounts.push(row);
    }

    const catalog = runtimes.get(region)?.catalog;
    if (catalog) {
      const selection = effectiveSelectionFor(region, catalog);
      const enabled = selection.enabledModelIds;
      const overrides = selection.overrides || {};
      for (const model of catalog.current()) {
        const override = overrides[model.id];
        const effective = applyOverride(model, override, catalog.hasLiveRoster());
        const levels = thinkingLevelsFor(effective);
        const promo = promoStatusFor(model, campaignClock, region);
        models.push({
          id: model.id,
          // The catalog name and the user's alias travel separately: the editor
          // shows the alias in its own field and the catalog name as that
          // field's placeholder, so an empty alias must not read as a rename.
          name: model.name,
          ...effective.alias === undefined ? {} : { alias: effective.alias },
          region,
          ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
          // A time-boxed promotion the catalog does not model. Read on the
          // campaign clock, so a host in another zone cannot open or close the
          // window at the wrong hour.
          ...promo === undefined ? {} : { promo },
          supportsImages: effective.supportsImages,
          contextWindow: effective.contextWindow,
          maxOutputTokens: effective.maxOutputTokens,
          // The catalog's own numbers, so the editor can offer a reset and mark
          // a field the user has changed.
          nativeContextWindow: model.contextWindow,
          nativeMaxOutputTokens: model.maxOutputTokens,
          nativeSupportsImages: model.supportsImages,
          nativeThinkingLevels: model.supportedEfforts === undefined || model.supportedEfforts.length === 0
            ? []
            : [...model.supportedEfforts],
          thinkingLevels: levels,
          ...effective.defaultThinkingLevel === undefined
            ? {}
            : { defaultThinkingLevel: effective.defaultThinkingLevel },
          advanced: hasOverride(override),
          enabled: enabled === undefined || enabled.includes(model.id),
        });
      }
    }
  }

  // Credits and check-in are auxiliary: a failing query degrades to an error
  // field instead of failing the whole document, and a cold cache on the fast
  // path renders as "still reading" rather than a stall.
  //
  // Two things make this safe inside a panel call. The reads run at once, so a
  // machine with several accounts pays the slowest one and not their sum. And
  // they are bounded: the host allows a panel call 30 s, and one account's two
  // reads each have their own bound, so the batch is capped too. A read that
  // outlives the cap still lands in the cache, which is what lets the panel
  // come back with the numbers on its next pass instead of losing them.
  if (pendingProbes.length > 0) {
    await settleWithin(Promise.all(pendingProbes).catch(() => {}), probeBudget);
  }

  // Only active gateways are offered: a source switched off removes its tabs
  // instead of showing an empty tab that can never fill.
  return {
    regions: activeRegions(),
    sources: { workbuddy: sourceEnabled("workbuddy"), trae: sourceEnabled("trae"), qoder: sourceEnabled("qoder") },
    // Which regions the user parked, so the panel can still show them (and let
    // them be switched back on) after they leave `regions` above.
    disabledRegions: disabledRegionKeys(),
    // Trae's gateways report separately: its regions are a different pair, and
    // its accounts are not part of the WorkBuddy pool the tabs above drive.
    trae: {
      regions: activeTraeRegions(),
      distribution: sourceDistribution("trae"),
      accounts: traeAccountRows,
      // One map per source, keyed by region: the panel's "which account serves
      // this region" picker reads it straight back, so a pick survives the next
      // document instead of snapping back to automatic.
      preferred: sourcePreferredMap("trae"),
      gateways: Array.from(traeGateways.values()).map((entry) => ({
        region: entry.region,
        port: entry.gateway.port(),
        models: traeDeclarationModels(entry.region).length,
        portFallback: entry.portFallback,
        preferredPort: entry.preferredPort,
        lastError: entry.lastError,
        // Roster and selection come from one pass, and the selection is the one
        // the gateway really publishes rather than the raw stored value: after a
        // catalog rename the two used to disagree, so the panel showed every
        // model unticked while the gateway served all of them.
        ...sourcePublishedModels("trae:" + entry.region, entry.gateway.models(), traeNativeOf),
      })),
    },
    // Qoder's gateways report beside Trae's on the same terms: its regions are
    // the WorkBuddy pair, and its accounts are not part of the pool either.
    qoder: {
      regions: activeQoderRegions(),
      distribution: sourceDistribution("qoder"),
      accounts: qoderAccountRows,
      preferred: sourcePreferredMap("qoder"),
      gateways: Array.from(qoderGateways.values()).map((entry) => ({
        region: entry.region,
        port: entry.gateway.port(),
        models: qoderDeclarationModels(entry.region).length,
        portFallback: entry.portFallback,
        preferredPort: entry.preferredPort,
        // The panel reads this for Qoder exactly as it does for Trae, so an
        // unreachable directory has to reach the card here too, not only on the
        // other source.
        lastError: entry.lastError,
        ...sourcePublishedModels("qoder:" + entry.region, entry.gateway.models(), qoderNativeOf),
      })),
    },
    enabled: settings.enabled !== false,
    // Declared but not yet registered by the host: the panel says how to make
    // the model groups appear instead of letting them be silently missing.
    unpublishedDeclarations: unpublishedDeclarations(),
    // The panel marks the ticks this run cannot publish, so it reads the same
    // ceiling the declaration applies instead of remembering a number of its own.
    modelCap: MAX_MODELS,
    distribution: distributionSetting(),
    showComposerPoints: settings.showComposerPoints === true,
    autoCheckin: {
      enabled: autoCheckinEnabled(),
      hours: checkinHours(),
      ...autoCheckinLast === null ? {} : { last: autoCheckinLast },
    },
    // The growth card. The scheduled pass records its growth half inside
    // `autoCheckin.last`, so a standalone run is the only thing this adds; the
    // panel prefers it and falls back to that half, which is why both carry the
    // same shape.
    growth: {
      // A check-in pass runs the growth half itself, so from this card's point of
      // view the accounts are busy either way: entering the tab must not fire a
      // second read at the same accounts while that pass is in flight.
      running: growthPassRunning || checkinPassRunning,
      ...growthLast === null ? {} : { last: growthLast },
      // The last read, so the card paints what it had rather than asking for it
      // again; the panel refreshes it when it is old. The stored copy is the
      // fallback, because this process's own copy starts empty on every launch.
      //
      // The key is always present, `null` included: that is how the panel tells
      // "the host dropped this because the pool changed" from "this document is
      // about something else". An omitted key carried both meanings, and the
      // panel cannot clear on a key that may simply not be published yet.
      read: growthRead,
    },
    // The last by-hand keep-alive pass. There is no schedule behind it, so
    // this is the only record of when the accounts were last refreshed and
    // what that cost.
    keepAlive: keepAliveLast === null ? null : { ...keepAliveLast },
    preferredAccountIds,
    removedAccounts: removedAccounts().map((entry) => ({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label !== "" ? entry.label : entry.id,
      region: entry.region,
    })),
    declaration: runtimeState.write,
    addressDrift: addressDrift(),
    shims: { cn: shimInfo("cn"), global: shimInfo("global") },
    // A gateway whose roster could not be re-read keeps serving the previous
    // list on purpose, but that list is then as old as the last success. Saying
    // so is what keeps the panel from presenting it as current.
    ...catalogWarnings(),
    accounts,
    models,
    selectionByRegion,
    staleSelectionRegions,
  };
}


/** The loopback origin of one gateway, or a not-running marker. */
function shimInfo(region) {
  const runtime = runtimes.get(region);
  try {
    if (!runtime || !runtime.shim) return { running: false };
    const port = runtime.shim.port();
    if (port === 0) return { running: false };
    return { running: true, baseUrl: runtime.shim.baseUrl() + "/v1" };
  } catch {
    return { running: false };
  }
}

/**
 * This plugin's own manifest, parsed once.
 *
 * Every read of `contributes.providers` used to hit the disk: one panel call
 * walked the same file up to six times, on a file this plugin had itself just
 * rewritten, so a read could also land between the `.tmp` write and the rename.
 * This plugin is the only writer, so the parsed copy is kept and dropped only
 * when a write changes it or a read fails.
 */
let manifestCache;
function readManifest() {
  if (manifestCache !== undefined) return manifestCache;
  try {
    manifestCache = JSON.parse(fs.readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));
  } catch {
    // Not cached: a read that failed must be retried, not remembered.
    return undefined;
  }
  return manifestCache;
}

/**
 * The declared window the HOST is holding, per provider and model.
 *
 * The host reads `manifest.json` before this process starts and keeps that copy
 * until its next launch, so the figure it sized a context budget with is the one
 * that was on disk at load - not the one this process has written since. Max mode
 * is gated on this map rather than on the live directory: opening it because the
 * directory grew billed the larger tier for room the host never used, and keeping
 * it shut because a directory function happened to fail sent a prompt sized for a
 * window the upstream then refused.
 *
 * Captured once, at load, and never refreshed by our own writes: refreshing it
 * from `writeDeclaration` would only describe what the host will read next time,
 * which is the thing this map exists to tell apart.
 */
let hostPublishedWindows = null;

function captureHostWindows() {
  // The copy the HOST loaded, not the one on disk. The host reads the manifest
  // before this process starts and writes nothing back, while this process
  // rewrites it at the end of `onLoad` - so the file can already be one generation
  // ahead of what any request is actually being sized against. `getManifest()` is
  // the same accessor the declaration report uses.
  let manifest;
  try {
    manifest = pi.plugin.getManifest();
  } catch {
    manifest = undefined;
  }
  const providers = (manifest?.contributes?.providers) || manifestProviders();
  const map = new Map();
  for (const provider of providers) {
    if (provider === null || typeof provider !== "object" || typeof provider.id !== "string") continue;
    const models = new Map();
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (model === null || typeof model !== "object" || typeof model.id !== "string") continue;
      const window = positiveInteger(model.contextWindow, 0);
      if (window > 0) models.set(model.id, window);
    }
    map.set(provider.id, models);
  }
  hostPublishedWindows = map;
}

/** The window the host holds for one model, or undefined when it holds none. */
function hostWindowOf(providerId, modelId) {
  if (hostPublishedWindows === null) return undefined;
  return hostPublishedWindows.get(providerId)?.get(modelId);
}

function manifestProviders() {
  const manifest = readManifest();
  return (manifest?.contributes?.providers) || [];
}

function declaredProvider(region) {
  return manifestProviders().find((provider) => provider.id === PROVIDER_ID_BY_REGION[region]);
}

/** The published base URL of one Trae/Qoder gateway, by that source's id map. */
function declaredSourceBaseUrl(region, idByRegion) {
  const provider = manifestProviders().find((row) => row.id === idByRegion[region]);
  const baseUrl = provider?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

/**
 * Provider ids this run publishes that the host's own copy of the manifest has
 * never seen.
 *
 * The host builds its provider rows from the manifest it read at startup or at
 * the last enable, while this plugin rewrites `contributes.providers` as
 * accounts appear and models are ticked. Installing or updating while the app
 * is already running therefore leaves the rows absent, which is the whole of
 * "no model group in PI-Desktop": the gateways are up, the manifest names them,
 * the host just has not been told. Naming the delta turns that into the one
 * action that clears it - turn the plugin off and on, or restart the app.
 *
 * An empty result is also the answer when the host does not expose its copy.
 */
function unpublishedDeclarations() {
  let hostIds;
  try {
    const own = pi.plugin.getManifest();
    hostIds = new Set(((own?.contributes?.providers) || []).map((provider) => provider?.id));
  } catch {
    return [];
  }
  return manifestProviders()
    .filter((provider) => !hostIds.has(provider.id))
    .map((provider) => provider.id);
}

function declaredBaseUrl(region) {
  const baseUrl = declaredProvider(region)?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

/**
 * The base URL the host's own copy of the manifest declares for one region.
 *
 * The host builds its provider rows from the manifest it read at startup or at
 * the last enable, so that copy - not this plugin's - is what decides where
 * requests are sent. This plugin drops the row of a gateway that is down; the
 * host keeps serving the address it already has, which is exactly the state the
 * address-drift row exists to name.
 */
function hostDeclaredBaseUrl(region) {
  try {
    const rows = (pi.plugin.getManifest()?.contributes?.providers) || [];
    const row = rows.find((provider) => provider?.id === PROVIDER_ID_BY_REGION[region]);
    return typeof row?.baseUrl === "string" ? row.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Two published addresses, compared as origins.
 *
 * The manifest always publishes the `/v1` form, but what a gateway hands back
 * does not: the WorkBuddy shim's baseUrl() is stored with `/v1` appended, while
 * the Trae and Qoder gateways' baseUrl() is the bare origin main.js keeps for
 * its own `/v1/models` warm-up calls. Comparing those shapes verbatim reports
 * drift for a session that bound the right port on every row, which is how the
 * panel could tell the user to restart the app for hours with nothing to fix.
 * Only the suffix differs, so only the suffix is ignored here.
 */
function samePublishedAddress(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const origin = (value) => value.replace(/\/+$/, "").replace(/\/v1$/, "");
  return origin(a) === origin(b);
}

/**
 * True when the address the manifest publishes is not the address this run
 * bound.
 *
 * That state is exactly `net::ERR_CONNECTION_REFUSED`: the host caches the
 * published address per provider row and only re-reads the manifest on
 * startup, on enable/disable, or on an uninstall (ADR 0259 §9). Detecting it
 * lets the panel name the fix - restarting PI-Desktop - instead of leaving the
 * user with a silent connection failure.
 *
 * A run that fell back to an ephemeral port counts as drift even though the
 * declaration still names the preferred port, because until the plugin is
 * reloaded nothing answers on the published address.
 *
 * A gateway whose start failed counts as drift too, and for the same reason: it
 * has no shim at all, so the address the host cached is refused. Skipping it -
 * which is what the `bound === undefined` case did - reported a healthy panel
 * over a session whose every request failed.
 *
 * Trae and Qoder are read the same way as WorkBuddy. They reserve a preferred
 * port on the same terms, so they drift the same way; leaving them out reported
 * every provider row as healthy while all of them refused connections.
 */
function addressDrift() {
  for (const region of activeRegions()) {
    if (runtimes.get(region)?.portFallback === true) return true;
    const published = declaredBaseUrl(region);
    const bound = shimInfo(region).baseUrl;
    if (bound === undefined) {
      // Reported only once a row for it exists somewhere: a fresh install whose
      // very first start failed has nothing cached to drift from yet.
      if (gatewayStartFailures.has(region)
        && (published !== undefined || hostDeclaredBaseUrl(region) !== undefined)) return true;
      continue;
    }
    if (published !== undefined && published !== bound) return true;
  }
  for (const [source, gateways, idByRegion] of [
    ["trae", traeGateways, TRAE_PROVIDER_ID_BY_REGION],
    ["qoder", qoderGateways, QODER_PROVIDER_ID_BY_REGION],
  ]) {
    // A region whose start failed has no entry to compare, so it gets the same
    // treatment WorkBuddy already gets above: drift, but only once a row for it
    // was ever published.
    for (const region of SOURCE_SPECS[source].activeRegions()) {
      if (!sourceStartFailures.has(sourceKey(source, region))) continue;
      if (declaredSourceBaseUrl(region, idByRegion) !== undefined) return true;
    }
    for (const entry of Array.from(gateways.values())) {
      if (entry.portFallback === true) return true;
      const published = declaredSourceBaseUrl(entry.region, idByRegion);
      if (published !== undefined && !samePublishedAddress(published, entry.baseUrl)) return true;
    }
  }
  return false;
}


/** Trae discovery for the doctor: count only, never token material. */
async function traeDoctorDetail() {
  if (!sourceEnabled("trae")) return { ok: true, detail: "switched off in plugin settings (deliberate; not a failure)" };
  try {
    const found = await discoverTraeCredentials();
    if (found.credentials.length === 0) {
      return { ok: false, detail: "on; no Trae sign-in found (sign in to Trae CN / TRAE SOLO CN, then run the check again)" };
    }
    const byRegion = {};
    for (const credential of found.credentials) {
      const region = traeRegionOfCredential(credential);
      byRegion[region] = (byRegion[region] || 0) + 1;
    }
    const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
    const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable file(s)` : "";
    // What the provider actually publishes, after the user's tick filter:
    // the doctor has to say serving or not, never a stale "not served yet".
    const served = activeTraeRegions()
      .map((region) => `${region}: ${traeDeclarationModels(region).length} model(s)`)
      .join(", ");
    return { ok: true, detail: `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}` };
  } catch (error) {
    // Same rule as the declaration write: an fs error quotes the absolute
    // app-data path it hit, and the report is copyable from the panel.
    return { ok: false, detail: `on; discovery failed (${errorCodeOf(error)})` };
  }
}

/**
 * Why the at-rest keys could not be fetched, or "" when they are fine.
 *
 * The answer comes from `lib/at-rest`, which owns the keys and their failure
 * back-off. It quotes the desktop app's own stderr, so it is redacted and
 * bounded like every other upstream sentence this report carries.
 */
function atRestKeyReason() {
  try {
    return safeMessage(atRestKeyFailure() || "").slice(0, 500);
  } catch (error) {
    return "the at-rest key state could not be read (" + safeMessage(error) + ")";
  }
}

/** Qoder credentials for the doctor: count only, never token material. */
async function qoderDoctorDetail() {
  if (!sourceEnabled("qoder")) return { ok: true, detail: "switched off in plugin settings (deliberate; not a failure)" };
  try {
    const found = await discoverQoderCredentials();
    if (found.credentials.length === 0) {
      const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
      return { ok: false, detail: `on; no Qoder sign-in found (sign in to Qoder, then run the check again)${failures}` };
    }
    const byRegion = {};
    for (const credential of found.credentials) {
      byRegion[credential.region] = (byRegion[credential.region] || 0) + 1;
    }
    const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
    const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
    // Same contract as Trae's: report what is actually served now, not a bare count.
    const served = activeQoderRegions()
      .map((region) => `${region}: ${qoderDeclarationModels(region).length} model(s)`)
      .join(", ");
    return { ok: true, detail: `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}` };
  } catch (error) {
    return { ok: false, detail: `on; discovery failed (${errorCodeOf(error)})` };
  }
}

/** A readable report of everything that has to hold for a chat to reach upstream. */
async function doctorReport() {
  // The check reads both strips' sign-in lists and probes every pool account,
  // so it is capped as a whole like the other wide passes. Findings that did
  // not arrive in time are simply absent from the report rather than making the
  // check itself run past the host's budget.
  const deadline = Date.now() + PANEL_STEP_BUDGET_MS;
  const left = () => Math.max(0, deadline - Date.now());
  // The fallback reads the caches only, but it is still bounded by what is left
  // of the budget: an unbounded second read after a timeout ran the check to
  // twice its budget, and the host cuts a command that overruns it. Whatever
  // did not arrive is simply absent from the report.
  const status = await settleWithin(statusDocument({ allowNetwork: true, budgetMs: left() }), left())
    ?? await settleWithin(statusDocument({ allowNetwork: false, budgetMs: left() }), left())
    ?? { enabled: settings.enabled !== false, sources: {}, accounts: [], models: [] };
  const findings = [];
  const push = (id, ok, detail) => findings.push({ id, ok, detail });

  push("plugin-enabled", status.enabled, status.enabled ? "enabled" : "disabled in plugin settings");
  push("source-workbuddy", true, status.sources.workbuddy === true ? "on" : "switched off in plugin settings (deliberate; not a failure)");
  // Reading a source's sign-ins is the slow part of the check, and each read
  // carries its own bound; the deadline above is what keeps the check whole.
  // The detail functions answer `{ok, detail}`: a source whose sign-ins could
  // not be read is a failed check, not a passed one with a longer sentence.
  const traeDetail = await settleWithin(traeDoctorDetail(), left());
  push("source-trae", traeDetail?.ok ?? false, traeDetail?.detail ?? "on; still reading this source's sign-ins");
  const qoderDetail = await settleWithin(qoderDoctorDetail(), left());
  push("source-qoder", qoderDetail?.ok ?? false, qoderDetail?.detail ?? "on; still reading this source's sign-ins");
  push(
    "accounts",
    status.sources.workbuddy !== true || status.accounts.length > 0,
    status.sources.workbuddy !== true
      ? "WorkBuddy source is switched off; nothing is scanned or served"
      : status.accounts.length === 0
        ? "no WorkBuddy sign-in found; sign in to the desktop app, then detect accounts again"
        : status.accounts.length + " account(s)",
  );
  const healthy = status.accounts.filter((account) => !account.cooling).length;
  push("rotation", status.sources.workbuddy !== true || healthy > 0, status.sources.workbuddy !== true ? "switched off; nothing to rotate" : healthy + " of " + status.accounts.length + " account(s) can serve a request now");

  // The gateways can all be listening and the manifest can name them while the
  // host's own copy predates the declaration, which is what a missing model
  // group looks like from the outside.
  const unpublished = status.unpublishedDeclarations || [];
  push(
    "host-registered-providers",
    unpublished.length === 0,
    unpublished.length === 0
      ? "PI-Desktop lists every provider this plugin declares"
      : unpublished.length + " provider(s) are in the manifest but not in PI-Desktop yet ("
        + unpublished.join(", ") + ") - restart PI-Desktop so the host re-reads the manifest",
  );

  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    const label = PROVIDER_NAME_BY_REGION[region];
    const info = shimInfo(region);
    const regionModels = status.models.filter((model) => model.region === region);
    const declared = declaredProvider(region) !== undefined;
    push(label + ": endpoint", info.running, info.running
      ? "listening on " + info.baseUrl
      : gatewayStartFailures.get(region) ?? "not listening");
    push(label + ": models", regionModels.length > 0, regionModels.length + " model(s) in the catalog");
    push(
      label + ": declared",
      declared,
      declared
        ? "published in this plugin's manifest"
        : runtime?.lastError || runtime?.lastWarning || "this gateway is not published yet",
    );
  }

  // A provider row is written from the manifest the host read at enable time.
  // The host keeps using that address until it next re-reads the manifest -
  // startup, enable/disable, or an uninstall (ADR 0259 §9) - which is exactly
  // what makes requests fail with ERR_CONNECTION_REFUSED when the address the
  // manifest names is not the one this run bound. Comparing the two turns that
  // silent failure into a named finding with the one action that clears it.
  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    const published = declaredBaseUrl(region);
    const bound = runtime?.baseUrl;
    if (published === undefined || bound === undefined) continue;
    const fallback = runtime?.portFallback === true;
    if (published === bound && !fallback) {
      push(
        PROVIDER_NAME_BY_REGION[region] + ": published address",
        true,
        "matches the endpoint this gateway bound (" + bound + ")",
      );
      continue;
    }
    const detail = fallback
      ? "port " + preferredPort(region) + " is held by another process, so this session serves " +
        bound + " - free that port (usually a leftover plugin process), then restart PI-Desktop"
      : "the manifest publishes " + published + " but this gateway is on " + bound +
        " - restart PI-Desktop so the host re-reads the manifest";
    push(PROVIDER_NAME_BY_REGION[region] + ": published address", false, detail);
  }

  // Trae and Qoder reserve a preferred port on the same terms, so they can drift
  // the same way. Reporting only WorkBuddy left every Trae and Qoder provider
  // row broken while the report said everything passed.
  for (const [source, gateways, idByRegion, nameByRegion, ports] of [
    ["trae", traeGateways, TRAE_PROVIDER_ID_BY_REGION, TRAE_PROVIDER_NAME_BY_REGION, TRAE_PORTS],
    ["qoder", qoderGateways, QODER_PROVIDER_ID_BY_REGION, QODER_PROVIDER_NAME_BY_REGION, QODER_PORTS],
  ]) {
    // A gateway that never bound has no entry, and iterating the entries alone
    // reported nothing for it: the report said PASS while every request to the
    // published address was refused.
    for (const region of SOURCE_SPECS[source].activeRegions()) {
      const reason = sourceStartFailures.get(sourceKey(source, region));
      if (reason === undefined) continue;
      push(nameByRegion[region] + ": endpoint", false, reason);
    }
    for (const entry of Array.from(gateways.values())) {
      const published = declaredSourceBaseUrl(entry.region, idByRegion);
      const bound = entry.baseUrl;
      const label = nameByRegion[entry.region];
      if (published === undefined || bound === undefined) continue;
      const fallback = entry.portFallback === true;
      if (samePublishedAddress(published, bound) && !fallback) {
        push(label + ": published address", true, "matches the endpoint this gateway bound (" + bound + ")");
        continue;
      }
      const detail = fallback
        ? "port " + ports[entry.region] + " is held by another process, so this session serves " +
          bound + " - free that port (usually a leftover plugin process), then restart PI-Desktop"
        : "the manifest publishes " + published + " but this gateway is on " + bound +
          " - restart PI-Desktop so the host re-reads the manifest";
      push(label + ": published address", false, detail);
    }
  }

  // A 5.6+ sealed sign-in reads from the outside as "no WorkBuddy credential":
  // the keys that open it could not be fetched, which is a different fault from
  // not being signed in at all. Reported on its own row so the two can be told
  // apart, and only while the source is on - a switched-off source never fetched
  // a key, and a stale failure would read as a fresh one. A passing row is
  // written as well, so the report says the check ran rather than leaving its
  // absence ambiguous. The id matches the DeepSeek Harness build, so a report
  // copied out of either panel reads the same.
  if (sourceEnabled("workbuddy")) {
    const atRest = atRestKeyReason();
    push("at-rest-key", atRest === "", atRest === "" ? "no at-rest key failure" : atRest);
  }

  push(
    "declaration-written",
    runtimeState.write.ok === true,
    // No path in the text: the report is copyable from the panel, and where
    // this plugin is installed is not something a report needs to carry.
    runtimeState.write.ok !== true
      ? safeMessage(runtimeState.write.error)
      : runtimeState.write.changed
        ? "the model list was just updated; the host discovers it from this gateway's /v1/models"
        : String(runtimeState.write.skipped || "up to date"),
  );

  const ok = findings.every((finding) => finding.ok);
  const report = [
    "WTQ Pool doctor",
    new Date().toISOString(),
    "overall: " + (ok ? "PASS" : "FAIL"),
    "",
    ...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
    "",
  ].join("\n");
  if (dataPath !== "") {
    try {
      fs.writeFileSync(path.join(dataPath, "doctor.txt"), report, "utf8");
    } catch {
      // A report that cannot be written to disk is still a report: the panel
      // shows and copies it either way.
    }
  }
  return { ok, findings, report, status };
}

/**
 * Run the connection check, answering with a report even when it fails.
 *
 * A check that threw used to take the whole channel down with it: the panel
 * showed a generic error and there was no report to read, which says "the
 * check is broken" rather than "the check found something it could not read".
 * The failure is now a finding like any other.
 */
async function doctor() {
  try {
    return await doctorReport();
  } catch (error) {
    const detail = safeMessage(error);
    log("warn", "connection check failed: " + detail);
    const findings = [{ id: "status", ok: false, detail }];
    const report = [
      "WTQ Pool doctor",
      new Date().toISOString(),
      "overall: FAIL",
      "",
      ...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
      "",
    ].join("\n");
    return { ok: false, findings, report, status: undefined };
  }
}

// -------------------------------------------------------------------- panel

/**
 * Logins the panel has started and not finished, keyed by realm.
 *
 * One per realm on purpose: a second start for the same realm replaces the
 * first, and the replaced state is dead — a browser is sitting on a URL nobody
 * polls. Memory only, and cleared in `onUnload`: a reload then drops them and the
 * panel starts over rather than answering a poll for a state this process never
 * issued. Leaving them in place across a reload let a poll complete a sign-in
 * from a login the previous activation had started.
 */
const deviceLogins = new Map();

function panelError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate an untrusted selection payload.
 *
 * Returns undefined for anything malformed so nothing partial is written. An
 * empty array is meaningful (`enabledModelIds: []` disables every model, which
 * the panel refuses to save) so it is preserved rather than treated as absent.
 */
function parseSelection(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const out = {};
  const enabled = body.enabledModelIds;
  if (enabled !== undefined) {
    if (!Array.isArray(enabled)) return undefined;
    const ids = [];
    for (const entry of enabled) {
      if (typeof entry !== "string" || entry === "") return undefined;
      // The declaration caps an id at 256 characters, so a longer one can only
      // be junk: storing it would write an unroutable name into settings.json.
      if (entry.length > MAX_MODEL_ID_LENGTH) return undefined;
      ids.push(entry);
    }
    // The payload is untrusted and this list is written to settings.json, so it
    // is capped: a gateway publishes at most MAX_MODELS rows, and an id beyond
    // the cap can only be a stale name the roster no longer carries.
    out.enabledModelIds = ids.slice(0, MAX_STORED_MODEL_IDS);
  }
  const overrides = body.overrides;
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return undefined;
    // Null prototype: `map["__proto__"] = …` on a plain object assigns the
    // prototype instead of the entry, so that id reported a successful save and
    // stored nothing.
    const map = Object.create(null);
    let stored = 0;
    for (const [id, raw] of Object.entries(overrides)) {
      if (typeof id !== "string" || id === "") return undefined;
      // The same bounds the id list above takes: this map is written to
      // settings.json too, and neither a long key nor a long list of them can
      // match a model the roster carries. Counted as entries are stored rather
      // than by rebuilding the key list on every iteration.
      if (id.length > MAX_MODEL_ID_LENGTH) return undefined;
      if (stored >= MAX_STORED_MODEL_IDS) return undefined;
      const parsed = parseOverride(raw);
      if (parsed === undefined) return undefined;
      // A field left at its catalog value is stored as absent, so the settings
      // file records only what the user actually changed.
      if (Object.keys(parsed).length > 0) {
        map[id] = parsed;
        stored += 1;
      }
    }
    out.overrides = map;
  }
  return out;
}

/**
 * Validate one model's override.
 *
 * Every field is optional, and a value that is present must be usable: the host
 * rejects a zero window, and a thinking level outside the host's ladder would be
 * dropped there anyway. Rejecting here means the panel reports a failure instead
 * of a save that quietly did nothing.
 */
function parseOverride(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out = {};
  if (raw.alias !== undefined) {
    if (typeof raw.alias !== "string") return undefined;
    const alias = raw.alias.trim();
    if (alias.length > 120) return undefined;
    out.alias = alias;
  }
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_TOKEN_BUDGET) return undefined;
    out[key] = value;
  }
  if (raw.supportsImages !== undefined) {
    if (typeof raw.supportsImages !== "boolean") return undefined;
    out.supportsImages = raw.supportsImages;
  }
  if (raw.thinkingLevels !== undefined) {
    if (!Array.isArray(raw.thinkingLevels)) return undefined;
    const levels = [];
    for (const level of raw.thinkingLevels) {
      if (typeof level !== "string" || !HOST_THINKING_LEVELS.includes(level)) return undefined;
      if (!levels.includes(level)) levels.push(level);
    }
    if (levels.length > 0) out.thinkingLevels = levels;
  }
  if (raw.defaultThinkingLevel !== undefined) {
    if (typeof raw.defaultThinkingLevel !== "string") return undefined;
    if (!HOST_THINKING_LEVELS.includes(raw.defaultThinkingLevel)) return undefined;
    out.defaultThinkingLevel = raw.defaultThinkingLevel;
  }
  return out;
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    /**
     * Opening the panel.
     *
     * The old implementation ran the whole detection pass inline - a model
     * roster fetch per gateway plus two billing calls per account - before it
     * could answer, so the panel stayed blank for seconds every time it opened.
     * Now the cached document is returned immediately and the detection runs
     * behind it; `refreshing` tells the panel to ask again shortly. `wait: true`
     * (the Refresh button) still resolves on a fully refreshed document.
     */
    case "xd.state": {
      if (payload?.wait === true) {
        const refreshed = await refreshAll("panel", true);
        // A pass retired by a reload answers with `stale`: the click would
        // otherwise clear the busy state and the banner while showing the
        // document from before the reload.
        if (refreshed.stale === true) {
          return { ...await statusDocument({ allowNetwork: false }), refreshing: false, stale: true };
        }
        return { ...refreshed, refreshing: false };
      }
      const document = await statusDocument({ allowNetwork: false });
      const refreshing = refreshNeeded();
      if (refreshing) scheduleRefresh("panel");
      return { ...document, refreshing };
    }

    /**
     * Re-read the WorkBuddy rosters for the panel, and nothing else.
     *
     * The panel asks for this as it opens and when its model page is shown. A
     * roster read that timed out while the host was starting leaves the static
     * fallback in force, and the model page then listed the fallback's own
     * models and told the user every model they had chosen was retired - on
     * every start, for as long as the live read kept failing. This forces one
     * read per gateway (the same read `xd.rescan` does for its rosters) without
     * the account scan and gateway reconciliation that make a full rescan too
     * heavy to run on every panel open.
     */
    case "xd.fetchModels": {
      await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
        try {
          await refreshRuntime(runtime, "fetch-models", true);
        } catch (error) {
          runtime.lastError = safeMessage(error);
        }
      })), LOAD_ROSTER_BUDGET_MS);
      syncDeclaration();
      // Carries the real refresh state: the panel adopts this document and stops
      // its polling unless the flag is set, so answering without one ended the
      // background refresh for the rest of the session. The panel then sat on a
      // cache taken before the roster read and stopped following cooldowns,
      // credits and check-in figures until the user pressed refresh by hand.
      return { ...await statusDocument({ allowNetwork: false }), refreshing: refreshNeeded() };
    }

    /**
     * "Detect accounts again": a deliberate, user-invoked re-read, so every
     * gateway's roster is refetched even inside its refresh window.
     */
    case "xd.rescan": {
      // One deadline for the whole re-read, because it is the widest pass the
      // panel can ask for: a scan, both strips' sign-ins, every roster and the
      // document. Each part keeps its own bound; this one keeps their sum
      // inside the host's 30 s and still answers from what has arrived.
      const deadline = Date.now() + RESCAN_BUDGET_MS;
      const left = () => Math.max(0, deadline - Date.now());
      // The scan and the gateway starts sit inside the same deadline: a scan
      // may refresh tokens over the network, and a gateway's `ready` is
      // unbounded, so without this a slow disk or vendor could spend the whole
      // pass before the first roster read even starts. A step that outruns the
      // deadline keeps running behind the answer and lands on the next read.
      // A deliberate re-read must not be answered from the discovery cache: a
      // sign-in made while the panel was open is exactly what it is looking for.
      // Cleared before the scan rather than after, so the scan that runs next is
      // the one that reads the vendor directories afresh.
      resetDiscoveryCaches();
      // A rescan can pick up an account nobody had seen, or retire one whose
      // sign-in file is gone, so any held read describes the pool as it was.
      dropGrowthRead();
      if (activeRegions().length > 0) await settleWithin(core.pool.scan(), left());
      await settleWithin(startRuntimes(), left());
      // Trae/Qoder sign-ins live in their own app files, so a deliberate scan
      // re-reads them to pick up logins made while the panel was open.
      await settleWithin(refreshSourceAccounts(), left());
      // Concurrent, as in the refresh pass: end to end, two rosters read can
      // spend a whole panel call on their own.
      await settleWithin(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, "rescan", true))), left());
      syncDeclaration();
      return await statusDocument({ allowNetwork: true, budgetMs: left() });
    }

    case "xd.resetCooldowns":
      core.pool.resetCooldowns();
      // A pool cooldown and a source hold are the same refusal from the user's
      // side: one account cooling and one whole upstream cooling. Clearing only
      // the first left the button reporting success while requests kept failing.
      sourceFailureHold.clear();
      return await statusDocument({ allowNetwork: false });

    case "xd.checkin": {
      const accountId = typeof payload?.accountId === "string" ? payload.accountId : "";
      if (accountId === "") throw panelError("accountId is required", "INVALID");
      const account = core.pool.list().find((item) => item.id === accountId);
      if (account === undefined) throw panelError("unknown account", "NOT_FOUND");
      if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) throw panelError("this source region is disabled", "INACTIVE");
      // One pass at a time, the same flag the scheduled pass and the pool's own
      // button use: a click landing beside a running pass claimed an account the
      // pass was about to reach, and the two rounds' results overwrote each
      // other's record of what today collected. A growth run walks the same
      // accounts, so it counts as a pass too.
      if (checkinPassRunning || growthPassRunning) throw panelError("a check-in or growth pass is already running; wait for it to finish", "BUSY");
      // Taking the flag, not only reading it. Reading it alone guarded a claim that
      // arrives after a pass has started and left the other order open: a scheduled
      // tick or "run now" landing between this claim's status read and its write
      // walked the same account at the same time. Nothing is paid twice, because
      // every claim re-reads today's state first, but the second round then reports
      // a failure for an account that was already collected.
      const token = ++checkinPassToken;
      checkinPassRunning = true;
      // The two reads inside carry their own 30 s bound each, which is a whole
      // panel budget apiece; the step is capped as a whole instead and says so
      // when it runs out rather than leaving the button spinning.
       const work = async () => {
         // Wrapped like the batch pass: a refused sign-in gets its one forced
         // refresh here too, because the claim below is the mutation that would
         // otherwise be lost for the day.
         const before = await core.pool.readAfterRefresh(account.id, (credential) =>
           core.client.fetchCheckinStatus(credential));
        if (before.todayCheckedIn) {
          probeCache.delete(accountId);
          return {
            state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }),
            result: { credit: 0, streakDays: before.streakDays, isStreakDay: before.isStreakDay },
          };
        }
        if (!before.active) throw panelError("check-in is not available for this account", "INACTIVE");
        const claim = await core.client.claimDailyCheckin(account.credential);
        // The claim changed this account's balance, so its cached probe is stale.
        probeCache.delete(accountId);
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), result: claim };
      };
      const answered = await settleWithin(work(), PANEL_STEP_BUDGET_MS).finally(() => {
        // The same ownership rule the passes use: a newer run keeps the guard.
        if (token === checkinPassToken) checkinPassRunning = false;
      });
      if (answered === undefined) throw panelError("the check-in did not finish in time; try again", "TIMEOUT");
      return answered;
    }

    /**
     * Save the model selection for one gateway.
     *
     * The write result is checked rather than assumed: reporting success while
     * nothing was stored is exactly how "saving does nothing" presents itself.
     * The selection is applied to the catalog and republished before answering,
     * so the panel reflects what will be in force from now on.
     */
    case "xd.saveModels": {
      // Gateway keys: "cn"/"global" are the WorkBuddy pool's two, the rest are
      // one per Trae/Qoder region. The WorkBuddy keys keep their old spelling
      // so a settings file written by an earlier version still resolves.
      const requested = typeof payload?.gateway === "string" ? payload.gateway
        : typeof payload?.region === "string" ? payload.region : "";
      if (!/^(cn|global|trae:cn|trae:ai|qoder:cn|qoder:global)$/.test(requested)) {
        throw panelError("unknown gateway", "INVALID");
      }
      const selection = parseSelection(payload?.selection);
      if (selection === undefined) throw panelError("invalid selection payload", "INVALID");
      const stored = await mutateSettings("modelSelection", (current) => {
        const all = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        all[requested] = selection;
        return all;
      });
      if (stored !== true) {
        throw panelError("the selection could not be written to the plugin settings file", "SAVE_FAILED");
      }
      if (requested === "cn" || requested === "global") applyEffectiveSelection(requested);
      syncDeclaration();
      return await statusDocument({ allowNetwork: false });
    }

    case "xd.preferAccount": {
      const region = payload?.region;
      const accountId = payload?.accountId;
      if (!REGIONS.includes(region) || typeof accountId !== "string") {
        throw panelError("region and accountId are required", "INVALID");
      }
      if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) {
        throw panelError("account does not belong to this region", "NOT_FOUND");
      }
      const stored = await mutateSettings("preferredAccountIds", (current) => {
        const next = {};
        for (const key of REGIONS) {
          const held = current && typeof current === "object" && !Array.isArray(current) ? current[key] : undefined;
          if (typeof held === "string" && held !== "") next[key] = held;
        }
        if (accountId === "") delete next[region];
        else next[region] = accountId;
        return next;
      });
      if (stored !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
      core.pool.prefer(accountId || undefined, region);
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * One channel for the two per-account decisions: "not right now" (switched
     * off, still listed, one click from coming back) and "not mine any more"
     * (removed, and a rescan will not bring it back).
     */
    case "xd.setAccountState": {
      const region = payload?.region;
      const accountId = payload?.accountId;
      const state = payload?.state;
      const states = ["enabled", "disabled", "removed", "restored", "deleted"];
      if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "" || !states.includes(state)) {
        throw panelError("region, accountId and a known state are required", "INVALID");
      }
      const account = core.pool.list(region).find((item) => item.id === accountId);
      const stored = removedAccounts().find((entry) => entry.id === accountId);
      if (state !== "restored" && account === undefined && stored === undefined) {
        throw panelError("account does not belong to this gateway", "NOT_FOUND");
      }

      // Deleting is not a settings change: it removes the sign-in file the
      // plugin itself wrote, so there is nothing left to restore and nothing to
      // record. It has to leave the pool here rather than on the next scan, or
      // the document answered below still lists an account that is gone.
      if (state === "deleted") {
        if (!core.pool.ownsSignIn(accountId)) {
          throw panelError("only an account added from this panel can be deleted", "NOT_OWN");
        }
        const deleted = await core.pool.removeOwnSignIn(accountId);
        if (deleted !== true) {
          throw panelError("the sign-in file could not be removed", "DELETE_FAILED");
        }
        await settleWithin(core.pool.scan(), POOL_SCAN_BUDGET_MS);
        // The account id is a hash of its identity, so signing the same account in
        // again produces the same id. Anything still recorded against it would come
        // back with the new sign-in: a deleted-then-re-added account arrived already
        // switched off, or parked behind an old credit floor, with the panel offering
        // no reason for either.
        const forgotten = await mutateSettings("disabledAccountIds", (current) => {
          const known = Array.isArray(current) ? current.filter((id) => typeof id === "string") : [];
          return known.filter((id) => id !== accountId);
        });
        if (forgotten !== true) log("warn", "could not clear the disabled state for " + accountId);
        const reserveCleared = await mutateSettings("creditReserves", (current) => {
          const known = current && typeof current === "object" && !Array.isArray(current) ? current : {};
          const next = { ...known };
          delete next[accountId];
          return next;
        });
        if (reserveCleared !== true) log("warn", "could not clear the credit reserve for " + accountId);
        // The settings were the durable half; the pool keeps its own copy of both,
        // and a delete that only cleared the file left that copy to re-disable the
        // account the moment it was signed in again.
        core.pool.applyConfig({ disabledAccountIds: disabledAccountIds(), creditReserves: creditReserves() });
        // The delete path returns here rather than falling through to the cleanup
        // below, so the same cleanup has to run on this path too: a removed id
        // left in `preferredAccountIds` kept the panel rendering an "unavailable"
        // choice as the selected account until the user picked Automatic.
        if (preferredAccountId(region) === accountId) {
          const cleared = await mutateSettings("preferredAccountIds", (current) => {
            const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
            delete next[region];
            return next;
          });
          if (cleared !== true) log("warn", "could not clear the preferred account for " + region);
          core.pool.prefer(undefined, region);
        }
        dropGrowthRead();
        return await statusDocument({ allowNetwork: false });
      }

      const written = await mutateSettings("disabledAccountIds", (current) => {
        const known = Array.isArray(current) ? current.filter((id) => typeof id === "string") : [];
        const next = known.filter((id) => id !== accountId);
        if (state === "disabled") next.push(accountId);
        return next;
      });
      if (written !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
      const recorded = await mutateSettings("removedAccounts", (current) => {
        const known = Array.isArray(current)
          ? current.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
          : [];
        const next = known.filter((entry) => entry.id !== accountId);
        if (state === "removed") {
          next.push({
            id: accountId,
            label: account === undefined ? stored.label : account.label,
            region,
          });
        }
        return next;
      });
      if (recorded !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
      const disabled = disabledAccountIds();
      const removed = removedAccounts();
      core.pool.applyConfig({ disabledAccountIds: disabled });
      core.pool.applyRemoved(removed.map((entry) => entry.id));
      // An account that is switched off or gone must not stay the preferred
      // one: the pool would keep asking for an id it cannot hand out.
      if (accountId !== "" && preferredAccountId(region) === accountId && state !== "enabled" && state !== "restored") {
        // Inside the write queue, like the two writes above: this dictionary is
        // read and written whole, and a whole-dictionary write computed from a
        // snapshot taken before the queue used to drop a choice another action
        // had saved in between.
        const cleared = await mutateSettings("preferredAccountIds", (current) => {
          const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
          delete next[region];
          return next;
        });
        if (cleared !== true) log("warn", "could not clear the preferred account for " + region);
        core.pool.prefer(undefined, region);
      }
      // The read describes the accounts that were collectable when it ran. An
      // account switched off or removed since then is not part of the next read,
      // so the rows in hand no longer describe this pool.
      dropGrowthRead();
      return await statusDocument({ allowNetwork: false });
    }

    /** The credits to keep back on one account: 0 clears the floor. */
    case "xd.setCreditReserve": {
      const region = payload?.region;
      const accountId = payload?.accountId;
      const reserve = Number(payload?.reserve);
      if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "") {
        throw panelError("region and accountId are required", "INVALID");
      }
      if (!Number.isFinite(reserve) || reserve < 0 || reserve > MAX_CREDIT_RESERVE) {
        throw panelError("reserve must be a number of credits between 0 and " + MAX_CREDIT_RESERVE, "INVALID");
      }
      if (!core.pool.list(region).some((account) => account.id === accountId)) {
        throw panelError("account does not belong to this gateway", "NOT_FOUND");
      }
      const written = await mutateSettings("creditReserves", (current) => {
        const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        if (reserve === 0) delete next[accountId];
        else next[accountId] = Math.floor(reserve);
        return next;
      });
      if (written !== true) throw panelError("the reserve could not be saved", "SAVE_FAILED");
      core.pool.applyConfig({ creditReserves: creditReserves() });
      // The account may have just become unusable or usable again: say so on the
      // next document instead of leaving a stale "next up".
      return await statusDocument({ allowNetwork: false });
    }

    /** One click for every account's daily reward.
     *  With `source`, only that source's pool runs — each source has its own
     *  check-in pool in the panel, so one button must not sweep the others. */
    case "xd.checkinAll": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      // A name no worker answers would otherwise run a pass that collected
      // nothing and then record it as the last run: the panel would show an
      // all-zero log row for a button nobody pressed.
      if (!["", "workbuddy", "trae", "qoder"].includes(source)) {
        throw panelError("source must be workbuddy, trae or qoder", "INVALID");
      }
      // One pass, one implementation: this channel only narrows it to one source
      // and reshapes the answer. A second copy of the fan-out here had already
      // drifted - it skipped the pause before the growth burst and never recorded
      // itself in `autoCheckinLast`, so the panel's "last run" stayed on the
      // previous pass while the upstream saw two request clusters back to back.
      const finished = runCheckinPass({ manual: true, only: source });
      const counts = await settleWithin(finished, CHECKIN_BUDGET_MS);
      if (counts === undefined) {
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), running: true };
      }
      if (counts.running === true || counts.stale === true) {
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), running: true };
      }
      if (counts.error !== undefined) throw panelError(counts.error, "UPSTREAM");
      return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), ...counts };
    }

    /**
     * Claim ONE Trae or Qoder account's daily reward.
     *
     * The label and region are the pair the panel's row was built from, so a
     * stale row cannot claim a different account; the claim itself re-reads
     * status first, which is what keeps a double click from collecting twice.
     */
    case "xd.sourceCheckin": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const label = typeof payload?.label === "string" ? payload.label : "";
      const region = typeof payload?.region === "string" ? payload.region : "";
      if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
      if (label === "" || region === "") throw panelError("label and region are required", "INVALID");
      if (!regionEnabled(source, region)) throw panelError("this source region is disabled", "INACTIVE");
      // One pass at a time: a single claim landing beside a running pass collects
      // an account that pass is about to reach, and both write today's record.
      // The growth run is a pass over the same accounts.
      if (checkinPassRunning || growthPassRunning) throw panelError("a check-in or growth pass is already running; wait for it to finish", "BUSY");
      // Taken, not only read, for the reason the pool's single claim states.
      const token = ++checkinPassToken;
      checkinPassRunning = true;
      // Capped as a whole, like the pool's own check-in: the claim re-reads the
      // status first and each read carries a 30 s bound of its own.
      const answered = await settleWithin((async () => {
        const outcome = source === "trae" ? await traeClaimOne(label, region) : await qoderClaimOne(label, region);
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), result: outcome };
      })(), PANEL_STEP_BUDGET_MS).finally(() => {
        if (token === checkinPassToken) checkinPassRunning = false;
      });
      if (answered === undefined) throw panelError("the check-in did not finish in time; try again", "TIMEOUT");
      return answered;
    }


    /**
     * Pick which of a source's accounts serves its region.
     *
     * The label is the same one the panel's row was built from, and the
     * gateways re-read their credentials on every request, so this takes effect
     * from the next request on without restarting anything.
     */
    case "xd.preferSourceAccount": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const region = typeof payload?.region === "string" ? payload.region : "";
      const label = typeof payload?.label === "string" ? payload.label : "";
      if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
      if (!(source === "trae" ? TRAE_REGIONS : QODER_REGIONS).includes(region)) {
        throw panelError("unknown region for this source", "INVALID");
      }
      if (!sourceAccountMayBePreferred(source, region, label)) {
        throw panelError("that account is not available for this source", "INVALID");
      }
      const stored = await mutateSettings("preferredSourceAccounts", (current) => {
        const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        if (label === "") delete next[sourceRegionKey(source, region)];
        else next[sourceRegionKey(source, region)] = label;
        return next;
      });
      if (stored !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
      return await statusDocument({ allowNetwork: false });
    }
    case "xd.distribution": {
      const requested = payload?.distribution;
      const next = WORKBUDDY_DISTRIBUTIONS.includes(requested) ? requested : "priority";
      const stored = await saveSettings({ distribution: next });
      if (stored !== true) {
        throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
      }
      core.pool.applyConfig({ distribution: next });
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * The usage mode of one Trae/Qoder source. WorkBuddy's own mode is handled
     * above by the pool; a source gateway has no pool, it reads an ordered
     * credential list per request, so the mode is only a setting here.
     */
    case "xd.sourceDistribution": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
      const mode = SOURCE_DISTRIBUTIONS.includes(payload?.distribution) ? payload.distribution : "priority";
      const stored = await mutateSettings("sourceDistributions", (current) => {
        const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        next[source] = mode;
        return next;
      });
      if (stored !== true) {
        throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
      }
      return await statusDocument({ allowNetwork: false });
    }

    /** Switch the daily automatic check-in on or off, and set its hours. */
    case "xd.setAutoCheckin": {
      const hours = normaliseCheckinHours(Array.isArray(payload?.hours) ? payload.hours : []);
      const stored = await saveSettings({ autoCheckin: { enabled: payload?.enabled === true, hours } });
      if (stored !== true) {
        throw panelError("the automatic check-in setting could not be written to the plugin settings file", "SAVE_FAILED");
      }
      applyAutoCheckin();
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Refresh every eligible account's token, by hand.
     *
     * There is no schedule behind this: the panel's button is the only thing
     * that runs it, which is what the user asked for. The pass itself is the
     * same one the check-in card's other controls use — `ensureFresh` decides
     * per account whether an upstream call is needed — so a token that still
     * has hours on it costs nothing and an international token that lives a
     * year is never touched.
     *
     * Bounded like every other network pass here: Trae alone spaces its
     * accounts, and a pass that outruns the budget records itself in the
     * document instead of leaving the button spinning.
     */
    case "xd.keepAlive": {
      await settleWithin(runKeepAlivePass(), REFRESH_PASS_BUDGET_MS);
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Run the daily pass now, by hand.
     *
     * The scheduled pass is silent by nature: it fires at an hour nobody is
     * watching, so a user who set 11:00 had nothing to look at and no way to
     * check the setting had taken. This runs exactly what the scheduler runs and
     * records it in the same place, so the panel's "last run" line answers for
     * both — and a user can see the result of a manual run immediately.
     *
     * Bounded like every other network pass here: Trae alone spaces its accounts
     * five seconds apart, so ten of them is a minute, and the host cuts a panel
     * call off well before that. So the pass starts now, the call answers with
     * whatever the budget allows, and a pass still running lands in the same
     * `autoCheckinLast` when it finishes — the panel picks it up on its next
     * refresh instead of the result being lost to a truncated call.
     */
    case "xd.runCheckinNow": {
      const pass = runCheckinPass({ manual: true });
      await settleWithin(pass, REFRESH_PASS_BUDGET_MS);
      return await statusDocument({ allowNetwork: false });
    }

    case "xd.setComposerPoints": {
      const stored = await saveSettings({ showComposerPoints: payload?.enabled === true });
      if (stored !== true) {
        throw panelError("the composer credits setting could not be written to the plugin settings file", "SAVE_FAILED");
      }
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Park or unpark one edition of one source (国内版 / 国际版).
     *
     * Same shape as the source switch above: a parked region keeps no gateway,
     * no scan and no provider row, and unparking waits for a real refresh so
     * the panel comes back with that region's accounts and models.
     */
    case "xd.setRegionEnabled": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const region = typeof payload?.region === "string" ? payload.region : "";
      const known = source === "trae" ? TRAE_REGIONS : source === "qoder" ? QODER_REGIONS : source === "workbuddy" ? REGIONS : undefined;
      if (known === undefined || !known.includes(region)) throw panelError("unknown source region", "INVALID");
      const key = sourceRegionKey(source, region);
      const stored = await mutateSettings("disabledRegions", (current) => {
        const known = Array.isArray(current) ? current.filter((entry) => typeof entry === "string") : [];
        const parked = known.filter((entry) => entry !== key);
        if (payload?.enabled !== true) parked.push(key);
        return parked;
      });
      if (stored !== true) {
        throw panelError("the region switch could not be written to the plugin settings file", "SAVE_FAILED");
      }
      await onHostSettingsChanged({});
      if (payload?.enabled === true) await refreshAll("region-on", true);
      else syncDeclaration();
      // The growth rows are per account and a parked region's accounts are not
      // part of the next read, so the cached answer no longer describes the pool.
      if (source === "workbuddy") dropGrowthRead();
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Switch one source on or off from the panel.
     *
     * Same settings key the host's own settings dialog writes, so the switch
     * state is shared: whichever surface changes it, the next document says the
     * same thing. Turning a source on waits for a real refresh so the panel
     * comes back with its gateways and accounts, not an empty strip.
     */
    case "xd.setSource": {
      const key = sourceSettingKey(payload?.source);
      if (key === undefined) throw panelError("unknown source", "UNSUPPORTED");
      const stored = await saveSettings({ [key]: payload?.enabled === true });
      if (stored !== true) {
        throw panelError("the source switch could not be written to the plugin settings file", "SAVE_FAILED");
      }
      // The sign-in list was read while this source was off; switching it on must
      // not be answered from that read.
      resetDiscoveryCaches();
      // Settings drive everything downstream: reconcile the gateways, re-apply
      // the timers and republish, exactly as a host-driven change would.
      await onHostSettingsChanged({});
      if (payload?.enabled === true) await refreshAll("source-on", true);
      else syncDeclaration();
      // Same reason as the region switch: the growth card lists WorkBuddy
      // accounts, and this switch decides whether there are any.
      if (payload?.source === "workbuddy") dropGrowthRead();
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Start a panel login and answer the URL to open.
     *
     * The URL is handed back rather than opened from here: the panel owns the
     * click, and it opens it through `shell.openExternal` the same way it opens
     * every other external address.
     */
    case "xd.startLogin": {
      const realm = payload?.realm === "global" ? "global" : "cn";
      const start = await startDeviceLogin(realm);
      deviceLogins.set(realm, { state: start.state, at: Date.now() });
      return { realm, authUrl: start.authUrl };
    }

    /**
     * Poll the login the panel started on this realm.
     *
     * A finished login is written as one of the plugin's own `.info` files and
     * the pool is rescanned, so the account appears in the panel and the
     * provider row without a reload. The second sign-in for an account already
     * present lands in a directory the pool already reads, so the directory set
     * does not change and `applyConfig` would not notice it: the scan is
     * explicit for that reason.
     */
    case "xd.pollLogin": {
      const realm = payload?.realm === "global" ? "global" : "cn";
      const pending = deviceLogins.get(realm);
      if (pending === undefined) throw panelError("no login is waiting on this realm", "NO_LOGIN");
      if (Date.now() - pending.at > DEVICE_LOGIN_TTL_MS) {
        deviceLogins.delete(realm);
        throw panelError("the login link has expired; start again", "LOGIN_EXPIRED");
      }
      const answer = await pollDeviceLogin(realm, pending.state);
      if (answer.status !== "ok") return { status: "pending" };
      deviceLogins.delete(realm);
      const directory = ownSignInDir(dataPath);
      if (directory === "") {
        throw panelError("no plugin data directory to write the sign-in into", "NO_DATA_DIR");
      }
      await writeOwnSignIn(directory, answer.signIn);
      // A new account is not in a read taken before it landed.
      dropGrowthRead();
      await settleWithin(core.pool.scan(), POOL_SCAN_BUDGET_MS);
      await refreshAll("panel-login", false);
      // The fresh document rides the answer. The panel adopts whatever a
      // channel hands back, and a login that answered with a name and nothing
      // else left the list painting the pool as it was before the account
      // landed: the user read "added" and saw no new row, which reads as a
      // failed add. The read is local, so it costs no request.
      return {
        status: "ok",
        nickname: answer.signIn.nickname,
        region: answer.signIn.region,
        state: await statusDocument({ allowNetwork: false }),
      };
    }

    /**
     * What the growth centre holds, claiming nothing.
     *
     * Read-only because two of the four steps are not idempotent: a make-up
     * card and a lottery draw are spent by running them. Showing the state
     * first is what lets the panel say "2 cards, yesterday missed" before the
     * user decides, rather than spending one and reporting it afterwards.
     */
    case "xd.growthState": {
      const epoch = growthReadEpoch;
      const answered = await settleWithin(readGrowthState(), PANEL_STEP_BUDGET_MS);
      if (answered === undefined) throw panelError("the growth state did not finish in time; try again", "TIMEOUT");
      // The pool changed while this read ran, so what it answered describes the
      // pool as it was. Answering the panel is fine - the user asked - but storing
      // it would resurrect the rows the change just dropped.
      if (epoch !== growthReadEpoch) return { growth: { ...answered, readAt: Date.now() } };
      // Kept for the next paint: the panel would otherwise ask the user to read
      // the same figures again after every repaint.
      growthRead = { ...answered, readAt: Date.now() };
      // The panel keeps this answer as its draft, so the timestamp travels with
      // it: without one the card would read its own fresh result as stale.
      return { growth: growthRead };
    }

    /**
     * Run the growth centre on its own, without the daily check-in.
     *
     * The scheduled pass runs it as its third stage, so this is the same code
     * with the same pacing and the same abort signal - not a second, smaller
     * copy of it. Refused beside a check-in pass rather than queued: both walk
     * the same accounts, and two unpaced clusters on one account is what the
     * upstream reads as a burst.
     */
    case "xd.growthRun": {
      if (serviceStopped) {
        return { state: await statusDocument({ allowNetwork: false }), running: true };
      }
      if (growthPassRunning || checkinPassRunning) {
        return { state: await statusDocument({ allowNetwork: false }), running: true };
      }
      growthPassRunning = true;
      // The run that owns the flag. A reload hands the flag to whatever the new
      // activation starts, and a stale run clearing it here would un-guard that
      // newer run; a stale run with nothing newer behind it still clears it, so a
      // run that outlived its activation cannot lock the card for good.
      const token = ++growthPassToken;
      // A run started after the service stopped gets a fresh signal: the stop
      // retired the run that was in flight then, not the ones still to come.
      // Without this re-arm every account here breaks out of its loop on the
      // inherited signal at once and the empty result is recorded as a finished
      // run - "0 tier(s), +0" for a pass that never asked.
      checkinAbort.abort();
      checkinAbort = new AbortController();
      checkinScope.enterWith(checkinAbort.signal);
      const generation = loadGeneration;
      const finished = (async () => {
        try {
          const counts = await claimAllGrowth();
          // Recorded here, not by the caller: a pass that outran the panel's
          // budget is still running, and its result has to appear in the next
          // document instead of being dropped with the timed-out wait.
          if (stillLoaded(generation)) {
            growthLast = { at: new Date().toISOString(), ...counts };
            scheduleRefresh("growth");
          }
          return counts;
        } finally {
          if (token === growthPassToken) growthPassRunning = false;
        }
      })();
      const counts = await settleWithin(finished, GROWTH_BUDGET_MS);
      if (counts === undefined) {
        return { state: await statusDocument({ allowNetwork: false }), running: true };
      }
      return { state: await statusDocument({ allowNetwork: false }), growth: counts };
    }

    case "xd.doctor":
      return await doctor();

    /**
     * Copy the doctor report.
     *
     * The panel page cannot do this itself: the host runs it in a window whose
     * session denies every permission except audio-only media, so
     * navigator.clipboard.writeText is refused before it reaches the platform
     * and the button could only ever report a failure. This side holds
     * `pi.clipboard`, which the `clipboard.write` permission unlocks.
     */
    case "xd.copyReport": {
      const text = payload?.text;
      if (typeof text !== "string" || text.length === 0) {
        throw panelError("copyReport needs the report text", "INVALID_TEXT");
      }
      await pi.clipboard.writeText(text);
      return { ok: true };
    }

    default:
      throw panelError("unsupported panel channel: " + String(channel), "UNSUPPORTED");
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * One check-in worker, isolated from the others in the same fan-out.
 *
 * The fan-out is a `Promise.all`, so a worker that threw took the whole pass
 * with it - the WorkBuddy counts already computed included. Each worker now
 * answers its own empty result and logs, and the pass reports what the rest did.
 *
 * The empty result carries the failure: a source that threw answered "0
 * collected, 0 skipped, 0 failed", which is the same answer a source with
 * nothing owed gives, so the panel's "last run" line could not tell a broken
 * read from a finished day. `failed: 1` plus the reason is what separates them.
 */
function isolatedCheckinWorker(work, fallback, name) {
  return work.catch((error) => {
    const reason = safeMessage(error);
    log("warn", name + " check-in failed: " + reason);
    return { ...fallback, failed: 1, reason };
  });
}

/** A check-in pacing pause that ends as soon as the plugin is going away. */
function checkinPause(ms, explicitSignal) {
  const signal = explicitSignal ?? currentCheckinSignal();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run one check-in pass and record it in `autoCheckinLast`.
 *
 * All three entry points — the scheduled tick, the host command and the panel's
 * "run now" — come through here, so the re-entry guard lives in one place. In
 * the panel channel alone it would miss the tick and the host command, which can
 * start a second pass alongside a manual one: no double claiming, because every
 * step reads `todayCheckedIn` before it writes, but the log would then describe
 * whichever pass finished last rather than what the user asked for.
 *
 * `manual` marks a pass the user started, so the panel's status line can say so.
 */
async function runCheckinPass(options) {
  const manual = options?.manual === true;
  // One source's half of the pass, as the per-source strip in the panel asks for
  // it. An empty string is every source.
  const only = typeof options?.only === "string" ? options.only : "";
  const want = (name) => only === "" || only === name;
  // The activation this pass belongs to: a reload while it runs must leave it
  // writing nothing, because the maps and flag it would write belong to the
  // load that just took over.
  const generation = loadGeneration;
  if (checkinPassRunning) return { running: true };
  // A pass that starts after the service stopped would run its whole fan-out
  // against gateways that are already closed. The stop retires the pass that
  // was in flight; this is the guard for the ones still to come.
  if (serviceStopped) return { stale: true };
  // A growth run owns the abort signal and the accounts; a scheduled or command
  // pass starting now would truncate it mid-account and record the partial counts
  // as a finished run.
  if (growthPassRunning) return { running: true };
  checkinPassRunning = true;
  // The pass that owns the running flag. A newer pass takes it, so an older one
  // finishing afterwards leaves the newer pass guarded; an older one finishing
  // with nothing newer behind it still clears the flag, which is what keeps a
  // pass that outlived its activation from locking every entry for good.
  const token = ++checkinPassToken;
  // A pass that starts after the service stopped runs with a fresh flag: the
  // stop retired the pass that was running then, not the ones still to come.
  // Without this re-arm every entry that comes through here - the tick, the
  // command, "run now" - breaks out of its account loops at once and reports a
  // silent "0 collected" while marking the day's slot as spent.
  checkinAbort.abort();
  checkinAbort = new AbortController();
  checkinScope.enterWith(checkinAbort.signal);
  // A scheduled tick hands in the slot it already decided was due. A hand-started
  // pass must consult the slots already recorded: ignoring them always named the
  // earliest hour of the day, so an evening "run now" re-marked the morning and
  // left the evening slot for the next tick, which ran the whole pass again.
  const zoned = zonedDayHour(new Date());
  const slot = typeof options?.slot === "string" && options.slot !== ""
    ? options.slot
    : dueCheckinSlot(new Date(), checkinHours(), autoCheckinSlots)
      ?? checkinSlotId(zoned.day, zoned.hour);
  const started = { slot, claimed: 0, pending: true, at: new Date().toISOString(), ...manual ? { manual: true } : {} };
  autoCheckinLast = started;
  // Recorded up front, not after the pass: a pass that runs long must not be
  // started again by the next tick. A manual run spends the hour that is due
  // now — pressing "run now" at 09:10 is that morning's pass, and at 21:10 it
  // is the evening's, not another copy of the morning.
  // In memory only: the disk record is written when the pass has ENDED, so a
  // pass the process died in the middle of leaves nothing behind and is
  // attempted again by the next run. See `saveCheckinSlots`.
  // Only a pass that actually covers WorkBuddy may spend WorkBuddy's slot: the
  // panel puts one button on each source's strip, and Trae's button used to mark
  // the domestic hour as collected, which then skipped that day's check-in,
  // travel and streak bonus entirely.
  const spendsSlot = want("workbuddy");
  if (spendsSlot) autoCheckinSlots.add(slot);
  scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
  try {
    // Concurrent where the sources are independent, which is what the host
    // command has always done: Trae alone paces its accounts five seconds apart,
    // so a serial pass over several sign-ins takes minutes.
    // Growth and travel stay out of that group: both talk to the same domestic
    // accounts as the daily check-in, so running them together stacks requests
    // on one account. A task can also be scored off the check-in, so growth
    // follows it, after a pause so the two bursts are not back to back.
    const [pool, qoder, trae] = await Promise.all([
      want("workbuddy") ? isolatedCheckinWorker(claimAllCheckins(), { claimed: 0, skipped: 0, failed: 0 }, "workbuddy") : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
      want("qoder") ? isolatedCheckinWorker(qoderCheckinAll(), { claimed: 0, skipped: 0, failed: 0 }, "qoder") : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
      want("trae") ? isolatedCheckinWorker(traeCheckinAll(), { claimed: 0, skipped: 0, failed: 0 }, "trae") : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
    ]);
    // Travel shares the domestic accounts with the check-in that just ran, so
    // it takes the serial half with growth rather than a second slot in the
    // fan-out: two unpaced request clusters on one account at the same moment
    // is what the upstream reads as a burst.
    const travel = want("workbuddy")
      ? await isolatedCheckinWorker(travelAllAccounts(), { departed: 0, claimed: 0, adopted: 0 }, "travel")
      : undefined;
    // Published before the growth pause. "Run now" only waits 18s, and the panel
    // was painting this stub — claimed still 0, no source rows — as a finished pass.
    if (!stillLoaded(generation)) return started;
    // Qoder's round may open after this hour (10:00 Beijing). Its answer carries
    // that opening time, and the tick below re-runs Qoder alone when it comes:
    // without this write-back the opening time is dropped with the pass, the
    // slot counts as spent, and that day's Qoder credits are never collected.
    // A stale generation must not schedule anything either: the retry time it
    // wrote would steer a load that has its own pass bookkeeping.
    qoderRetryAt = typeof qoder?.opensAt === "number" && qoder.opensAt > Date.now() ? qoder.opensAt : 0;
    Object.assign(started, {
      claimed: pool.claimed,
      skipped: pool.skipped,
      failed: pool.failed,
      // The worker that threw carries the upstream's own words; the panel shows
      // them beside the failure count.
      ...pool.reason === undefined ? {} : { reason: pool.reason },
      travel,
      qoder,
      trae,
    });
    await checkinPause(GROWTH_AFTER_CHECKIN_MS);
    if (!stillLoaded(generation)) return started;
    started.growth = want("workbuddy") ? await claimAllGrowth() : undefined;
    log((manual ? "manual" : "automatic") + " check-in collected " + pool.claimed + " account(s) for " + slot);
    // The slot is spent once the pass has ENDED, not when it started: a pass
    // the process died in the middle of leaves no record behind and is
    // attempted again by the next run. See `saveCheckinSlots`. A pass that no
    // longer belongs to this activation writes nothing either, for the same
    // reason: its slots belong to a load that has already reset the book.
    if (spendsSlot && stillLoaded(generation)) saveCheckinSlots();
  } catch (error) {
    started.error = safeMessage(error);
    log("warn", (manual ? "manual" : "automatic") + " check-in failed for " + slot + ": " + started.error);
    // A failed pass has spent its slot as well - the upstream is down or the
    // account is rate-limited, and retrying all day only adds noise - so the
    // record is written on this path too.
    if (spendsSlot && stillLoaded(generation)) saveCheckinSlots();
  } finally {
    // On every path, including a pass that threw: without this the guard stays
    // set and no further pass can start for the rest of the process. The pass
    // that owns the flag clears it, and only that one: a reload while this pass
    // runs hands the flag to whatever the new activation starts, and clearing
    // it here would un-guard that pass. A pass that outlived its activation
    // still clears it when nothing newer has taken over - leaving it set
    // answered every later "run now" with "a pass is already running" until the
    // plugin was reloaded.
    if (token === checkinPassToken) checkinPassRunning = false;
    delete started.pending;
  }
  if (stillLoaded(generation)) {
    autoCheckinLast = started;
    scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
  }
  return started;
}

/**
 * How long a check-in pass may run before it answers what it has and leaves the
 * rest to the background. Inside the host's command budget, with room for the
 * document that answers with it.
 */
const CHECKIN_BUDGET_MS = 15000;
/**
 * The other wide panel passes: a deliberate re-scan, one check-in step, and the
 * connection check. Each is capped as a whole rather than by adding up the
 * bounds of the calls inside it, and each answers from what has arrived.
 */
const RESCAN_BUDGET_MS = 20000;
const PANEL_STEP_BUDGET_MS = 20000;
/**
 * What a pass may spend on the document it answers with. The figures are read
 * from the caches the pass has just filled, so this buys the numbers, not the
 * reads: `allowNetwork: true` still probes inside this share.
 */
const DOCUMENT_BUDGET_MS = 4000;

/**
 * A standalone growth run. Wider than the check-in budget it is carved out of,
 * because growth walks the same accounts with a pause and a report gap between
 * the steps, and several sign-ins make that minutes rather than seconds.
 */
const GROWTH_BUDGET_MS = 90000;

/**
 * Light one account's growth streak, then redeem every tier it opened.
 *
 * The streak counter only advances on a chat the upstream scores against the
 * account, and a synthetic `chat_request_send` report is enough to move it: the
 * report is what the desktop client itself sends when a conversation is opened,
 * so the growth centre counts the day without a billable turn. Without this
 * report the counter sits where the user last left it, the 7d/14d/28d tiers
 * never unlock, and the pass redeems nothing on a schedule that looks healthy.
 *
 * The report is sent before the read rather than after it, and the read waits
 * out STREAK_REPORT_READ_GAP_MS, because the upstream scores it
 * asynchronously. A report that fails is not fatal: the tier state is still
 * read and whatever is already unlocked is still redeemed.
 *
 * A locked tier is the normal state until enough days accumulate, and a claimed
 * one needs no action, so neither is a failure. Returns how many tiers were
 * redeemed and what they paid, so the panel can say so.
 */
async function redeemAccountStreak(account) {
  // Per-step counts. The four things this pass does are separate features with
  // separate endpoints, and one merged number could not tell the user which of
  // them actually did something.
  const detail = { makeup: 0, gift: 0, compensation: 0, activity: 0, streak: 0, lottery: 0, failed: 0 };
  const conversationId = "wb2api-streak-" + Date.now();
  // Repair first: a missed yesterday breaks the run, and the run is what unlocks
  // the tiers this function is about to redeem. A card is only spent when one is
  // actually held, so a pool with none never pays for the two reads.
  try {
    const cards = await core.client.makeupCards(account.credential);
    if (cards > 0 && await core.client.missedYesterday(account.credential)) {
      const yesterday = zonedDay(-1);
      await core.client.useMakeupCard(account.credential, yesterday);
      detail.makeup += 1;
      log("info", "streak " + account.label + ": make-up card spent on " + yesterday);
    }
  } catch (error) {
    detail.failed += 1;
    log("warn", "streak " + account.label + ": make-up: " + safeMessage(error));
  }
  // One-off collections that pay credits and then never appear again. A refusal
  // here is the normal "already collected" answer, so it is not a failure.
  for (const [label, collect] of [
    ["gift", () => core.client.claimGift(account.credential)],
    ["compensation", () => core.client.claimCompensation(account.credential)],
  ]) {
    try {
      const paid = await collect();
      if (paid > 0) {
        detail[label] += paid;
        log("info", "streak " + account.label + ": " + label + " +" + paid + "c");
      }
    } catch {
      // Nothing waiting: the endpoints answer a business error for that.
    }
  }
  try {
    await core.client.reportChatActivity(account.credential, conversationId);
    detail.activity += 1;
  } catch (error) {
    detail.failed += 1;
    log("warn", "streak " + account.label + ": activity report failed: " + safeMessage(error));
  }
  await checkinPause(STREAK_REPORT_READ_GAP_MS);
  const status = await core.client.growthStreakFull(account.credential);
  let claimed = 0;
  let credit = 0;
  let energy = 0;
  // A tier that fails is logged and left there. The upstream scheduler does not
  // count that as a failed account: locked and already-claimed tiers are normal,
  // and one redeem error must not paint the whole check-in as a failure.
  for (const tier of status.tiers) {
    if (tier.status !== "unlocked") continue;
    try {
      await core.client.redeemStreakTier(account.credential, tier.tier);
      claimed += 1;
      credit += tier.credit;
      energy += tier.energy;
      detail.streak += 1;
      log("info", "streak " + account.label + ": redeemed " + tier.tier + " (+" + tier.credit + "c +" + tier.energy + "e)");
    } catch (error) {
      detail.failed += 1;
      log("warn", "streak " + account.label + ": redeem " + tier.tier + " failed: " + safeMessage(error));
    }
  }
  // Draws come only from the tiers just redeemed, so this runs after them and
  // pays only when a tier actually opened a chance. The prize payload is passed
  // through as-is and logged: its shape is the campaign's, not the API's, so
  // there is no field to read a credit out of.
  try {
    const chances = await core.client.lotteryChances(account.credential);
    for (let draw = 0; draw < chances; draw += 1) {
      const prize = await core.client.drawLottery(account.credential);
      detail.lottery += 1;
      log("info", "streak " + account.label + ": draw " + (draw + 1) + "/" + chances + " " + JSON.stringify(prize).slice(0, 160));
    }
  } catch (error) {
    detail.failed += 1;
    log("warn", "streak " + account.label + ": lottery: " + safeMessage(error));
  }
  return { claimed, credit, energy, detail };
}

/**
 * Collect the streak bonus of every account.
 *
 * Idempotent, so a pass that finds nothing to collect costs the reads and no
 * mutation, and running it on the daily schedule cannot double-pay. One account
 * failing never stops the rest.
 */
async function claimAllGrowth() {
  const counts = { streak: 0, credit: 0, failed: 0, detail: emptyGrowthDetail() };
  // Counted, not flagged: the accounts this pass skips (disabled, the other
  // region) must not decide whether the second account waits. A `first` flag
  // turned the skip into a burst the moment the first account was off.
  let seen = 0;
  for (const account of core.pool.list()) {
    // The plugin is going away: the accounts left in the list are not worth an
    // upstream call each, because nothing will read the result.
    if (currentCheckinSignal().aborted) break;
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    // A sign-in the upstream refused answers every step below with the same
    // 401, and the hold that says so is only released by a new sign-in.
    if (signInRefused(account)) continue;
    // Both regions: the growth centre exists on the international host too, and
    // its streak only advances on a reported activity, so leaving those accounts
    // out kept their tiers locked for good.
    if (seen > 0) await checkinPause(GROWTH_ACCOUNT_DELAY_MS);
    seen += 1;
    counts.detail.accounts += 1;
    let collected = false;
    try {
      const streak = await redeemAccountStreak(account);
      counts.streak += streak.claimed;
      counts.credit += streak.credit;
      if (streak.claimed > 0) collected = true;
      mergeGrowthDetail(counts.detail, streak.detail);
    } catch (error) {
      counts.failed += 1;
      counts.detail.failed += 1;
      log("warn", "streak failed for " + account.label + ": " + safeMessage(error));
    }
    // A claim changed this account's balance, so its cached probe is stale.
    if (collected) probeCache.delete(account.id);
  }
  return counts;
}

/** A growth breakdown with everything at zero, for a pass that found nothing. */
function emptyGrowthDetail() {
  return {
    accounts: 0, makeup: 0, gift: 0, compensation: 0, activity: 0,
    streak: 0, lottery: 0, failed: 0,
  };
}

/** Add one account's step counts into the pass total. */
function mergeGrowthDetail(total, part) {
  for (const key of Object.keys(total)) {
    if (typeof part[key] === "number") total[key] += part[key];
  }
}

/**
 * What the growth centre holds right now, without claiming anything.
 *
 * Read-only, so the panel can show the state before the user decides to spend
 * a make-up card or a draw: those two are the only steps of the pass that are
 * not idempotent, and a blind "run" would spend them without saying so.
 *
 * One row per account rather than one merged total. The streak, the tier it is
 * walking towards and the cards it holds are facts about one account, and a
 * total across them names no account: with two sign-ins the old merged line
 * showed whichever account was read last. The panel expands a row for the
 * tier detail behind it.
 *
 * One account's two reads run together and the accounts run together too,
 * like the credit probe: this is on demand, one button, and a serial pass over
 * several sign-ins would make the panel feel broken.
 */
async function readGrowthState() {
  const rows = [];
  let failed = 0;
  const wanted = core.pool.list().filter((account) =>
    !core.pool.isDisabled(account.id) && regionEnabled("workbuddy", regionOf(account.credential.domain))
    && !signInRefused(account));
  const reads = await Promise.all(wanted.map(async (account) => {
    try {
      const [streak, chances] = await Promise.all([
        core.client.growthStreakFull(account.credential),
        core.client.lotteryChances(account.credential),
      ]);
      return { account, streak, chances };
    } catch (error) {
      log("warn", "growth state failed for " + account.label + ": " + safeMessage(error));
      return { account, error };
    }
  }));
  for (const read of reads) {
    const region = regionOf(read.account.credential.domain);
    if (read.error !== undefined) {
      failed += 1;
      rows.push({ id: read.account.id, label: read.account.label, region, failed: true });
      continue;
    }
    const streak = read.streak;
    rows.push({
      id: read.account.id,
      label: read.account.label,
      region,
      days: streak.days,
      nextTier: streak.nextTier,
      nextTierRemaining: streak.nextTierRemaining,
      tiers: streak.tiers.filter((tier) => tier.status === "unlocked").length,
      tierList: streak.tiers,
      makeupCards: streak.makeupCards,
      lottery: read.chances,
    });
  }
  return { accounts: rows.length, failed, rows };
}

/**
 * Whether an upstream refusal means "the day was already collected".
 *
 * Matched on the whole sentence, not on the bare word: a token or account
 * refusal often merely contains "already", and counting that as a benign skip
 * hides a real breakage from the last-run line and from the check-in summary
 * the user reads.
 */
function isAlreadyCheckin(error) {
  const message = safeMessage(error).toLowerCase();
  return message.includes("已签到") || message.includes("已经签到")
    || message.includes("already checked in") || message.includes("already signed in")
    || message.includes("already claimed") || message.includes("already received");
}

/**
 * Collect every account's daily reward.
 *
 * `claimed` is a reward collected on this pass. Already checked in is `skipped`,
 * including the upstream error that means the day was already collected.
 * `failed` is only a real error. Disabled accounts, switched-off regions and
 * inactive check-ins are left out.
 */
async function claimAllCheckins() {
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  // Counted, not flagged, for the reason `claimAllGrowth` documents: a skipped
  // first account must not turn the second one into a burst.
  let seen = 0;
  for (const account of core.pool.list()) {
    if (currentCheckinSignal().aborted) break;
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    // The check-in is the pass that meets a refused sign-in first: the read
    // below is wrapped, so the account is held here and the growth and travel
    // passes that follow skip it without spending a call.
    if (signInRefused(account)) continue;
    if (seen > 0) await checkinPause(CHECKIN_ACCOUNT_DELAY_MS);
    seen += 1;
    try {
      const before = await core.pool.readAfterRefresh(account.id, (credential) =>
        core.client.fetchCheckinStatus(credential));
      if (!before.active) {
        counts.skipped += 1;
        continue;
      }
      if (before.todayCheckedIn) {
        counts.skipped += 1;
        continue;
      }
      await core.client.claimDailyCheckin(account.credential);
      probeCache.delete(account.id);
      counts.claimed += 1;
    } catch (error) {
      if (isAlreadyCheckin(error)) {
        counts.skipped += 1;
        continue;
      }
      counts.failed += 1;
      log("warn", "check-in failed for " + account.label + ": " + safeMessage(error));
    }
  }
  return counts;
}

/**
 * Today's campaign day (CST), for the adopt-threshold memory. Reuses the
 * check-in zone reader: the upstream resets its daily quota at 00:00 CST.
 */
function travelDay() {
  return zonedDayHour(new Date()).day;
}

/**
 * Adopt the first buddy: report (unlocks the task) -> agree -> first.
 *
 * The report failure does not block the chain — the upstream answers 200 yet
 * silently drops a bad report, so buddy/first stays the real gate. A
 * threshold refusal is recorded for the day and retried tomorrow instead of
 * hammering the upstream.
 */
async function travelAdopt(account) {
  const day = travelDay();
  if (travelAdoptTried.get(account.id) === day) return "skipped";
  const conversationId = "wb2api-adopt-" + Date.now();
  try {
    await core.client.reportChatActivity(account.credential, conversationId);
  } catch (error) {
    log("warn", "travel " + account.label + ": adopt preflight report: " + safeMessage(error));
  }
  await checkinPause(TRAVEL_ADOPT_GAP_MS);
  try {
    await core.client.agreeBuddy(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": agreement: " + safeMessage(error));
    return "failed";
  }
  try {
    await core.client.adoptBuddy(account.credential);
  } catch (error) {
    if (isBuddyThresholdIncomplete(safeMessage(error))) {
      travelAdoptTried.set(account.id, day);
      log("info", "travel " + account.label + ": adopt skipped (conversation threshold not reached, retry tomorrow)");
      return "skipped";
    }
    log("warn", "travel " + account.label + ": adopt: " + safeMessage(error));
    return "failed";
  }
  log("info", "travel " + account.label + ": adopt ok");
  return "adopted";
}

/**
 * One account, one trip: at most one mutating call, no polling, no waiting.
 *
 * Returns what happened so the caller can count it; every failure path logs
 * and returns instead of throwing, so one bad account never stops the rest.
 */
async function travelOne(account) {
  let buddy = null;
  try {
    buddy = await core.client.fetchBuddyInfo(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": buddy-info: " + safeMessage(error));
    return "failed";
  }
  if (buddy === null) return await travelAdopt(account);
  let status = null;
  try {
    status = await core.client.fetchTravelStatus(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": status: " + safeMessage(error));
    return "failed";
  }
  if (status.state === "arrived") {
    if (status.recordId === 0) {
      log("info", "travel " + account.label + ": claim skipped (arrived but no record_id)");
      return "skipped";
    }
    try {
      const reward = await core.client.claimTravelReward(account.credential, status.recordId);
      log("info", "travel " + account.label + ": claim ok record=" + status.recordId + " reward=" + reward);
      return "claimed";
    } catch (error) {
      log("warn", "travel " + account.label + ": claim record=" + status.recordId + ": " + safeMessage(error));
      return "failed";
    }
  }
  if (status.state === "idle") {
    if (status.dailyLimitReached) {
      log("info", "travel " + account.label + ": skip (daily limit reached)");
      return "skipped";
    }
    try {
      await core.client.departTravel(account.credential, 4);
      log("info", "travel " + account.label + ": depart ok location=4");
      return "departed";
    } catch (error) {
      log("warn", "travel " + account.label + ": depart: " + safeMessage(error));
      return "failed";
    }
  }
  if (status.state === "traveling") {
    log("info", "travel " + account.label + ": skip (traveling record=" + status.recordId + ")");
    return "skipped";
  }
  log("info", "travel " + account.label + ": skip (unknown state " + JSON.stringify(status.state) + ")");
  return "skipped";
}

/**
 * Walk every eligible account once. Disabled / removed accounts stay out
 * (removal is already filtered by `list()`); international accounts have no
 * CN task system upstream, so they are skipped without a single call.
 */
async function travelAllAccounts() {
  const counts = { departed: 0, claimed: 0, adopted: 0, failed: 0 };
  // Counted, not flagged: a skipped first account (disabled, the other region,
  // no refresh token) must not decide whether the second one waits.
  let seen = 0;
  for (const account of core.pool.list()) {
    if (currentCheckinSignal().aborted) break;
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    if (regionOf(account.credential.domain) !== "cn") continue;
    if (!account.credential.refreshToken) continue;
    // Every step of the travel chain reads and mutates on the same credential:
    // a refused sign-in fails the first one and would fail the rest.
    if (signInRefused(account)) continue;
    if (seen > 0) await checkinPause(TRAVEL_ACCOUNT_DELAY_MS);
    seen += 1;
    try {
      const outcome = await travelOne(account);
      if (outcome === "departed" || outcome === "claimed" || outcome === "adopted") {
        counts[outcome === "departed" ? "departed" : outcome === "claimed" ? "claimed" : "adopted"] += 1;
        // The pass changed this account's balance, so its cached probe is stale.
        probeCache.delete(account.id);
      } else if (outcome === "failed") {
        // `travelOne` reports every failure as an outcome rather than throwing,
        // so counting only in the catch below made a round where every request
        // failed read exactly like a round with nothing to do.
        counts.failed += 1;
      }
    } catch (error) {
      // Counted like the other outcomes: logged but left out of the counts, a
      // failed travel round makes the summary say the pass found nothing to do
      // on an account it failed on.
      counts.failed += 1;
      log("warn", "travel failed for " + account.label + ": " + safeMessage(error));
    }
  }
  return counts;
}

/**
 * Claim today's Qoder round for every signed-in Qoder account whose region is
 * switched on. Each account is read first: one that already collected, or that
 * has no claimable round (international without the app's machine identity),
 * costs one GET and no mutation. One account failing never stops the rest.
 */
async function qoderCheckinAll() {
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  const regions = activeQoderRegions();
  if (regions.length === 0) return counts;
  let found;
  try {
    found = await discoverQoderCredentials();
  } catch (error) {
    // An app directory that cannot be read is this source's failure, not the
    // whole pass's: the other sources' rounds are unaffected by it, and the
    // caller's fan-out used to reject on the throw and lose their counts. The
    // answer carries the failure, because "nothing collected" is also what a
    // source with nothing owed answers - and a deferred round that reads that
    // answer clears its retry time and never comes back for the day.
    const reason = safeMessage(error);
    log("warn", "[qoder] check-in could not read its sign-ins: " + reason);
    return { ...counts, failed: 1, reason };
  }
  // Counted, not flagged: an account whose region is switched off must not
  // decide whether the next one waits.
  let seen = 0;
  for (const credential of found.credentials) {
    if (currentCheckinSignal().aborted) break;
    if (!regions.includes(credential.region)) continue;
    if (seen > 0) await checkinPause(QODER_ACCOUNT_DELAY_MS);
    seen += 1;
    const result = await qoderClaimFor(credential);
    counts[result.outcome] += 1;
    if (result.opensAt !== undefined && (counts.opensAt === undefined || result.opensAt < counts.opensAt)) {
      counts.opensAt = result.opensAt;
    }
  }
  return counts;
}

/**
 * One Qoder account's daily round: `{outcome, reason?}`.
 *
 * The campaigns read comes first, so an account with nothing claimable (or one
 * that already collected) costs a single GET and no mutation.
 */
async function qoderClaimFor(credential) {
  const client = new QoderUpstreamClient({ region: credential.region, credential: async () => qoderClientCredential(credential) });
  try {
    const campaigns = await client.fetchCampaigns();
    const id = qoderClaimableCampaignIdOf(campaigns);
    if (id === undefined) {
      // Nothing to claim right now. When the next round opens (Qoder issues it
      // at 10:00 Beijing) say so: the automatic pass comes back at that moment
      // instead of leaving the day unclaimed.
      const state = qoderCheckinStateFrom(campaigns);
      return { outcome: "skipped", ...state.opensAt === undefined ? {} : { opensAt: state.opensAt } };
    }
    const result = qoderNormalizeClaimResult(await client.claimCampaign(id));
    if (result.reason !== undefined) {
      // 200 with a business error: a refusal the user has to see, not a
      // "nothing to collect" the panel can report as already done.
      log("warn", "[qoder:" + credential.region + "] check-in refused for " + qoderRowLabel(credential) + ": " + result.reason);
      return { outcome: "failed", reason: result.reason };
    }
    return { outcome: result.claimed && !result.replayed ? "claimed" : "skipped" };
  } catch (error) {
    const reason = safeMessage(error);
    log("warn", "[qoder:" + credential.region + "] check-in failed for " + qoderRowLabel(credential) + ": " + reason);
    return { outcome: "failed", reason };
  }
}

/**
 * Claim today's Trae credits for every signed-in CN Trae account. Each account
 * is read first: one already checked in costs a single status call and no
 * mutation. International accounts have no check-in and are never contacted.
 * An expired token is skipped (the desktop app refreshes it while it runs).
 * Accounts are spaced 5 s ± 2 s apart, the pace the endpoint is proven with.
 */
async function traeCheckinAll() {
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  if (!activeTraeRegions().includes("cn")) return counts;
  const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
  let found;
  try {
    found = await discoverTraeCredentials();
  } catch (error) {
    // Same rule as Qoder's: an unreadable app directory is this source's
    // failure, and a throw here used to take the whole pass - and the other
    // sources' counts - down with it.
    const reason = safeMessage(error);
    log("warn", "[trae:cn] check-in could not read its sign-ins: " + reason);
    return { ...counts, failed: 1, reason };
  }
  const cnCredentials = found.credentials.filter((credential) => traeRegionOfCredential(credential) === "cn");
  let index = 0;
  for (; index < cnCredentials.length; index += 1) {
    if (currentCheckinSignal().aborted) break;
    if (index > 0) await checkinPause(Math.max(1000, TRAE_ACCOUNT_DELAY_MS + Math.round((Math.random() * 2 - 1) * TRAE_ACCOUNT_JITTER_MS)));
    const result = await traeClaimFor(cnCredentials[index], desktopCandidates);
    counts[result.outcome] += 1;
    // Upstream allows one check-in per device per day, keyed on the x-device-id
    // that every account on this machine shares. Once one account holds it, each
    // remaining account can only be refused 9095, so the batch stops instead of
    // walking the rest into a refusal it already knows the answer to. They are
    // skipped rather than failed: nothing went wrong, the day is simply spent.
    if (result.deviceCheckedIn === true) {
      counts.skipped += cnCredentials.length - index - 1;
      break;
    }
  }
  return counts;
}

/**
 * Why this machine's Trae identity cannot pass the check-in endpoint, probed
 * once per edition.
 *
 * Two shapes are refused. A CLI-derived identity is synthesised from a hash
 * when no desktop storage can be read. And an install holding two
 * device-center ids - two Trae accounts signed in to the same edition - has no
 * persisted device number to send, so the fallback is a hash too. Both arrive
 * as a bare 9074, which told the user nothing they could act on; the suffix
 * names the one thing that fixes each. Whether this machine is in either state
 * is a property of the install rather than of the account, so it is asked once
 * per edition and remembered.
 */
const traeIdentityBlockers = new Map();

async function traeIdentityBlocker(desktopCandidates, edition) {
  if (traeIdentityBlockers.has(edition)) return traeIdentityBlockers.get(edition);
  let blocker = "";
  try {
    const identity = await pickTraeStorageIdentity(desktopCandidates, edition);
    if (identity.deviceIdIsFallback === true) {
      blocker = "this install holds more than one Trae sign-in, so no persisted device id could be sent; sign out of the extra account in the Trae desktop app";
    }
  } catch (error) {
    // Only a missing storage file falls back to the CLI; an unreadable one is
    // rethrown by `resolveTraeIdentity` instead, so it is not this case.
    if (error instanceof Error && error.message.startsWith(TRAE_STORAGE_MISSING_PREFIX)) {
      blocker = "the identity came from the Trae CLI fallback; sign in to the Trae desktop app so a real device id is used";
    }
  }
  traeIdentityBlockers.set(edition, blocker);
  return blocker;
}

/**
 * One Trae check-in refusal as the panel should read it.
 *
 * A refused identity is answered with a bare code, which told the user
 * nothing they could act on. The suffix names the one thing that fixes it.
 */
async function traeCheckinReason(base, credential, desktopCandidates) {
  // A classification that cannot be made is not worth losing the refusal over.
  const blocker = await traeIdentityBlocker(desktopCandidates, credential.edition).catch(() => "");
  return blocker === "" ? base : base + " - " + blocker;
}

/**
 * One Trae account's daily credits: `{outcome, reason?}`.
 *
 * The status read comes first, so an account that already checked in costs one
 * GET and no mutation. An expired token never reaches the network (the desktop
 * app refreshes it while it runs); international accounts have no check-in and
 * are filtered out by the caller.
 */
async function traeClaimFor(credential, desktopCandidates) {
  const label = traeRowLabel(credential);
  if (sourceCredentialExpired(credential, Date.now())) {
    const reason = "token expired (open Trae to refresh it)";
    log("warn", "[trae:cn] check-in skipped for " + label + ": " + reason);
    return { outcome: "skipped", reason };
  }
  const client = new TraeSoloUpstreamClient({
    credential: async () => credential,
    identity: () => resolveTraeIdentity(desktopCandidates, credential.edition),
  });
  try {
    const status = await client.fetchCheckinStatus();
    // An account whose check-in program is off has nothing to claim. The panel
    // reads the same flag to disable its button, and the WorkBuddy batch gates
    // on `active` too; without this the batch would send a pointless mutation
    // and count a refusal against an account that is simply not enrolled.
    if (status.code === 0 && status.enable === false) return { outcome: "skipped" };
    // The account's own reward for today already exists: nothing to do.
    if (status.code === 0 && status.checkedIn) return { outcome: "skipped" };
    // One check-in per device per day: when this machine already claimed for
    // another account, a claim for this one can only be refused (9095), so it
    // is not sent at all and the card says whose day is spent.
    if (status.code === 0 && status.didCheckedIn) return { outcome: "skipped", deviceCheckedIn: true };
    const claim = status.code === 0 ? await client.claimCheckin() : status;
    if (claim.code === 0) return { outcome: "claimed" };
    // 9095 here is the same device rule, raced: another window (or the Trae app
    // itself) claimed between the read and the write. A benign refusal about
    // the device, not a broken account.
    if (claim.code === TRAE_CHECKIN_DEVICE_CLAIMED) {
      log("info", "[trae:cn] check-in already used by this device for " + label + ": " + safeMessage(claim.message ?? ""));
      return { outcome: "skipped", deviceCheckedIn: true };
    }
    const reason = await traeCheckinReason(
      "code " + claim.code + (claim.message === undefined ? "" : " " + safeMessage(claim.message)),
      credential,
      desktopCandidates,
    );
    log("warn", "[trae:cn] check-in refused for " + label + ": " + reason);
    return { outcome: "failed", reason };
  } catch (error) {
    const reason = await traeCheckinReason(safeMessage(error), credential, desktopCandidates);
    log("warn", "[trae:cn] check-in failed for " + label + ": " + reason);
    return { outcome: "failed", reason };
  }
}

/** The one Trae account a panel row names, or a refusal that says why. */
async function traeClaimOne(label, region) {
  if (region !== "cn") throw panelError("Trae check-in is CN-only", "INVALID");
  const found = await discoverTraeCredentials();
  const credential = found.credentials.find(
    (entry) => traeRowLabel(entry) === label && traeRegionOfCredential(entry) === region,
  );
  if (credential === undefined) throw panelError("unknown Trae account: " + label, "NOT_FOUND");
  const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
  const result = await traeClaimFor(credential, desktopCandidates);
  if (result.outcome === "failed") throw panelError(result.reason ?? "Trae refused the check-in", "UPSTREAM");
  return result;
}

/** The one Qoder account a panel row names, or a refusal that says why. */
async function qoderClaimOne(label, region) {
  const found = await discoverQoderCredentials();
  const credential = found.credentials.find(
    (entry) => qoderRowLabel(entry) === label && entry.region === region,
  );
  if (credential === undefined) throw panelError("unknown Qoder account: " + label, "NOT_FOUND");
  const result = await qoderClaimFor(credential);
  if (result.outcome === "failed") throw panelError(result.reason ?? "Qoder refused the claim", "UPSTREAM");
  return result;
}

/**
 * One look at the schedule: collect the daily reward when a slot is due.
 *
 * The slot is recorded BEFORE the claim, so a failed pass is not retried all
 * day — the upstream is down or the account is rate-limited, and hammering it
 * would only add noise. Tomorrow's slot is a fresh chance either way.
 */
async function autoCheckinTick(now) {
  if (!autoCheckinEnabled()) return undefined;
  const when = now === undefined ? new Date() : now;
  // A source whose round opens later than the configured hour (Qoder opens at
  // 10:00 Beijing) is collected here, by the same timer, at its opening time.
  if (qoderRetryAt !== 0 && when.getTime() >= qoderRetryAt && activeQoderRegions().length > 0) {
    // Guarded like the slot path below, for the same reason: this branch also
    // fans out over every Qoder account and writes `autoCheckinLast`, so a pass
    // the user started by hand must not run beside it. A growth run is one of
    // those passes, and the abort re-arm below would cut its pacing short. The
    // retry time is left set rather than cleared, so the next tick collects it.
    if (checkinPassRunning || growthPassRunning) {
      log("info", "deferred Qoder check-in deferred: a pass is already running");
      return autoCheckinLast;
    }
    checkinPassRunning = true;
    // The same ownership token, so a round that outlived its activation still
    // releases the flag when nothing newer has taken it.
    const token = ++checkinPassToken;
    // The same fresh flag: a deferred round started by hand after a stop must
    // not inherit the stop that retired an earlier pass.
    checkinAbort.abort();
    checkinAbort = new AbortController();
    checkinScope.enterWith(checkinAbort.signal);
    // The activation this pass belongs to: its `finally` may clear the flag
    // only while this activation still owns it.
    const retryGeneration = loadGeneration;
    try {
      // Cleared before the call so a round that names a LATER opening time
      // writes that one back rather than keeping this attempt's.
      qoderRetryAt = 0;
      const retry = await qoderCheckinAll();
      // A reload during the read leaves this activation without a pass of its
      // own: writing its result back would put a history the new activation
      // never ran into the panel, and steer its timer at a round already tried.
      if (!stillLoaded(retryGeneration)) return autoCheckinLast;
      qoderRetryAt = typeof retry.opensAt === "number" && retry.opensAt > Date.now()
        ? retry.opensAt
        // A round that answered with a failure rather than an opening time is not
        // a round that ran: discovery failing leaves `failed: 1` and no claim, and
        // clearing the retry time there lost the day's Qoder credits outright.
        // Only a round that is really over clears it.
        : Number(retry.failed) > 0 && Number(retry.claimed) === 0
          ? Date.now() + QODER_RETRY_BACKOFF_MS
          : 0;
      const claimedBefore = Number(autoCheckinLast && autoCheckinLast.qoder && autoCheckinLast.qoder.claimed) || 0;
      autoCheckinLast = { ...autoCheckinLast, qoder: { ...retry, claimed: claimedBefore + (Number(retry.claimed) || 0) }, at: new Date().toISOString() };
      log("info", "deferred Qoder check-in: " + JSON.stringify(retry));
    } catch (error) {
      // The retry time was cleared above, so a throw here lost the day's round
      // outright: nothing would come back for it. It is put back a backoff
      // interval out instead - a read that throws every time must not be
      // retried every minute - and the failure lands in the source's own row,
      // where the panel reads it, rather than as a bare error over a row still
      // holding the previous round's counts. A stale activation writes none of
      // it: its book belongs to a load that has already reset.
      if (stillLoaded(retryGeneration)) {
        qoderRetryAt = Date.now() + QODER_RETRY_BACKOFF_MS;
        const reason = safeMessage(error);
        // Keep the day's earlier claim in the row; only this round failed.
        const claimedSoFar = Number(autoCheckinLast && autoCheckinLast.qoder && autoCheckinLast.qoder.claimed) || 0;
        autoCheckinLast = {
          ...autoCheckinLast,
          qoder: { claimed: claimedSoFar, skipped: 0, failed: 1, reason },
          at: new Date().toISOString(),
        };
        log("warn", "deferred Qoder check-in failed: " + reason);
      }
    } finally {
      if (token === checkinPassToken) checkinPassRunning = false;
    }
    if (serviceStopped === false) scheduleRefresh("auto-checkin");
    return autoCheckinLast;
  }
  if (activeRegions().length === 0 && activeQoderRegions().length === 0 && activeTraeRegions().length === 0) return undefined;
  const slot = dueCheckinSlot(when, checkinHours(), autoCheckinSlots);
  if (slot === undefined) return undefined;
  // A pass the user started by hand is already running. The slot stays unclaimed
  // rather than being marked done, so the next tick collects it — the alternative
  // is two passes at once, and the log describing whichever finished last.
  if (checkinPassRunning) {
    log("info", "scheduled check-in deferred: a pass is already running");
    return autoCheckinLast;
  }
  // The same pass "run now" runs, which is what collects
  // the streak bonus. It records the slot and the log, and
  // it owns the re-entry guard, so this tick must not keep a second copy of either.
  return await runCheckinPass({ slot });
}

function startAutoCheckin() {
  if (autoCheckinTimer !== null) return;
  // Double insurance beside onLoad's own checks: a timer armed here after the
  // teardown stopped the previous one would outlive the activation and keep
  // firing passes nothing is serving any more.
  if (serviceStopped) return;
  autoCheckinTimer = setInterval(() => {
    autoCheckinTick().catch((error) => log("warn", "scheduled check-in failed: " + safeMessage(error)));
  }, CHECKIN_POLL_MS);
  // Background duty, so it must never hold the process open.
  if (typeof autoCheckinTimer.unref === "function") autoCheckinTimer.unref();
}

function stopAutoCheckin() {
  if (autoCheckinTimer === null) return;
  clearInterval(autoCheckinTimer);
  autoCheckinTimer = null;
}

/** Follow the switch: one timer exists exactly while automatic check-in is on. */
function applyAutoCheckin() {
  if (autoCheckinEnabled()) startAutoCheckin();
  else stopAutoCheckin();
}

/**
 * Refresh every eligible account's token, by hand.
 *
 * `ensureFresh` decides per account whether an upstream call is needed, so an
 * account whose token still has hours on it costs nothing and an international
 * token that lives a year is never touched. What the pass buys is the account
 * nobody has used since its token expired: without it that account is refreshed
 * by the first request that arrives, which pays the round trip on the user's
 * own turn and, when the refresh token is dead too, fails that turn instead of
 * this one.
 *
 * Disabled and switched-off-region accounts stay out, matching every other
 * pass: a parked account is parked on purpose.
 */
async function keepAliveTokens() {
  const counts = { refreshed: 0, fresh: 0, failed: 0, noToken: 0 };
  for (const account of core.pool.list()) {
    // The service is going away: nothing will read the tokens this refreshes.
    if (serviceStopped) break;
    if (core.pool.isDisabled(account.id)) continue;
    if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    // A sign-in the upstream refused cannot be refreshed: the hold says so, and
    // spending the sweep's one call per account on it would report a failure for
    // a condition the panel already explains.
    if (signInRefused(account)) continue;
    const outcome = await core.pool.ensureFresh(account);
    // The panel has no separate bucket for a refusal: it is a failed refresh
    // just like a timeout, and the sign-in hold explains the difference.
    const bucket = outcome === "refused" ? "failed" : outcome;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

/** Run one keep-alive pass and record it for the panel. */
async function runKeepAlivePass() {
  if (serviceStopped) return null;
  const generation = loadGeneration;
  const counts = await keepAliveTokens();
  // A reload while the pass runs must leave it writing nothing: the flag and the
  // pool it would describe belong to the load that just took over.
  if (stillLoaded(generation)) {
    keepAliveLast = { at: new Date().toISOString(), ...counts };
    scheduleRefresh("keep-alive");
  }
  return counts;
}

/**
 * Re-read the sign-ins on a timer while the service runs.
 *
 * The pool scans at load, when the panel opens and when it runs dry. None of
 * those happens between two account switches in the desktop client, and the
 * global client keeps one live file: the sign-in that was overwritten in that
 * gap was never read, so it could not be archived either. A read this often is
 * what turns "the account I had before" into one the pool still holds.
 *
 * Chained rather than an interval, so a slow walk is followed by one pause
 * instead of a queue of walks on top of each other.
 */
function startAccountWatch() {
  if (accountWatchTimer !== null || serviceStopped) return;
  const read = () => {
    accountWatchTimer = null;
    if (serviceStopped) return;
    if (activeRegions().length > 0) {
      core.pool.scan().catch((error) => log("warn", "account re-read failed: " + safeMessage(error)));
    }
    startAccountWatch();
  };
  accountWatchTimer = setTimeout(read, ACCOUNT_WATCH_MS);
  // Background duty, so it must never hold the process open.
  if (typeof accountWatchTimer.unref === "function") accountWatchTimer.unref();
}

function stopAccountWatch() {
  if (accountWatchTimer === null) return;
  clearTimeout(accountWatchTimer);
  accountWatchTimer = null;
}

/**
 * Bring the declaration up to date BEFORE the host can act on it.
 *
 * The host validates a plugin's manifest and only then spawns its process, so
 * anything written during onLoad is visible on the NEXT load. Publishing at the
 * earliest point the plugin runs means a restart is always enough, and the
 * panel says so when the declaration could not be written.
 *
 * Note this is the only place the roster is fetched during load; opening the
 * panel does not trigger detection of its own.
 */
async function publishDeclarationEarly() {
  await adoptHostSettings();
  // Published while disabled too: a manifest still carrying provider rows would
  // have the host offer a gateway this run never starts, until something else
  // rewrote it. `syncDeclaration` clears the rows when every source is off,
  // which is what `enabled: false` means here.
  if (settings.enabled === false) {
    const cleared = syncDeclaration();
    if (cleared.ok !== true) log("warn", "declaration not cleared: " + String(cleared.error));
    return;
  }
  applySettingsToCore();
  reconcileRuntimes();
  // The other two sources must join the same run's publish: without this their
  // gateways are only reconciled by a background refresh, so a fresh load
  // would declare the WorkBuddy pair alone and the host - which reads the
  // manifest before the process starts - would never see the other four rows.
  // Bounded like the roster read below: a step that outruns the budget keeps
  // running behind the answer, and the refresh after `service.start` publishes
  // whatever it finished.
  const bootstrapDeadline = Date.now() + LOAD_BOOTSTRAP_BUDGET_MS;
  const bootstrapLeft = () => Math.max(0, bootstrapDeadline - Date.now());
  await settleWithin(reconcileTraeGateways(), bootstrapLeft());
  await settleWithin(reconcileQoderGateways(), bootstrapLeft());
  if (activeRegions().length > 0) await settleWithin(core.pool.scan(), bootstrapLeft());
  await settleWithin(startRuntimes(), bootstrapLeft());
  // Bounded like every other read: the host gives `onLoad` seconds, and a roster
  // that does not answer inside them still leaves a declaration to publish -
  // the fallback roster plus the saved selection - while the read it cut short
  // finishes behind the answer and the refresh after `service.start` repeats it.
  await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
    try {
      await connect(runtime, true);
    } catch (error) {
      runtime.lastError = safeMessage(error);
      log("warn", runtime.region + " failed to start during load: " + runtime.lastError);
    }
  })), LOAD_ROSTER_BUDGET_MS);
  const written = syncDeclaration();
  if (written.ok !== true) log("warn", "declaration not written: " + String(written.error));
  // The count, not the path: the panel footer is the place that says where the
  // plugin lives, and a log line that read "undefined" looked like a broken path.
  else if (written.changed === true) log("info", "declaration updated at load time; " + written.providerCount + " provider(s)");
}

async function onServiceStart() {
  serviceStopped = false;
  // No re-arm here on purpose: a pass that was running when the service stopped
  // has been retired, and re-arming here let it finish its account loops and
  // perform the claims nobody would read. The entries re-arm for themselves,
  // which is what keeps a hand-started pass after a stop working.
  if (warmAbort.signal.aborted) warmAbort = new AbortController();
  await adoptHostSettings();
  if (settings.enabled === false) {
    // Published anyway: a manifest left carrying provider rows would keep the
    // host offering a gateway this run will never start.
    syncDeclaration();
    log("info", "plugin disabled in settings; the provider host stays down");
    return;
  }
  applySettingsToCore();
  reconcileRuntimes();
  // A switch in the client is not a request, so nothing else would re-read the
  // sign-ins before the next one overwrites it.
  startAccountWatch();
  // Bounded like the load path above: the host allows this hook 5 s, and the
  // reconcilers must not be the part of it that runs unbounded.
  const bootstrapDeadline = Date.now() + SERVICE_BOOTSTRAP_BUDGET_MS;
  const bootstrapLeft = () => Math.max(0, bootstrapDeadline - Date.now());
  await settleWithin(reconcileTraeGateways(), bootstrapLeft());
  await settleWithin(reconcileQoderGateways(), bootstrapLeft());
  // The scan the first chat request would otherwise pay for: the at-rest key
  // fetch behind a sealed sign-in takes tens of seconds, and `acquire` scans an
  // empty pool on the request path. Starting it here - bounded, so the hook
  // still answers inside its budget - has the accounts warm before a request.
  if (activeRegions().length > 0) await settleWithin(core.pool.scan(), bootstrapLeft());
  await settleWithin(startRuntimes(), bootstrapLeft());
  // Concurrent and bounded: the host allows this hook 5 s, and it is the path
  // that finishes what `onLoad` left behind. A gateway whose read is cut short
  // is marked stale by `connect` itself, so the refresh below repeats it.
  await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
    try {
      // Skip the fetch when onLoad already seeded a fresh roster.
      await connect(runtime, !catalogFresh(runtime));
    } catch (error) {
      runtime.lastError = safeMessage(error);
      log("warn", runtime.region + " failed to start: " + runtime.lastError);
    }
  })), SERVICE_ROSTER_BUDGET_MS);
  syncDeclaration();
  // Warm the auxiliary per-account caches now, so the first panel open can
  // answer from cache instead of waiting on billing detection.
  scheduleRefresh("service-start");
}

async function onServiceStop() {
  serviceStopped = true;
  // Retires every pass this activation still has in flight: each one checks the
  // generation after its next await and gives up instead of re-opening what
  // this teardown is closing.
  loadGeneration += 1;
  // A check-in pass is never awaited by this hook, so it has to be told to stop:
  // its per-account loops and pacing pauses both read this flag.
  checkinAbort.abort();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // The slot is released here as well as by the pass that holds it: a pass
  // suspended in a network await keeps it for up to the remainder of its budget,
  // and the freshly loaded plugin's first background pass was dropped for that
  // whole window while the panel polled for something that was never coming.
  refreshInflight = null;
  stopAutoCheckin();
  stopAccountWatch();
  abortWarmups();
  // A retry that outlived this stop would fire into the activation that follows
  // it and trigger a full refresh pass nobody asked for.
  clearModelRetries();
  const closing = Array.from(runtimes.values()).map(stopRuntime);
  runtimes.clear();
  // A bind still in flight belongs to this activation; its owner releases it
  // through the post-await check in `startRuntimes` or the refresh pass.
  runtimeStarts.clear();
  for (const entry of [...traeGateways.values(), ...qoderGateways.values()]) {
    closing.push(entry.gateway.close().catch((error) => {
      log("warn", "[" + entry.source + ":" + entry.region + "] gateway did not close cleanly: " + safeMessage(error));
    }));
  }
  traeGateways.clear();
  qoderGateways.clear();
  // The failures belong to the activation that produced them: a source reloaded
  // into a working state must not keep reading as failed, and a region whose
  // close above was deliberate is not a drift.
  gatewayStartFailures.clear();
  sourceStartFailures.clear();
  await Promise.all(closing);
  // A run recorded here was waiting on a runtime this teardown has just closed.
  // Left in place it stays reachable through `startRuntimes` until the next
  // activation drains it, holding a catalog nothing serves.
  pendingRuntimeStops.length = 0;
}

async function onLoad() {
  // Cleared here, not only in `onServiceStart`: `publishDeclarationEarly` below
  // starts the gateways, and every creator refuses to run while this is set.
  serviceStopped = false;
  loadGeneration += 1;
  // A reload can arrive without the previous unload. Abort the pass it still
  // has and stop its timers. The Trae and Qoder gateways are left alone:
  // `onUnload` closes them, and clearing the maps here dropped those
  // directories with them, which took the provider rows back out of the manifest
  // until the next warm-up. The WorkBuddy runtimes are retired further below,
  // once this load has a core they can be rebuilt against.
  checkinAbort.abort();
  abortWarmups();
  stopAutoCheckin();
  stopAccountWatch();
  clearModelRetries();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshInflight = null;
  checkinAbort = new AbortController();
  // A reload is this plugin's restart, so the check-in bookkeeping starts clean:
  // a pass lost to a crash or reload must be re-attempted on the next tick, and
  // every claim re-reads today's state first, so re-running a slot collects only
  // what was never collected. The slots a pass that RAN TO ITS END collected are
  // the exception - they are re-read from disk below, so a restart after the
  // morning hour no longer runs the whole pass again. A stale pass from the
  // previous activation is still running in the background; the generation
  // guards keep its finally from touching these reset values.
  checkinPassRunning = false;
  autoCheckinSlots.clear();
  autoCheckinLast = null;
  keepAliveLast = null;
  // The growth card's own bookkeeping starts clean with the rest: a run lost to
  // the reload is still in flight, and its `finally` clears the flag it took.
  growthPassRunning = false;
  growthLast = null;
  qoderRetryAt = 0;
  // Built before the first await, so a panel invoke that lands while this load
  // is between its awaits never meets a half-loaded engine: the host dispatches
  // to this process as soon as it is up, and `statusDocument` reaching a pool
  // that is still undefined answered the panel with a TypeError. The
  // settings-dependent fields are provisional until then; `adoptHostSettings`
  // re-applies them before anything serves.
  // The client is built first because the pool refreshes tokens through it.
  core.client = new WorkBuddyUpstreamClient();
  core.pool = new WorkBuddyAccountPool({
    client: core.client,
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
    // Asked lazily: the host hands out the data path below, after this pool
    // exists, and the archive is only needed once a scan runs.
    dataPath: () => dataPath,
    logger: {
      info: (...args) => log("info", gatewayLogLine("", args)),
      warn: (...args) => log("warn", gatewayLogLine("", args)),
      error: (...args) => log("error", gatewayLogLine("", args)),
    },
  });
  // A previous load's warm-ups were aborted on the way out; this one gets a
  // controller of its own so its warm-ups can be stopped the same way.
  warmAbort = new AbortController();
  // A reload can arrive without the previous unload, and that activation's
  // WorkBuddy shims are still listening. Each closed over the pool and client
  // that were just replaced, so without this every later settings application,
  // preference, disable, credit reserve and scan went to objects nothing served
  // while `statusDocument` read the new ones. Retiring them here makes the
  // declaration pass below rebuild them against this core. The Trae and Qoder
  // maps are deliberately left alone: their gateway options are closures over
  // module-level functions, and clearing them dropped directories the next
  // warm-up had not yet read back.
  for (const runtime of Array.from(runtimes.values())) pendingRuntimeStops.push(stopRuntime(runtime));
  runtimes.clear();
  await adoptHostSettings();
  // The teardown can run while this load is still between its awaits. An
  // activation disabled a moment after it started would otherwise register its
  // service and its check-in timer into a load that is already
  // gone, and nothing would ever stop them. Every step past this point is
  // re-checked the same way.
  if (serviceStopped) return;
  try {
    packageRoot = __dirname;
  } catch {
    packageRoot = "";
  }
  // Fixed before any gateway can answer a request: this is the copy the host
  // loaded, and every Max decision is made against it rather than against what
  // this process writes afterwards.
  captureHostWindows();
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch (error) {
    dataPath = "";
    log("warn", "no plugin data path: " + safeMessage(error));
  }
  // Read before the check-in timer can start: the timer's first tick would
  // otherwise re-run a day an earlier run already collected.
  loadCheckinSlots();
  if (serviceStopped) return;
  // Reload right away when a previous id's file was taken over: the settings
  // were read above, before the copy existed, and a load that publishes the
  // declaration first would publish it with the defaults.
  if (await adoptPreviousDataDir()) await adoptHostSettings();
  if (serviceStopped) return;
  pi.services.register({ id: SERVICE_ID, start: onServiceStart, stop: onServiceStop });
  // The host pushes a settings document whenever the user edits this plugin in
  // its own settings UI. Without this listener those edits only took effect
  // after a full plugin reload.
  subscribeToHostSettings();
  await publishDeclarationEarly();
}

async function onUnload() {
  // First thing, so any pass already suspended in a network await gives up at
  // its next check instead of re-opening what this teardown is about to close.
  loadGeneration += 1;
  stopAutoCheckin();
  stopAccountWatch();
  abortWarmups();
  // Publish the current declaration one last time. The host reads the manifest
  // when it next loads the plugin, so writing here means a selection changed in
  // the host's settings UI reaches the picker on the very next enable instead
  // of needing a second round.
  try {
    syncDeclaration();
  } catch (error) {
    log("warn", "could not publish the declaration during unload: " + safeMessage(error));
  }
  await onServiceStop();
  probeCache.clear();
  // The module-level state a load builds is per-load state: a hold, an expiry
  // note or a rotation cursor left behind outlives the sign-ins it was keyed
  // by, and the next load inherits accounts that are not there any more.
  sourceFailureHold.clear();
  sourceCreditExpiry.clear();
  sourceRotation.clear();
  travelAdoptTried.clear();
  traeIdentityBlockers.clear();
  gatewayStartFailures.clear();
  sourceStartFailures.clear();
  // A sign-in the panel started is process state: a poll arriving after the
  // reload would otherwise be answered with a state this activation never issued.
  deviceLogins.clear();
  unsubscribeFromHostSettings();
}

function composerPointsEnabled() {
  return settings.showComposerPoints === true;
}

/**
 * The published models, keyed by the text the composer chip actually shows.
 *
 * The chip renders `alias?.trim() || modelId`, and the host stores the `name`
 * this plugin declares as that binding's alias - so the text on the chip is the
 * name the picker shows (`Space-Bunny · x0.08`), never the id. Matching on the
 * id therefore matched nothing at all, which is why the chip stayed empty on
 * every source. `label` here is read from the same declaration the provider row
 * is published from, so the two cannot drift apart.
 *
 * A label two gateways both publish cannot say which of them is selected, and
 * guessing is what showed an international balance against the CN account. The
 * declaration therefore tags the later spelling of a colliding name with its
 * pool (`… (Global)`), so a label on the chip resolves to exactly one of them;
 * the uniqueness filter below is what answers a manifest written before that
 * existed, and it drops nothing once the tags are in place.
 */
function composerModels() {
  const rows = [];
  // The chip carries a label the host read from the manifest, so the manifest
  // is where the label is resolved back to the gateway that published it. The
  // names there are already disambiguated; matching the live rosters instead
  // would miss exactly the models two gateways both serve.
  for (const provider of manifestProviders()) {
    const route = routeOfProviderId(provider.id);
    if (route === undefined) continue;
    for (const model of provider.models || []) {
      const id = String(model.id || "").trim();
      if (id === "") continue;
      rows.push({
        source: route.source,
        region: route.region,
        id,
        label: typeof model.name === "string" ? model.name.trim() : "",
      });
    }
  }
  const seen = new Map();
  for (const row of rows) {
    const key = composerChipText(row);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return rows.filter((row) => seen.get(composerChipText(row)) === 1);
}

/**
 * The gateway a published provider id belongs to.
 *
 * The three id tables are the only place the mapping exists, and the composer
 * needs it in the reverse direction: from the label the host shows back to the
 * account pool whose balance belongs beside it.
 */
function routeOfProviderId(providerId) {
  const id = String(providerId || "");
  const find = (ids, source, regions) => {
    const region = regions.find((entry) => ids[entry] === id);
    return region === undefined ? undefined : { source, region };
  };
  return find(PROVIDER_ID_BY_REGION, "workbuddy", REGIONS)
    ?? find(TRAE_PROVIDER_ID_BY_REGION, "trae", TRAE_REGIONS)
    ?? find(QODER_PROVIDER_ID_BY_REGION, "qoder", QODER_REGIONS);
}

/** The text the host prints on the chip for one published model. */
function composerChipText(model) {
  return composerChipTextOf(model.label === "" ? model.id : model.label);
}

/** The chip text as the host prints it, normalised for comparison. */
function composerChipTextOf(chip) {
  return typeof chip === "string" ? chip.trim().toLowerCase() : "";
}

/**
 * Every chip text this plugin's declaration can put on the model chip.
 *
 * The answer distinguishes "ours, but this gateway has not published a roster
 * yet" from "not ours at all": the first is a wait and keeps the readout's fast
 * cadence, the second is a stop. The declaration is the whole list, including
 * the rows kept for a warming gateway, so no second source is read here.
 *
 * A name that carries a region tag counts both with it and without it: until the
 * host re-imports the label, the chip can still print the older spelling, and
 * that spelling is this plugin's too - it just cannot say which pool it means.
 */
function composerChipTexts() {
  const texts = new Set();
  const models = composerModels();
  for (const row of models) {
    texts.add(composerChipText(row));
    const untagged = row.label.replace(/\s+\([^()]*\)$/, "").trim();
    if (untagged !== "" && untagged !== row.label) texts.add(untagged.toLowerCase());
  }
  // The host prints `alias || id`, so a chip can carry a model id until the alias
  // is imported. Only the ones this declaration publishes for a single pool count:
  // a shared id names neither.
  const idCounts = new Map();
  for (const row of models) {
    const key = row.id.toLowerCase();
    idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
  }
  for (const row of models) {
    const key = row.id.toLowerCase();
    if (idCounts.get(key) === 1) texts.add(key);
  }
  return texts;
}

/**
 * The row one selected model belongs to.
 *
 * The chip text is compared case-insensitively because the host matches model
 * ids that way elsewhere, so a picker can hand back a differently-cased
 * spelling of the name it was given. A text that matches nothing - including one
 * a host had not re-imported yet, whose spelling no longer exists - answers
 * nothing rather than the nearest row.
 *
 * The model id is the second spelling: the host prints `alias || id`, so a chip
 * shows the id until it has imported the alias, and an id this declaration
 * publishes for one pool only is just as good an answer. An id two pools share
 * answers nothing, for the same reason a shared label does.
 */
function matchComposerModel(chip) {
  const wanted = composerChipTextOf(chip);
  if (wanted === "") return undefined;
  const models = composerModels();
  const byLabel = models.find((model) => composerChipText(model) === wanted);
  if (byLabel !== undefined) return byLabel;
  const byId = models.filter((model) => model.id.toLowerCase() === wanted);
  return byId.length === 1 ? byId[0] : undefined;
}

/**
 * How many credit packs one composer answer may carry per account.
 *
 * The answer crosses the host's renderer relay, which refuses an oversized
 * payload: `PLUGIN_CALL_TOO_LARGE` counts as a plugin failure, and five in a
 * row open a breaker that disables every control in the popup. An account's pack
 * list is whatever the upstream pages back, so it is capped here rather than
 * trusted.
 */
const MAX_COMPOSER_PACKAGES = 8;

/**
 * One account's packs reduced to the fields the chip actually prints.
 *
 * The chip names the pack, prints what is left of it, and one word about when it
 * runs out. `size` and `refreshAtMs` are relayed for nothing, and they are the
 * two fields an upstream is free to repeat on every row.
 */
function composerPackages(packages) {
  return packages.slice(0, MAX_COMPOSER_PACKAGES).map((pack) => ({
    ...pack.packageName === undefined ? {} : { packageName: pack.packageName },
    ...pack.nameKey === undefined ? {} : { nameKey: pack.nameKey },
    ...typeof pack.remain === "number" ? { remain: pack.remain } : {},
    ...pack.roundExpiresAtMs === undefined ? {} : { roundExpiresAtMs: pack.roundExpiresAtMs },
    ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
    ...pack.neverExpires === true ? { neverExpires: true } : {},
    ...pack.monthly === true ? { monthly: true } : {},
    ...typeof pack.validDays === "number" ? { validDays: pack.validDays } : {},
  }));
}

function workbuddyComposerAccounts(region, modelId) {
  const now = Date.now();
  const list = core.pool.list(region);
  const available = core.pool.available(now, modelId, region);
  const preferredId = preferredAccountId(region);
  const preferred = available.find((account) => account.id === preferredId);
  const next = preferred ?? core.pool.preview(available);
  return list.map((account) => {
    const cached = probeCache.get(account.id)?.value?.credits;
    return {
      id: account.id,
      label: account.label,
      active: next !== undefined && next.id === account.id,
      ...typeof cached?.total === "number" ? { total: cached.total } : {},
      ...Array.isArray(cached?.packages) && cached.packages.length > 0 ? { packages: composerPackages(cached.packages) } : {},
    };
  });
}

function sourceComposerAccounts(source, region) {
  const rows = (source === "trae" ? traeAccountRows : qoderAccountRows).filter((row) => row.region === region);
  // The account that serves this region is the gateway's own answer, not a second
  // copy of the rule: that order demotes a sign-in the upstream just refused, and
  // a readout built from a different rule named an account the requests were
  // never going to use. Only the sign-ins that can still answer are handed in,
  // because the gateway leads with a live token and an expired one never serves.
  const live = rows.filter((row) => row.expired !== true);
  const active = orderSourceCredentials(source, region, live, (row) => row.label, false)[0];
  return rows.map((row) => {
    const credits = row.usage?.credits;
    // The label is this source's identity - the preference is stored by label -
    // so the popup's row marking keys on the same value. Without it the client
    // reads an empty id and can never tell which row a notice is about.
    return {
      id: row.label,
      label: row.label,
      active: active !== undefined && active.label === row.label,
      ...typeof credits?.total === "number" ? { total: credits.total } : {},
      ...Array.isArray(credits?.packages) && credits.packages.length > 0 ? { packages: composerPackages(credits.packages) } : {},
      ...row.usage?.plan?.name ? { plan: row.usage.plan.name } : {},
    };
  });
}

/**
 * Cache-first credits; missing balances are refreshed in the background.
 *
 * The answer itself is cache-only, so a poll is cheap. One exception: a stale
 * WorkBuddy probe schedules the background refresh that fills the cache, so
 * the first poll after a load may be what starts the read the later polls
 * answer from.
 *
 * `ours` separates the two reasons there is nothing to show: the selected model
 * is not this plugin's (nothing will ever arrive, so there is nothing to wait
 * for) from it being ours while a gateway has not declared its roster yet -
 * the balance is still coming. The readout cannot tell them apart from `show`
 * alone, so it is told here rather than left to infer it.
 *
 * `enabled` is what lets the readout stop polling for good when the feature is
 * off: `show: false` alone is indistinguishable from another plugin's model,
 * which is a wait rather than a stop.
 */
function composerPoints(args) {
  if (!composerPointsEnabled()) return { show: false, ours: false, enabled: false };
  const hit = matchComposerModel(args?.chip);
  if (hit === undefined) {
    return { show: false, ours: composerChipTexts().has(composerChipTextOf(args?.chip)), enabled: true };
  }
  if (hit.source === "workbuddy" && probesStale()) scheduleRefresh("composer");
  const accounts = hit.source === "workbuddy"
    ? workbuddyComposerAccounts(hit.region, hit.id)
    : sourceComposerAccounts(hit.source, hit.region);
  const active = accounts.find((account) => account.active === true);
  return {
    show: true,
    ours: true,
    enabled: true,
    source: hit.source,
    region: hit.region,
    label: active?.label || "",
    total: typeof active?.total === "number" ? active.total : null,
    accounts,
  };
}

async function composerPrefer(args) {
  const source = args?.source;
  const region = args?.region;
  const hit = matchComposerModel(args?.chip);
  if (hit === undefined || hit.source !== source || hit.region !== region) return { show: false };
  if (source === "workbuddy") {
    const accountId = typeof args?.accountId === "string" ? args.accountId : "";
    if (!REGIONS.includes(region)) return { show: false };
    // A sign-in that is gone is a refusal, exactly as the Trae/Qoder branch below
    // treats it: answering with the current snapshot (`show: true`) made the chip
    // close as though the switch had landed.
    if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) {
      return { show: false };
    }
    const written = await mutateSettings("preferredAccountIds", (current) => {
      const preferredAccountIds = {};
      for (const key of REGIONS) {
        const held = current && typeof current === "object" && !Array.isArray(current) ? current[key] : undefined;
        if (typeof held === "string" && held !== "") preferredAccountIds[key] = held;
      }
      if (accountId === "") delete preferredAccountIds[region];
      else preferredAccountIds[region] = accountId;
      return preferredAccountIds;
    });
    if (written !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
    core.pool.prefer(accountId || undefined, region);
    // Listed is not the same as usable. A cooling, switched-off or reserve-held
    // account is still on the card and still clickable, but the pool skips it, so
    // storing the preference changes nothing this session. The choice is still
    // worth storing - it applies the moment the account recovers - and reporting
    // that back is what stops the popup from closing on a click that did not
    // switch anything.
    // Judged against the same question the popup marked the rows with - the
    // roster of this model - so a model-level cooldown reads the same in both
    // places. `undefined` here would call an account servable that the popup
    // has just left unmarked.
    const servable = accountId === ""
      || core.pool.available(Date.now(), hit.id, region).some((account) => account.id === accountId);
    // `saved` separates "the choice is stored and already in force" from
    // "nothing was stored": every refusal returned above, so everything past
    // `saveSettings` succeeded. It is reported separately because the snapshot
    // can be missing for reasons that have nothing to do with the click - the
    // credits chip can be switched off in the panel between the popup's read
    // and this call, leaving an answer with no rows - which a reader would
    // otherwise take for a refusal even though the save landed.
    const answer = composerPoints(args);
    return { ...answer, saved: true, ...(servable ? {} : { unavailable: true }) };
  }
  if (source !== "trae" && source !== "qoder") return { show: false };
  if (!(source === "trae" ? TRAE_REGIONS : QODER_REGIONS).includes(region)) return { show: false };
  const accountLabel = typeof args?.accountLabel === "string" ? args.accountLabel : "";
  if (!sourceAccountMayBePreferred(source, region, accountLabel)) return { show: false };
  const written = await mutateSettings("preferredSourceAccounts", (current) => {
    const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
    if (accountLabel === "") delete next[sourceRegionKey(source, region)];
    else next[sourceRegionKey(source, region)] = accountLabel;
    return next;
  });
  if (written !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
  // Same contract as the WorkBuddy branch: past the save the choice is in
  // force, so it is reported as stored even if the snapshot is unavailable.
  return { ...composerPoints(args), saved: true };
}

/**
 * How long the composer popup's refresh may wait before it answers.
 *
 * The host relays `plugin.call` under a 2 s timeout
 * (`RENDERER_CALL_TIMEOUT_MS`) and refuses the call once that runs out, so this
 * pass has to answer inside it rather than spend the panel's share. Nothing is
 * cancelled: a probe that outlives the budget still writes its row or its
 * probe-cache entry, and the popup's own poll picks the figures up, which is what
 * keeps the click from turning into a timeout and eventually into a relay
 * cooldown that disables every control in the popup. The DeepSeek Harness build
 * waits 15 s because that host's invoke deadline is 20 s; the two values differ
 * because the hosts do.
 */
const COMPOSER_REFRESH_BUDGET_MS = 1500;

/**
 * Re-read the credits behind the composer popup.
 *
 * The popup lists one route's accounts, so the refresh covers exactly those: a
 * WorkBuddy region drops its probe cache and reads it back, a Trae or Qoder
 * region re-probes each of its rows, keeping the figures it already has when a
 * read fails. The polled readout stays cache-only; this is the one call the
 * click is allowed to wait on, and it waits only as long as the relay allows.
 */
async function composerRefresh(args) {
  const hit = matchComposerModel(args?.chip);
  if (hit !== undefined) {
    await settleWithin(composerRefreshWork(hit), COMPOSER_REFRESH_BUDGET_MS);
  }
  return composerPoints(args);
}

async function composerRefreshWork(hit) {
  if (hit.source === "workbuddy") {
    for (const account of core.pool.list(hit.region)) probeCache.delete(account.id);
    await statusDocument({ allowNetwork: true, budgetMs: COMPOSER_REFRESH_BUDGET_MS });
    return;
  }
  const rows = hit.source === "trae" ? traeAccountRows : qoderAccountRows;
  const found = hit.source === "trae" ? await discoverTraeCredentials() : await discoverQoderCredentials();
  const deadline = Date.now() + COMPOSER_REFRESH_BUDGET_MS;
  for (const row of rows) {
    if (row.region !== hit.region) continue;
    if (Date.now() >= deadline) break;
    const credential = found.credentials.find((item) => {
      const itemLabel = hit.source === "trae" ? traeRowLabel(item) : qoderRowLabel(item);
      const itemRegion = hit.source === "trae" ? traeRegionOfCredential(item) : item.region;
      return itemLabel === row.label && itemRegion === row.region;
    });
    if (credential === undefined) continue;
    const probe = hit.source === "trae"
      ? await traeRowProbe(credential, row)
      : await qoderRowProbe(credential, row);
    if (probe?.usage) row.usage = probe.usage;
    if (probe?.checkin) row.checkin = probe.checkin;
  }
}

async function onRendererCall(method, args) {
  if (method === "xd.composerPoints") return composerPoints(args || {});
  if (method === "xd.composerPrefer") return composerPrefer(args || {});
  if (method === "xd.composerRefresh") return composerRefresh(args || {});
  const error = new Error("unknown renderer method");
  error.code = "PLUGIN_CALL_UNKNOWN";
  throw error;
}

module.exports = { onLoad, onUnload, onPanelInvoke, onRendererCall };
