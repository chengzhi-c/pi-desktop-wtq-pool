
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')

/**
 * Copy the plugin manifest into a fixture directory with the runtime provider
 * declaration cleared, the same normalization the packaging step applies.
 */
function writeManifestFixture(target) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.contributes) manifest.contributes.providers = []
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

/*
 * The composer popup's refresh must answer inside the host's relay budget.
 *
 * PI-Desktop relays `plugin.call` with its own 2 s cap (RENDERER_CALL_TIMEOUT_MS
 * in plugin-renderer-extension.ts) and refuses the call with PLUGIN_CALL_TIMEOUT
 * once it runs out; five consecutive refusals open the relay's breaker for 30 s,
 * which disables every control in the popup, account switching included.
 *
 * The pass therefore spends a budget of its own, well inside that cap, rather
 * than the panel's 20 s share. Nothing is cancelled by that bound: the probe
 * still lands in the cache the popup polls, so the figures arrive late rather
 * than not at all.
 */
test('the composer refresh answers inside the host relay budget', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-relay-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({
    auth: { accessToken: 'token-0', expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() },
    account: { uin: '900000000001', nickname: 'account-1' },
  }))
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  // The slow read this case is about: far past the relay's cap, and past any
  // budget the pass may set for itself.
  let creditsStarted = false
  let creditsDone = false
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => {
    creditsStarted = true
    await new Promise((resolve) => setTimeout(resolve, 3000))
    creditsDone = true
    return { total: 4242, packages: [] }
  })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  let service
  const context = vm.createContext({
    require: createRequire(path.join(root, 'main.js')),
    module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
        setSettings: async (patch) => { Object.assign(settings, patch) },
        getDataPath: async () => path.join(temporary, 'data'),
        getManifest: () => JSON.parse(fs.readFileSync(path.join(temporary, 'manifest.json'), 'utf8')),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: (entry) => { service = entry } },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await service.start()
    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to refresh against')

    const started = Date.now()
    const answered = await plugin.onRendererCall('xd.composerRefresh', { chip: model.name })
    // The pass has a budget of its own, well inside the host relay's 2 s cap, and
    // it is that constant the host enforces; awaiting the slow read instead would
    // answer after it finished.
    const entry = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
    const budget = /COMPOSER_REFRESH_BUDGET_MS = (\d+)/u.exec(entry)
    assert.ok(budget !== null && Number(budget[1]) <= 2000,
      'the pass budget must stay inside the host relay cap')
    assert.ok(Date.now() - started < 3000, 'and it answers before the slow read could finish')
    assert.ok(creditsStarted, 'the refresh must still start the credentials read it was asked for')
    assert.equal(creditsDone, false,
      'the refresh must answer before the slow read finishes, not wait for it')
    assert.equal(answered.show, true, 'the refresh must answer with the popup document, not a timeout')

    // The probe it started is not cancelled: the rows fill in from the same
    // cache the popup polls, so a late read is late, not lost. Poll for it
    // rather than sleeping past it, so a slow machine does not make this flaky.
    const deadline = Date.now() + 9000
    let after = await plugin.onRendererCall('xd.composerPoints', { chip: model.name })
    while (after.total !== 4242 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      after = await plugin.onRendererCall('xd.composerPoints', { chip: model.name })
    }
    assert.equal(after.total, 4242, 'the late probe must still reach the popup cache')
  } finally {
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
