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
  let writeGate = null
  let controlledReads = null
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
          if (controlledReads !== null) {
            return await new Promise((resolve) => { controlledReads.push(resolve) })
          }
          // Snapshot BEFORE the gate: a read that was issued before a save must
          // answer with the document as it stood then, which is the whole point
          // of the race case. Reading after the gate would hand back the newer
          // document and make the case pass for the wrong reason.
          const snapshot = { ...settingsDocument }
          if (gate !== null) await gate
          if (readFails) throw new Error('settings host unavailable')
          return snapshot
        },
        setSettings: async (patch) => {
          if (writeGate !== null) await writeGate
          settingsDocument = { ...settingsDocument, ...patch }
        },
        getDataPath: options.getDataPath ?? (async () => path.join(temporary, 'data')),
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
    /** Keep every later write pending until the returned release is called. */
    holdWrite() {
      let release
      writeGate = new Promise((resolve) => { release = resolve })
      return release
    },
    queueReads() {
      controlledReads = []
    },
    releaseRead(index, value) {
      controlledReads[index](value)
    },
    read: (expression) => vm.runInContext(expression, context),
    cleanup() { fs.rmSync(temporary, { recursive: true, force: true }) },
  }
}

test('a queued settings event from a previous activation cannot overwrite the new settings', async () => {
  const entry = loadEntry()
  try {
    entry.read(`
      let releaseQueue
      writeChain = new Promise(resolve => { releaseQueue = resolve })
      loadGeneration = 1
      serviceStopped = false
      applySettingsEverywhere = async () => {}
    `)
    const old = entry.read('onHostSettingsChanged({ sourceWorkbuddy: true })')
    entry.read('loadGeneration = 2; settings = { sourceWorkbuddy: false }; releaseQueue()')
    assert.equal(await old, false)
    assert.equal(entry.read('settings.sourceWorkbuddy'), false)
  } finally {
    entry.cleanup()
  }
})

test('settings writes from a previous activation cannot reach the replacement', async (t) => {
  await t.test('queued saveSettings and mutateSettings writes are dropped together', async () => {
    const entry = loadEntry({ settings: { sourceWorkbuddy: true, authFile: '/old' } })
    try {
      entry.read(`
        let releaseQueue
        writeChain = new Promise(resolve => { releaseQueue = resolve })
        loadGeneration = 1
        serviceStopped = false
        settings = { sourceWorkbuddy: true, authFile: '/old' }
      `)
      const saved = entry.read('saveSettings({ sourceWorkbuddy: false })')
      const mutated = entry.read("mutateSettings('authFile', current => current + '/old')")
      entry.read(`
        loadGeneration = 2
        settings = { sourceWorkbuddy: true, authFile: '/new' }
        releaseQueue()
      `)
      assert.equal(await saved, false)
      assert.equal(await mutated, false)
      assert.equal(entry.read('settings.sourceWorkbuddy'), true)
      assert.equal(entry.read('settings.authFile'), '/new')
      assert.deepEqual(entry.getSettingsDocument(), { sourceWorkbuddy: true, authFile: '/old' })
    } finally {
      entry.cleanup()
    }
  })

  await t.test('a settings read that crosses an activation is not written back', async () => {
    const entry = loadEntry({ settings: { authFile: '/new' } })
    try {
      entry.read(`
        let releaseRead, readStarted
        const started = new Promise(resolve => { readStarted = resolve })
        loadGeneration = 1
        serviceStopped = false
        settings = { authFile: '/new' }
        pi.plugin.getSettings = () => {
          readStarted()
          return new Promise(resolve => { releaseRead = resolve })
        }
      `)
      const mutated = entry.read("mutateSettings('authFile', current => current + '/old')")
      await entry.read('started')
      entry.read(`
        loadGeneration = 2
        settings = { authFile: '/new' }
        releaseRead({ authFile: '/host' })
      `)
      assert.equal(await mutated, false)
      assert.equal(entry.read('settings.authFile'), '/new')
      assert.deepEqual(entry.getSettingsDocument(), { authFile: '/new' })
    } finally {
      entry.cleanup()
    }
  })
})

