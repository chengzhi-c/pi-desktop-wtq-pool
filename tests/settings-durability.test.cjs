/**
 * Regressions for the settings document and credential expiry.
 *
 * Each case is stated as the observable the user or the panel sees - not as
 * "the function was called". What they share is that the engine has to decide
 * what to do with input it did not author: a settings read that failed, a
 * settings document a newer writer replaced, an upstream that hands back an
 * absurd timestamp, and a model id that collides with an object prototype.
 *
 * The `main.js` entry is loaded into a `vm` context rather than required, because
 * these paths are top-level functions of the plugin process. `loadEntry` puts the
 * same globals the host does on that context; the settings host is a stub, so
 * nothing here touches a real install.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')

/**
 * Move a value out of the plugin's vm context.
 *
 * Objects created inside the context carry that context's `Object` prototype,
 * and `assert.deepEqual` in strict mode compares prototypes, so a value read
 * back out of the entry never equals an identical literal. Round-tripping
 * through JSON rebuilds it in this context's own terms.
 */
const json = (value) => JSON.parse(JSON.stringify(value))

/**
 * Load the plugin entry in an isolated context.
 *
 * `options.settings` is the document the host stub starts with, `readFails`
 * makes every `getSettings` reject (what a broken host RPC does), and `holdRead`
 * keeps the next read open so a case can land a save inside that window.
 * `options.require` replaces a module for one id, which is how a vendor client is
 * faked without reaching into the plugin's own bindings.
 */