test('a replacement load waits for an in-flight settings write', async () => {
  for (const start of ['module.exports.onLoad()', 'onServiceStart()']) {
    const entry = loadEntry({ settings: { sourceWorkbuddy: false, enabled: false } })
    try {
      entry.read(`
        captureHostWindows = () => {}
        loadCheckinSlots = () => {}
        adoptPreviousDataDir = async () => false
        subscribeToHostSettings = () => {}
        publishDeclarationEarly = async () => {}
        syncDeclaration = () => ({ ok: true })
      `)
      const release = entry.holdWrite()
      const saving = entry.read('saveSettings({ sourceWorkbuddy: true })')
      await new Promise((resolve) => setImmediate(resolve))
      if (start === 'onServiceStart()') entry.read('loadGeneration += 1')
      let loaded = false
      const loading = entry.read(start).then(() => { loaded = true })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(loaded, false, `${start} must not read settings around the old write`)
      release()
      assert.equal(await saving, false, 'the retired activation still reports that its write did not commit')
      await loading
      assert.equal(entry.read('settings.sourceWorkbuddy'), true,
        `${start} must read the host document after the old write lands`)
    } finally {
      await entry.read('module.exports.onUnload()')
      entry.cleanup()
    }
  }
})

test('a host settings edit is applied while the service is stopped', async () => {
  const entry = loadEntry()
  try {
    entry.read(`
      core.pool = { applyConfig: () => false, applyRemoved() {}, prefer() {}, clear() {} }
      syncDeclaration = () => ({ ok: true })
    `)
    assert.equal(await entry.read('onHostSettingsChanged({ cooldownSeconds: 120 })'), true)
    assert.equal(entry.read('settings.cooldownSeconds'), 120)
    assert.equal(entry.read('refreshTimer'), null, 'a stopped service must not start a refresh')
  } finally {
    await entry.read('onUnload()')
    entry.cleanup()
  }
})

test('an old load cannot replace the current data directory after a delayed host reply', async () => {
  let releaseOldPath
  let readStarted
  let reads = 0
  const started = new Promise(resolve => { readStarted = resolve })
  const entry = loadEntry({
    getDataPath: () => {
      reads += 1
      if (reads !== 1) return Promise.resolve('new-data-root')
      return new Promise(resolve => { releaseOldPath = resolve; readStarted() })
    },
  })
  try {
    entry.read(`
      captureHostWindows = () => {}
      loadCheckinSlots = () => {}
      adoptPreviousDataDir = async () => false
      subscribeToHostSettings = () => {}
      publishDeclarationEarly = async () => {}
    `)
    const oldLoad = entry.read('module.exports.onLoad()')
    await started
    await entry.read('module.exports.onLoad()')
    assert.equal(entry.read('dataPath'), 'new-data-root')
    releaseOldPath('old-data-root')
    await oldLoad
    assert.equal(entry.read('dataPath'), 'new-data-root', 'the retired load must leave the new data path in place')
  } finally {
    releaseOldPath?.('old-data-root')
    await entry.read('module.exports.onUnload()')
    entry.cleanup()
  }
})

test('a failed gateway close does not abort a later start', async (t) => {
  for (const failure of ['throw', 'reject']) {
    await t.test(failure, async () => {
      const entry = loadEntry()
      try {
        entry.read(`
          core.pool = { clear() {} }
          activeRegions = () => []
          syncDeclaration = () => ({ ok: true })
          serviceStopped = false
          runtimes.set('cn', {
            region: 'cn', stopped: false,
            shim: { close: ${failure === 'throw' ? '() => { throw new Error("close failed") }' : '() => Promise.reject(new Error("close failed"))'} }
          })
        `)
        const stopping = entry.read('onServiceStop()')
        const starting = entry.read('serviceStopped = false; loadGeneration++; startRuntimes()')
        const results = await Promise.allSettled([stopping, starting])
        assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'])
      } finally {
        await entry.read('onUnload()')
        entry.cleanup()
      }
    })
  }
})

test('a refresh records a bind failure only for its own activation', async (t) => {
  for (const retired of [false, true]) {
    await t.test(retired ? 'after restart' : 'while active', async () => {
      const entry = loadEntry()
      let refresh
      try {
        entry.read(`
          let rejectStart, signalStart, reconciles = 0
          const started = new Promise(resolve => { signalStart = resolve })
          core.pool = { clear() {} }
          serviceStopped = false; loadGeneration++; poolNeedsScan = false
          activeRegions = () => ['cn']
          createRuntime = () => {
            signalStart()
            return new Promise((resolve, reject) => { rejectStart = reject })
          }
          adoptHostSettings = async () => true
          applySettingsToCore = () => {}
          reconcileTraeGateways = async () => { reconciles++ }
          reconcileQoderGateways = async () => {}
          refreshSourceAccounts = async () => {}
          syncDeclaration = () => ({ ok: true })
          statusDocument = async () => ({})
        `)
        refresh = entry.read("refreshAll('test', false)")
        await entry.read('started')
        if (retired) {
          await entry.read('onServiceStop()')
          entry.read('serviceStopped = false; loadGeneration++')
        }
        entry.read("rejectStart(new Error('bind failed'))")
        await refresh
        assert.equal(entry.read("gatewayStartFailures.has('cn')"), !retired)
        assert.equal(entry.read('reconciles'), retired ? 0 : 1)
      } finally {
        entry.read("rejectStart?.(new Error('test finished'))")
        await refresh?.catch(() => {})
        await entry.read('onUnload()')
        entry.cleanup()
      }
    })
  }
})

test('a retired bind cannot clear a newer activation\'s failure', async () => {
  const entry = loadEntry()
  let oldStart, newStart, timeout
  try {
    entry.read(`
      let releaseBind, signalBind, attempts = 0
      const bindStarted = new Promise(resolve => { signalBind = resolve })
      const bindGate = new Promise(resolve => { releaseBind = resolve })
      core.pool = { clear() {} }
      serviceStopped = false; loadGeneration++
      activeRegions = () => ['cn']
      createRuntime = async region => {
        if (++attempts === 1) {
          signalBind()
          await bindGate
          return { region, shim: { close: async () => {} } }
        }
        throw new Error('new bind failed')
      }
    `)
    oldStart = entry.read('startRuntimes()')
    await entry.read('bindStarted')
    await entry.read('onServiceStop()')
    entry.read('serviceStopped = false; loadGeneration++')
    newStart = entry.read('startRuntimes()')
    await Promise.race([
      newStart,
      new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('new start stayed blocked')), 5000) }),
    ])
    assert.equal(entry.read("gatewayStartFailures.get('cn')"), 'new bind failed')
    entry.read('releaseBind()')
    await oldStart
    assert.equal(entry.read("gatewayStartFailures.get('cn')"), 'new bind failed')
  } finally {
    clearTimeout(timeout)
    entry.read('releaseBind?.()')
    await Promise.allSettled([oldStart, newStart])
    await entry.read('onUnload()')
    entry.cleanup()
  }
})

test('a settings read from a previous activation cannot refresh its replacement', async () => {
  const entry = loadEntry()
  try {
    entry.read(`
      let releaseQueue, releaseRead, readStarted
      const started = new Promise(resolve => { readStarted = resolve })
      writeChain = new Promise(resolve => { releaseQueue = resolve })
      pi.plugin.getSettings = () => { readStarted(); return new Promise(resolve => { releaseRead = resolve }) }
      loadGeneration = 1
      serviceStopped = false
      let refreshes = 0
      scheduleRefresh = () => { refreshes += 1 }
    `)
    const old = entry.read('onHostSettingsChanged({ sourceWorkbuddy: true })')
    entry.read('localSettingsRevision++; releaseQueue()')
    await entry.read('started')
    entry.read('loadGeneration = 2; settings = { sourceWorkbuddy: false }; releaseRead({ sourceWorkbuddy: true })')
    assert.equal(await old, false)
    assert.equal(entry.read('settings.sourceWorkbuddy'), false)
    assert.equal(entry.read('refreshes'), 0, 'the previous activation must not schedule a refresh')
  } finally {
    entry.read('if (refreshTimer !== null) clearTimeout(refreshTimer)')
    entry.cleanup()
  }
})