function loadEntry(options = {}) {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-reg-'))
  const logs = []
  let settingsDocument = options.settings ?? {}
  let readFails = false
  let gate = null
  const baseRequire = createRequire(path.join(root, 'main.js'))
  const context = vm.createContext({
    require: (id) => {
      if (options.require && Object.prototype.hasOwnProperty.call(options.require, id)) return options.require[id]
      return baseRequire(id)
    },
    module: { exports: {} }, __dirname: temporary,
    console: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) },
    fetch, AbortController, AbortSignal, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    pi: {
      plugin: {
        getSettings: async () => {
          // Snapshot BEFORE the gate: a read that was issued before a save must
          // answer with the document as it stood then, which is the whole point
          // of the race case. Reading after the gate would hand back the newer
          // document and make the case pass for the wrong reason.
          const snapshot = { ...settingsDocument }
          if (gate !== null) await gate
          if (readFails) throw new Error('settings host unavailable')
          return snapshot
        },
        setSettings: async (patch) => { settingsDocument = { ...settingsDocument, ...patch } },
        getDataPath: async () => path.join(temporary, 'data'),
        getManifest: () => ({ version: '0.0.0-test' }),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: () => {} },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  return {
    logs, temporary,
    setReadFails() { readFails = true },
    setDocument(value) { settingsDocument = value },
    getSettingsDocument: () => settingsDocument,
    /** Keep every later read pending until the returned release is called. */
    holdRead() {
      let release
      gate = new Promise((resolve) => { release = resolve })
      return release
    },
    read: (expression) => vm.runInContext(expression, context),
    cleanup() { fs.rmSync(temporary, { recursive: true, force: true }) },
  }
}

/**
 * A failed settings read must not be answered with an empty document.
 *
 * The host RPC is a separate process, so it fails for reasons that have nothing
 * to do with the user's file - a restart, a busy host, a timed-out call. The old
 * code turned that failure into `{}` and assigned it over this process's copy of
 * the document. The panel's save helpers spread that copy before writing the one
 * key they are responsible for, so the very next click made the loss permanent:
 * switched-off accounts came back, removed accounts returned to the pool, credit
 * floors and the saved model selection were gone.
 *
 * Asserted through the write the panel performs, because "the copy is still
 * there" only matters if it survives into the file the user's next click writes.
 */
test('a failed settings read keeps the last known document instead of wiping it', async () => {
  const entry = loadEntry({
    settings: {
      disabledAccountIds: ['account-one'],
      removedAccounts: [{ id: 'account-two', label: 'Two', region: 'cn' }],
      creditReserves: { 'account-three': 25 },
      modelSelection: { cn: { enabledModelIds: ['model-a'] } },
      preferredAccountIds: { cn: 'account-one' },
    },
  })
  try {
    // Load the real document first, then make the host RPC fail. That is the
    // sequence: the plugin ran for a while, and a later read broke.
    assert.equal(await entry.read('adoptHostSettings()'), true, 'the first read must land')
    entry.setReadFails()
    assert.equal(await entry.read('adoptHostSettings()'), false, 'a failed read must not be adopted')
    assert.match(entry.logs.join('\n'), /could not read settings/)

    // What the panel does on one switch-off click: re-derive the list from the
    // document it holds, then write it back.
    await entry.read('saveSettings({ disabledAccountIds: disabledAccountIds().concat("account-four") })')
    const stored = entry.getSettingsDocument()
    assert.deepEqual(stored.disabledAccountIds, ['account-one', 'account-four'],
      'the switch-off list must survive a settings read that failed')
    assert.deepEqual(stored.removedAccounts.map((row) => row.id), ['account-two'],
      'a removed account must not come back because a read failed')
    assert.equal(stored.creditReserves['account-three'], 25,
      'a credit floor must not be dropped because a read failed')
    assert.deepEqual(stored.preferredAccountIds, { cn: 'account-one' },
      'the picked account must not be dropped because a read failed')
    assert.deepEqual(stored.modelSelection, { cn: { enabledModelIds: ['model-a'] } },
      'the saved model selection must not be dropped because a read failed')
  } finally {
    entry.cleanup()
  }
})

/**
 * A settings read that raced a local save is older than that save.
 *
 * A refresh pass reads the document and then awaits for seconds. A save landing
 * inside that window is by definition newer than the document the read returns,
 * so adopting it reverts the switch the user just flipped - and the pass then
 * republishes the reverted state, so the click looks like it never happened.
 */
test('a settings read that raced a save does not revert it', async () => {
  const entry = loadEntry({ settings: { sourceTrae: false } })
  try {
    const release = entry.holdRead()
    const adopting = entry.read('adoptHostSettings()')
    // The user flips the switch while the read is in flight. The host hands back
    // the document as it stood when the read was issued, so adopting it would put
    // the switch back to where it was.
    await entry.read('saveSettings({ sourceTrae: true })')
    release()
    assert.equal(await adopting, false, 'an older read must not be adopted')
    assert.equal(entry.read('settings.sourceTrae'), true,
      'the switch the user flipped must not be reverted by an older read')

    // Control: a read that raced nothing is still adopted, so the guard above is
    // not simply refusing every read.
    entry.setDocument({ sourceTrae: false })
    assert.equal(await entry.read('adoptHostSettings()'), true)
    assert.equal(entry.read('settings.sourceTrae'), false,
      'control: a read that raced nothing must still be adopted')
  } finally {
    entry.cleanup()
  }
})

/**
 * A model id of `__proto__` is an ordinary key in a JSON document.
 *
 * `JSON.parse` makes it an own property, but assigning it onto a plain object
 * with `map[id] = …` sets the prototype instead. Both the save and the immediate
 * read then reported success while nothing had been stored, which presents as
 * "the override I typed does not stick" with no error anywhere.
 */
test('a model id of __proto__ is stored and read back like any other', () => {
  const entry = loadEntry()
  try {
    // The shape a panel save actually sends: JSON over the bridge, so the key is
    // an own property of the parsed object rather than a prototype assignment.
    const parsed = entry.read('parseSelection(JSON.parse(\'{"overrides":{"__proto__":{"alias":"picked"},"model-b":{"alias":"b"}}}\'))')
    assert.notEqual(parsed, undefined)
    assert.equal(parsed.overrides['__proto__'].alias, 'picked',
      'a model id of __proto__ must be stored, not assigned to the prototype')
    assert.equal(parsed.overrides['model-b'].alias, 'b')
    assert.equal(Object.getPrototypeOf(parsed.overrides), null,
      'the override map must not hand the prototype to a model id')

    // The read-back path has to agree with the save path, or the override is
    // written and then silently invisible. The document goes through JSON on the
    // way in, exactly as a saved one does.
    const stored = JSON.stringify(parsed)
    entry.read('settings = { modelSelection: { cn: JSON.parse(' + JSON.stringify(stored) + ') } }')
    const normalized = entry.read('gatewaySelectionFor("cn")')
    assert.equal(normalized.overrides['__proto__'].alias, 'picked',
      'a stored __proto__ override must read back')
  } finally {
    entry.cleanup()
  }
})

/**
 * A legacy `contextBudgets` figure has to meet the same bar a save does.
 *
 * The panel refuses a non-integer or an unbounded window on save. Folding a
 * legacy document without that check reads back a window no save could have
 * produced - and `Infinity` and a huge float are both reachable from a
 * hand-edited file.
 */
test('a legacy context budget that no save could produce is refused', () => {
  const entry = loadEntry()
  try {
    const normalized = entry.read('normalizeSelection({ contextBudgets: { good: 4096, infinite: Infinity, fractional: 2.5, zero: 0, huge: 1e999 } })')
    assert.equal(normalized.overrides.good.contextWindow, 4096)
    for (const id of ['infinite', 'fractional', 'zero', 'huge']) {
      assert.equal(normalized.overrides[id], undefined,
        `a context budget of ${id} must not be accepted as a window`)
    }
  } finally {
    entry.cleanup()
  }
})

/**
 * A stored account name that no sign-in carries any more is not a preference.
 *
 * The label is the account's own name, so renaming or re-signing in retires it.
 * The old code returned a stored label as the chosen account before the rotation
 * and the expiry sort could run, which disabled both - the panel went on
 * offering "round-robin" while one account served every request.
 */
test('a retired account name no longer disables rotation', async () => {
  const entry = loadEntry({
    settings: {
      preferredSourceAccounts: { 'trae:cn': 'retired-name' },
      sourceDistributions: { trae: 'round-robin' },
    },
  })
  try {
    // The document has to reach the module before anything reads it: in the
    // plugin that is `onLoad`'s own adopt, and `sourceDistribution` decides here
    // whether the rotation branch is even reachable.
    await entry.read('adoptHostSettings()')
    assert.equal(entry.read('sourceDistribution("trae")'), 'round-robin',
      'the fixture must put this source in the rotating mode')
    entry.read('traeAccountRows = [ { region: "cn", label: "live-one", expired: false }, { region: "cn", label: "live-two", expired: false } ]')
    const call = 'orderSourceCredentials("trae", "cn", [{ label: "live-one", expiresAtMs: 0 }, { label: "live-two", expiresAtMs: 0 }], (item) => item.label, true).map((item) => item.label)'
    const first = entry.read(call)
    const second = entry.read(call)
    assert.deepEqual([...first].sort(), ['live-one', 'live-two'])
    assert.notDeepEqual(first, second,
      'rotation must advance when the stored account name is retired')

    // Control: a name that is still carried does pin the account, which is what
    // the guard above must not break.
    entry.read('settings = { ...settings, preferredSourceAccounts: { "trae:cn": "live-two" } }')
    const pinned = entry.read(call)
    assert.equal(pinned[0], 'live-two', 'a live account name must still be honoured')
  } finally {
    entry.cleanup()
  }
})

/**
 * An expiry past `Date`'s range must not fail the whole panel document.
 *
 * `xd.state` formats each row's expiry with `toISOString()`, which throws for a
 * timestamp outside `Date`'s range. A hand-edited or upstream-garbled sentinel
 * (1e15, 1e16) is exactly that, and one bad row would take the entire panel down
 * instead of the one field - so the user could not even reach the switch that
 * would fix it. An expiry that absurd is also not a date: it has to read as
 * "no expiry" so the pool keeps refreshing the token.
 */
test('an absurd stored expiry cannot fail the panel document', () => {
  const entry = loadEntry()
  try {
    const parse = 'require("./lib/accounts").parseWorkBuddyAuth(JSON.stringify(DOC), "fixture").expiresAtMs'
    const absurd = entry.read(parse.replace('DOC', '{ auth: { accessToken: "test-token", expiresAt: 1e16 } }'))
    assert.equal(absurd, 0, 'an expiry past 2100 must read as "no expiry"')
    const real = entry.read(parse.replace('DOC', '{ auth: { accessToken: "test-token", expiresAt: 1893456000 } }'))
    assert.equal(real, 1893456000 * 1000, 'a real expiry must still be read')
    const seconds = entry.read(parse.replace('DOC', '{ auth: { accessToken: "test-token", expiresAt: 1900000000000 } }'))
    assert.equal(seconds, 1900000000000, 'a millisecond expiry must be read as-is')
  } finally {
    entry.cleanup()
  }
})

/**
 * A refreshed token's expiry is bounded the same way a stored one is.
 *
 * `expiresIn` comes from the vendor's answer, so it is not trusted input either.
 * A garbled one stored a timestamp past `Date`'s range, which is the same
 * `toISOString()` failure the parse-side bound fixes - reached by a live refresh
 * rather than by a file on disk.
 */
test('a garbled token lifetime from a refresh cannot store an out-of-range expiry', async () => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-refresh-'))
  try {
    const authDir = path.join(temporary, 'auth')
    fs.mkdirSync(authDir)
    // Expired, with a refresh token: that is what makes the pool refresh it.
    fs.writeFileSync(path.join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: 'old-token', refreshToken: 'refresh-token', expiresAt: 1, domain: '' },
      account: { uin: 'refresh-fixture' },
    }))
    const { WorkBuddyAccountPool } = require('../lib/accounts')
    for (const [expiresInSec, label] of [[1e300, 'absurd'], [Infinity, 'infinite'], [3600, 'real']]) {
      const pool = new WorkBuddyAccountPool({
        authDirs: [authDir],
        client: { refreshToken: async () => ({ accessToken: 'new-token', expiresInSec }) },
      })
      await pool.scan()
      const account = pool.list()[0]
      assert.notEqual(account, undefined, `${label}: the fixture sign-in must be picked up`)
      assert.equal(await pool.refreshAccount(account.id), true, `${label}: the token must be refreshed`)
      const at = pool.list()[0].credential.expiresAtMs
      assert.equal(Number.isFinite(at), true, `${label}: a refreshed expiry must be a usable number`)
      assert.equal(at > Date.now(), true, `${label}: a refreshed token must read as fresh`)
      // The value the panel formats has to survive that formatting.
      assert.doesNotThrow(() => new Date(at).toISOString(), `${label}: the panel must be able to format it`)
      if (label === 'real') {
        assert.equal(Math.abs(at - (Date.now() + 3600 * 1000)) < 10_000, true,
          'a real expiresIn must still set the expiry it reports')
      } else {
        assert.equal(at <= 4_102_444_800_000, true, `${label}: the expiry must stay inside Date's range`)
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A stopped check-in program is not a check-in to claim.
 *
 * The panel disables its button on the same flag, so the batch has to agree:
 * sending the mutation and counting the refusal against an account that is
 * simply not enrolled reports a failure the user cannot act on.
 */
test('a check-in whose program is off is skipped, not claimed', async () => {
  const calls = []
  const entry = loadEntry({
    require: {
      './lib/trae-upstream': {
        TRAE_CHECKIN_DEVICE_CLAIMED: 9095,
        TraeSoloUpstreamClient: class {
          async fetchCheckinStatus() { calls.push('status'); return { code: 0, enable: false } }
          async claimCheckin() { calls.push('claim'); return { code: 0 } }
        },
      },
    },
  })
  try {
    const credential = '{ accessToken: "t", userId: "u", accountName: "n", edition: "cn", expiresAtMs: 0 }'
    const skipped = await entry.read(`traeClaimFor(${credential}, [])`)
    assert.equal(skipped.outcome, 'skipped', 'an account with the program off must be skipped')
    assert.deepEqual(calls, ['status'], 'no claim may be sent for an account that is not enrolled')
  } finally {
    entry.cleanup()
  }
})

/**
 * A Trae or Qoder row must name itself to the composer popup.
 *
 * The popup marks the served row as active and keys the notice it raises
 * against the same value, so it can clear that notice the moment the chosen
 * account starts serving. The client reads `id`: a row carrying only a label
 * leaves the notice's key empty, the clearing check returns early on an empty
 * key, and the "preference saved, not serving yet" line stays on screen while
 * the row beside it is already marked active.
 */
test('a Trae or Qoder row carries the identity the popup marks it by', () => {
  const entry = loadEntry()
  try {
    const rows = [
      '{ label: "Trae CN A", region: "cn", expired: false, usage: { credits: { total: 12 } } }',
      '{ label: "Trae CN B", region: "cn", expired: false }',
    ].join(', ')
    entry.read(`traeAccountRows = [${rows}]`)
    const trae = entry.read('sourceComposerAccounts("trae", "cn")')
    assert.deepEqual([...trae].map((row) => row.id), ['Trae CN A', 'Trae CN B'],
      'each row must name itself, or the popup cannot clear the notice it put on it')
    assert.equal([...trae].filter((row) => row.active === true).length, 1, 'exactly one row is the served one')
  } finally {
    entry.cleanup()
  }
})

/**
 * A Trae model's credit rate has to reach the panel, not stop at the parser.
 *
 * The directory states each model's effective (post-discount) rate and the
 * client already parsed it, but the pool's own model view never carried it
 * across - so a Trae row showed no cost while the IDE showed 0.79x for the same
 * model, and `xp`-style cost comparisons between the two sources were impossible.
 * The rate is the observable here: what the panel's cost chip reads, and what
 * the declaration names the model by.
 */
test('a Trae model that states a credit rate carries it to the panel', () => {
  const entry = loadEntry()
  try {
    // The shape the directory reader produces: `creditMultiplier` only when the
    // row stated one, so the second model stands for the rows that state none.
    entry.read('traeGateways.set("cn", { gateway: { models: () => ['
      + '{ id: "doubao-seed-evolving", name: "Doubao Seed Evolving", contextWindow: 256000, maxTokens: 32000, creditMultiplier: 0.79 },'
      + '{ id: "kimi-k3", name: "Kimi K3", contextWindow: 256000, maxTokens: 32000 }'
      + '] } })')

    const roster = entry.read('sourceRosterFor("trae:cn", traeGateways.get("cn").gateway.models(), traeNativeOf)')
    const rated = [...roster].find((row) => row.id === 'doubao-seed-evolving')
    const unrated = [...roster].find((row) => row.id === 'kimi-k3')
    assert.equal(rated.multiplier, 0.79,
      'a model the directory prices must reach the panel with that price')
    assert.equal(unrated.multiplier, undefined,
      'a model the directory does not price must stay unlabelled, not read as free')

    // The same value on the published declaration, which is the name the host's
    // model picker shows. It has to match what a WorkBuddy row reads as.
    const declared = entry.read('traeDeclarationModels("cn")')
    const row = [...declared].find((model) => model.id === 'doubao-seed-evolving')
    assert.equal(row.name, 'Doubao Seed Evolving · x0.79',
      'the picker must show the same cost suffix for a Trae model as for a WorkBuddy one')
  } finally {
    entry.cleanup()
  }
})

/**
 * Trae lists its own helper slots in the same directory as the models, and it
 * suffixes some of them over time (`fast_apply_new`). A name-equality filter let
 * the suffixed ones through, so the picker offered a row that answers nothing.
 * The prefix match has to drop the variants and keep a real model.
 */
test('a Trae helper slot with a variant suffix is not offered as a model', () => {
  const entry = loadEntry()
  try {
    entry.read('traeGateways.set("cn", { gateway: { models: () => ['
      + '{ id: "fast_apply_new", name: "Fast Apply", contextWindow: 128000, maxTokens: 16000 },'
      + '{ id: "title_generation_v2", name: "Title Generation", contextWindow: 128000, maxTokens: 16000 },'
      + '{ id: "summary", name: "Summary", contextWindow: 128000, maxTokens: 16000 },'
      + '{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 16000 }'
      + '] } })')

    const ids = [...entry.read('sourceRosterFor("trae:cn", traeGateways.get("cn").gateway.models(), traeNativeOf)')]
      .map((row) => row.id)
    assert.deepEqual(ids, ['deepseek-v4.1-flash'],
      'only the real model survives the helper-slot filter')
  } finally {
    entry.cleanup()
  }
})

/**
 * Two dictionary writes in flight at once both survive.
 *
 * A dictionary-shaped setting is read as a whole, edited and written back as a
 * whole. The panel's channels used to do that read before they wrote, so two
 * overlapping calls had the second overwrite the first with the stale copy it
 * had read, and the panel answered success for a change that was already gone.
 * The write queue makes the read part of the same serialised step.
 */
test('two overlapping dictionary writes both survive', async () => {
  const entry = loadEntry({ settings: { creditReserves: {} } })
  try {
    assert.equal(await entry.read('adoptHostSettings()'), true)
    const [first, second] = await Promise.all([
      entry.read('mutateSettings("creditReserves", (current) => ({ ...(current ?? {}), "account-a": 10 }))'),
      entry.read('mutateSettings("creditReserves", (current) => ({ ...(current ?? {}), "account-b": 20 }))'),
    ])
    assert.equal(first, true)
    assert.equal(second, true)
    assert.deepEqual(json(entry.getSettingsDocument().creditReserves), { 'account-a': 10, 'account-b': 20 },
      'both edits must be present; the second must not have overwritten the first')
  } finally { entry.cleanup() }
})

/**
 * A write picks up what the host stored while it was waiting in the queue.
 *
 * The host's own settings dialog writes the same document the panel does. A
 * queued write that re-reads before it edits keeps that edit; one that trusted
 * the copy it read when the click happened would write it back out.
 */
test('a queued write sees the edit the host made while it waited', async () => {
  const entry = loadEntry({ settings: { creditReserves: { 'account-a': 5 } } })
  try {
    assert.equal(await entry.read('adoptHostSettings()'), true)
    const release = entry.holdRead()
    const queued = entry.read('mutateSettings("creditReserves", (current) => ({ ...(current ?? {}), "account-b": 20 }))')
    // The host lands its own edit while the queued write is still waiting.
    entry.setDocument({ creditReserves: { 'account-a': 99 } })
    release()
    assert.equal(await queued, true)
    assert.deepEqual(json(entry.getSettingsDocument().creditReserves), { 'account-a': 99, 'account-b': 20 },
      'the host edit must survive alongside the queued one')
  } finally { entry.cleanup() }
})