test('a completed settings read cannot reconcile a replacement activation', async () => {
  const entry = loadEntry()
  try {
    entry.read(`
      let releaseQueue, applied = 0, refreshes = 0
      writeChain = new Promise(resolve => { releaseQueue = resolve })
      loadGeneration = 1; serviceStopped = false
      settings = { cooldownSeconds: 60 }
      loadSettings = async () => {
        Promise.resolve().then(() => Promise.resolve().then(() => {
          loadGeneration = 2; settings = { cooldownSeconds: 30 }
        }))
        return { cooldownSeconds: 120 }
      }
      applySettingsToCore = () => { applied++ }
      reconcileTraeGateways = async () => {}
      reconcileQoderGateways = async () => {}
      syncDeclaration = () => ({ ok: true })
      scheduleRefresh = () => { refreshes++ }
    `)
    const old = entry.read('onHostSettingsChanged({ cooldownSeconds: 120 })')
    entry.read('localSettingsRevision++; releaseQueue()')
    assert.equal(await old, false)
    assert.equal(entry.read('settings.cooldownSeconds'), 30)
    assert.equal(entry.read('applied'), 0, 'a previous event must not apply settings to the replacement')
    assert.equal(entry.read('refreshes'), 0)
  } finally {
    entry.cleanup()
  }
})

test('a settings event whose gateway reconcile crosses activations is not reported as applied', async () => {
  const entry = loadEntry()
  let release
  try {
    entry.read(`
      let refreshes = 0
      let reconcileStarted
      let releaseReconcile
      const started = new Promise(resolve => { reconcileStarted = resolve })
      const reconcile = new Promise(resolve => { releaseReconcile = resolve })
      serviceStopped = false
      applySettingsToCore = () => {}
      reconcileTraeGateways = () => { reconcileStarted(); return reconcile }
      reconcileQoderGateways = async () => {}
      syncDeclaration = () => {}
      scheduleRefresh = () => { refreshes += 1 }
    `)
    const old = entry.read('onHostSettingsChanged({ cooldownSeconds: 120 })')
    await entry.read('started')
    release = () => entry.read('releaseReconcile()')
    entry.read('loadGeneration++')
    release()
    assert.equal(await old, false)
    assert.equal(entry.read('refreshes'), 0, 'the old event must not schedule work for the new activation')
  } finally {
    release?.()
    entry.cleanup()
  }
})

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
 * A host edit that raced a local save is re-read, not dropped with the stale
 * event payload.
 *
 * PI announces the host's stored document, and an announcement already in
 * flight when this process saves carries the pre-save copy. Dropping it left
 * the host's own edit - a cooldown changed while the save was open - unapplied
 * until something else re-read the file. The host's copy after the save is the
 * merge of both, so re-reading is the answer that keeps each side's change.
 */
test('a host edit that raced a local save is re-read, not dropped', async () => {
  const entry = loadEntry({ settings: { sourceTrae: false, cooldownSeconds: 60 } })
  try {
    await entry.read('adoptHostSettings()')
    // The real pool is built during `onLoad`; this case only exercises the
    // document merge, so a no-op pool keeps reconciliation out of the way.
    entry.read(`core.pool = {
      applyConfig: () => false, applyRemoved: () => {}, prefer: () => {},
      list: () => [], isDisabled: () => false, clear: () => {},
    }; serviceStopped = false; reconcileTraeGateways = async () => {}; reconcileQoderGateways = async () => {};
      syncDeclaration = () => {}; scheduleRefresh = () => {}`)
    const release = entry.holdWrite()
    const saving = entry.read('saveSettings({ sourceTrae: true })')
    // The host stored its own edit while the save was in flight. The event it
    // already sent carries the document from before the save.
    entry.setDocument({ sourceTrae: true, cooldownSeconds: 120 })
    const changed = entry.read('onHostSettingsChanged({ sourceTrae: false, cooldownSeconds: 120 })')
    release()
    await saving
    await changed
    const current = json(entry.read('settings'))
    assert.equal(current.sourceTrae, true, 'the local save must survive the host event')
    assert.equal(current.cooldownSeconds, 120, 'the host edit that raced the save must land too')
  } finally {
    await entry.read('onUnload()')
    entry.cleanup()
  }
})

/**
 * A save from a partial roster keeps what the page could not show.
 *
 * The panel cannot display a model the current roster read did not list, so it
 * cannot offer to keep or drop it. Treating its absence from the payload as a
 * deliberate removal wiped that model's tick and edits whenever the static
 * fallback stood in for a live list, or a source directory answered with fewer
 * rows than it would carry later.
 */
test('a save from a partial roster keeps the models the page did not show', async () => {
  const entry = loadEntry({
    settings: {
      modelSelection: {
        cn: {
          enabledModelIds: ['shown', 'hidden'],
          overrides: { shown: { contextWindow: 8000 }, hidden: { alias: 'Hidden' } },
        },
      },
    },
  })
  try {
    await entry.read('adoptHostSettings()')
    const merged = json(entry.read(`mergeSelectionForPartialRoster(
      parseSelection({ enabledModelIds: ['shown'], overrides: {} }),
      gatewaySelectionFor('cn'),
      parseKnownModelIds(['shown']))`))

    assert.deepEqual(merged.enabledModelIds, ['shown', 'hidden'], 'the unseen model stays enabled')
    assert.equal(merged.overrides.hidden.alias, 'Hidden', 'and keeps its per-model edits')
    assert.equal(merged.overrides.shown, undefined, 'an edit cleared on the page is still removed')
    // An older panel sends no id list: its payload is the whole selection, so
    // nothing is carried over.
    const legacy = json(entry.read(`mergeSelectionForPartialRoster(
      parseSelection({ enabledModelIds: ['shown'], overrides: {} }),
      gatewaySelectionFor('cn'),
      undefined)`))
    assert.deepEqual(legacy, { enabledModelIds: ['shown'], overrides: {} })
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

test('overlapping settings reads keep the newest document', async () => {
  const entry = loadEntry()
  try {
    entry.read(`
      let readCount = 0
      let releaseOldRead, releaseNewRead
      pi.plugin.getSettings = () => new Promise(resolve => {
        if (readCount++ === 0) releaseOldRead = resolve
        else releaseNewRead = resolve
      })
    `)
    const older = entry.read('adoptHostSettings()')
    const newer = entry.read('adoptHostSettings()')
    await new Promise((resolve) => setImmediate(resolve))
    entry.read(`
      releaseNewRead({ sourceTrae: true })
      releaseOldRead({ sourceTrae: false })
    `)
    assert.equal(await newer, true)
    assert.equal(await older, false)
    assert.equal(entry.read('settings.sourceTrae'), true)
  } finally {
    entry.cleanup()
  }
})

test('an activation replaced while waiting for a write does not read settings', async () => {
  const entry = loadEntry()
  try {
    entry.read(`
      let reads = 0
      pi.plugin.getSettings = async () => { reads += 1; return {} }
      loadGeneration = 1
      serviceStopped = false
      applySettingsToCore = () => {}
      syncDeclaration = () => ({ ok: true })
      startAccountWatch = () => {}
    `)
    const release = entry.holdWrite()
    const saving = entry.read('saveSettings({ sourceTrae: true })')
    await new Promise((resolve) => setImmediate(resolve))
    const starting = entry.read('onServiceStart()')
    await new Promise((resolve) => setImmediate(resolve))
    entry.read('loadGeneration += 1')
    release()
    await saving
    await starting
    assert.equal(entry.read('reads'), 0)
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
 * A default thinking level saved for a Trae or Qoder model has to be published.
 *
 * The panel stores it per model, and the host applies a declaration's
 * `defaultThinkingLevel` to requests that name no effort. The source
 * declarations never carried the field, so picking one of those models fell
 * back to the catalog's own default while the saved setting read as accepted.
 */
test('a saved source default thinking level reaches the declaration', () => {
  const entry = loadEntry()
  try {
    entry.read('settings = ' + JSON.stringify({
      modelSelection: {
        'trae:cn': { overrides: { 'kimi-k3': { defaultThinkingLevel: 'high' } } },
        'qoder:cn': { overrides: { gmodel: { defaultThinkingLevel: 'max' } } },
      },
    }))
    entry.read('traeGateways.set("cn", { gateway: { models: () => ['
      + '{ id: "kimi-k3", name: "Kimi K3", contextWindow: 256000, maxTokens: 32000,'
      + ' reasoning: { supported: ["off", "low", "high"], defaultEffort: "low" } }'
      + '] } })')
    const trae = entry.read('traeDeclarationModels("cn")')
    assert.equal(trae[0].defaultThinkingLevel, 'high',
      'the Trae default the panel saved must be the one the host applies')

    entry.read('qoderGateways.set("cn", { gateway: { models: () => ['
      + '{ id: "gmodel", name: "GLM-5.3", contextWindow: 1000000, maxInputTokens: 180000,'
      + ' supportsImages: true, effortLevels: ["low", "high", "max"], defaultEffort: "high", alwaysThinking: true }'
      + '] } })')
    const qoder = entry.read('qoderDeclarationModels("cn")')
    assert.equal(qoder[0].defaultThinkingLevel, 'max',
      'and the Qoder default must reach its declaration too')
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

test('a dictionary write that loses a settings read race does not overwrite the host value', async () => {
  const entry = loadEntry({ settings: { creditReserves: { persisted: 1 } } })
  try {
    assert.equal(await entry.read('adoptHostSettings()'), true)
    entry.queueReads()
    const queued = entry.read(
      'mutateSettings("creditReserves", (current) => ({ ...(current ?? {}), mine: 2 }))',
    )
    await new Promise((resolve) => setImmediate(resolve))
    const newest = entry.read('adoptHostSettings()')
    await new Promise((resolve) => setImmediate(resolve))

    // The queued mutation gets an older read while a newer host read is still
    // pending. It must not edit the stale document and commit it first.
    entry.releaseRead(0, { creditReserves: { persisted: 1 } })
    await new Promise((resolve) => setImmediate(resolve))
    entry.releaseRead(2, { creditReserves: { host: 99 } })
    assert.equal(await queued, true)
    entry.releaseRead(1, { creditReserves: { host: 99 } })
    await newest

    assert.deepEqual(json(entry.getSettingsDocument().creditReserves), { host: 99, mine: 2 },
      'the mutation must merge into the host value it retried to read')
  } finally { entry.cleanup() }
})

test('refreshing disabled WorkBuddy regions does not discover or archive sign-ins', async (t) => {
  for (const settings of [
    { sourceWorkbuddy: false },
    { sourceWorkbuddy: true, disabledRegions: ['workbuddy:cn', 'workbuddy:global'] },
  ]) {
    await t.test(settings.sourceWorkbuddy ? 'both regions parked' : 'source disabled', async () => {
      const entry = loadEntry()
      const auth = path.join(entry.temporary, 'auth')
      const data = path.join(entry.temporary, 'data')
      fs.mkdirSync(auth)
      fs.writeFileSync(path.join(auth, 'fixture.info'), JSON.stringify({
        auth: { accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000 },
        account: { uin: 'fixture-off', nickname: 'Fixture' },
      }))
      fs.writeFileSync(path.join(entry.temporary, 'manifest.json'), '{"contributes":{"providers":[]}}')
      entry.setDocument({
        enabled: true, sourceTrae: false, sourceQoder: false, autoCheckin: { enabled: false },
        authFile: path.join(auth, 'fixture.info'), ...settings,
      })
      try {
        entry.read(`dataPath = ${JSON.stringify(data)}; serviceStopped = false;
          core.pool = new WorkBuddyAccountPool({ authDirs: [${JSON.stringify(auth)}], dataPath: () => dataPath }); core.client = {}`)
        await entry.read('refreshAll("test", true)')
        assert.deepEqual({
          accounts: entry.read('core.pool.list().length'),
          archived: fs.existsSync(path.join(data, 'credentials-archive.json')),
        }, { accounts: 0, archived: false })
      } finally {
        await entry.read('onUnload()')
        entry.cleanup()
      }
    })
  }
})

