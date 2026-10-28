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
 * declaration cleared, the same normalization the packaging step applies: a
 * local run of the plugin writes that declaration back into the repo copy, and
 * a test must not inherit whatever the last run published.
 */
function writeManifestFixture(target) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.contributes) manifest.contributes.providers = []
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

/** The slice of an `<input>` the panel touches, with listeners a case can fire. */
function fakeInput() {
  const listeners = {}
  return {
    type: '', className: '', max: '', min: '', step: '', value: '',
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler) },
    dispatch(type) { for (const handler of listeners[type] || []) handler({ target: this }) },
  }
}

/**
 * Named panel declarations, evaluated together and callable.
 *
 * `renderer/panel.js` boots on load, so it cannot be evaluated whole. Lifting
 * the named functions out with brace matching is what lets a case drive the real
 * control rather than scan its text: a bound the page never wires up, or a guard
 * whose `return` was dropped, then fails the case where a source match would
 * still pass.
 */
function panelFunctions(names, source) {
  const parts = []
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(source.slice(from, index + 1))
  }
  const ceiling = /var MAX_TOKEN_BUDGET = 0x[0-9a-f]+;/.exec(source)
  const context = vm.createContext({
    document: { createElement: () => fakeInput() },
    String, Number, Math, console,
  })
  if (ceiling) parts.unshift(ceiling[0])
  vm.runInContext(parts.join('\n'), context)
  return context
}

test('WorkBuddy refresh stays on demand across service restarts', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'), autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({ auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'test-user' } }))
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const models = t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  let service
  let now = Date.now()
  const timers = new Set()
  const context = vm.createContext({
    require: createRequire(path.join(root, 'main.js')),
    module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch,
    Date: class extends Date { static now() { return now } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    setInterval: (callback, ms) => { const timer = { callback, at: now + ms }; timers.add(timer); return timer },
    clearInterval: (timer) => timers.delete(timer),
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
        getDataPath: async () => path.join(temporary, 'data'),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: (entry) => { service = entry } },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  const plugin = context.module.exports
  const endpointResponds = async () => {
    const state = await plugin.onPanelInvoke('xd.state')
    if (state.shims.cn.running !== true) return false
    const response = await fetch(state.shims.cn.baseUrl.replace(/\/v1$/, '') + '/healthz', {
      signal: AbortSignal.timeout(1000), headers: { connection: 'close' },
    }).catch(() => null)
    return response !== null && response.ok
  }
  try {
    await plugin.onLoad()
    await service.start()
    assert.equal(await endpointResponds(), true, 'initial endpoint must respond')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(models.mock.callCount(), 1, 'startup must seed the catalog once')
    // Past every interval the entry arms, the token keep-alive's own included.
    // That switch is off for this case (see the settings above), so nothing
    // here may spend a token refresh the case never asked about.
    now += 31 * 60 * 1000
    for (const timer of timers) if (timer.at <= now) timer.callback()
    // No count assertion here on purpose. A background timer may start async work
    // whose fetch lands at an arbitrary point, so reading the count after a fixed
    // delay was a coin flip. The invariant it was guarding is carried by the count
    // below instead, and deterministically: anything that fetched between startup
    // and this panel read shows up there as one too many.
    assert.equal((await plugin.onPanelInvoke('xd.state')).refreshing, true, 'opening the panel must refresh a stale catalog')
    let state
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      state = await plugin.onPanelInvoke('xd.state')
      if (!state.refreshing) break
    }
    assert.equal(state.refreshing, false, 'the on-demand refresh must settle')
    assert.equal(models.mock.callCount(), 2, 'opening the panel must fetch the stale catalog once, and nothing before it may have')
    await plugin.onPanelInvoke('xd.state')
    assert.equal(models.mock.callCount(), 2, 'a fresh panel open must use the cached catalog')
    await plugin.onPanelInvoke('xd.state', { wait: true })
    assert.equal(models.mock.callCount(), 3, 'manual refresh must refetch a fresh catalog')
    await service.stop()
    await service.start()
    assert.equal(await endpointResponds(), true, 'restarted endpoint must respond')
    let release
    let reading
    const started = new Promise((resolve) => { reading = resolve })
    t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', () => new Promise((resolve) => { release = resolve; reading() }))
    const rescan = plugin.onPanelInvoke('xd.rescan')
    await started
    await service.stop()
    release([])
    assert.equal((await rescan).shims.cn.running, false, 'a late refresh must not restart a stopped endpoint')
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('Qoder failure preceding output in the same packet remains an HTTP error', async () => {
  const { openQoderResponse } = require('../lib/qoder-shim')
  const wire = 'data: {"code":105,"message":"Login expired"}\n\n'
    + 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n'
  const response = await openQoderResponse(new Response(wire), 'qmodel')
  try {
    assert.equal(response.status, 401)
  } finally {
    await response.body?.cancel().catch(() => {})
  }
})

test('vendor requests refuse redirects before sending custom token headers elsewhere', async () => {
  const { createServer } = require('node:http')
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const { TraeSoloUpstreamClient } = require('../lib/trae-upstream')
  const leaked = []
  const sink = createServer((req, res) => {
    leaked.push(req.headers['x-refresh-token'] || req.headers['x-ide-token'])
    res.end('{"code":0,"data":{"accessToken":"refreshed"}}')
  })
  const redirect = createServer((req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/unexpected` }).end()
  })
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve))
  const fetchImpl = (url, init) => fetch(`http://127.0.0.1:${redirect.address().port}/vendor`, init)
  try {
    await new WorkBuddyUpstreamClient({ fetchImpl }).refreshToken({
      accessToken: 'test-access', refreshToken: 'test-refresh', domain: '', expiresAtMs: 0,
    }).catch(() => {})
    await new TraeSoloUpstreamClient({
      credential: async () => ({ accessToken: 'test-trae', userId: 'test', edition: 'cn', source: 'desktop', host: '', expiresAtMs: 0 }),
      identity: async () => ({ machineId: 'test', deviceId: 'test', platform: 'win32' }), fetchImpl,
    }).chatStream('{"model":"glm","messages":[]}')
    assert.deepEqual(leaked, [])
  } finally {
    await Promise.all([sink, redirect].map((server) => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    })))
  }
})

for (const source of ['qoder', 'trae']) {
  test(`${source} relay ends a failed stream in a way a client can finish on`, async () => {
    const { bridgeQoderStream } = require('../lib/qoder-shim')
    const { bridgeTraeStream } = require('../lib/trae-shim')
    let cancelled = false
    const wire = source === 'qoder'
      ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"code":105,"message":"Login expired"}\n\n'
      : 'event: output\ndata: {"response":"hello"}\n\nevent: error\ndata: {"code":5001,"message":"failed"}\n\n'
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(wire)) },
      cancel() { cancelled = true },
    })
    const relay = source === 'qoder' ? bridgeQoderStream(upstream, 'model') : bridgeTraeStream(upstream, 'model')
    let timer
    try {
      const outcome = await Promise.race([
        new Response(relay).text().then((body) => ({ body }), () => ({ error: true })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 200) }),
      ])
      assert.equal(outcome.timeout, undefined, 'a failure must not wait for upstream EOF')
      assert.equal(outcome.error, undefined, 'a failed stream must not error the controller')
      // The client already holds a 200 at this point, so the stream has to end
      // in the shape a client can finish on. Erroring it instead left a
      // truncated body with neither marker, so every client waited out its own
      // timeout on a turn that had already failed.
      assert.match(outcome.body, /finish_reason/)
      assert.match(outcome.body, /\[DONE\]/)
      assert.equal(cancelled, true, 'failed upstream must be cancelled')
    } finally {
      clearTimeout(timer)
    }
  })
}

test('account scans drop deleted sign-ins but keep unreadable directories', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-scan-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const file = path.join(auth, 'login.info')
  fs.writeFileSync(file, JSON.stringify({ auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'test-user' } }))
  const pool = new WorkBuddyAccountPool({ authDirs: [auth] })
  try {
    assert.equal((await pool.scan()).length, 1)
    fs.renameSync(auth, auth + '-hidden')
    assert.equal((await pool.scan()).length, 1, 'an unreadable directory must not erase a cached account')
    fs.renameSync(auth + '-hidden', auth)
    fs.unlinkSync(file)
    assert.equal((await pool.scan()).length, 0, 'a readable directory must remove deleted sign-ins')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('growth rewards accept numeric strings and normalize tier status', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {
    streak: { days: '7' }, redemption_status: { tiers: [{ tier: 'seven', days: '7', credit: '100', energy: '2' }], tier_seven_status: 'UNLOCKED' },
  } })) })
  const credential = { accessToken: 'test', refreshToken: '', domain: '', expiresAtMs: 0 }
  const streak = await client.growthStreakFull(credential)
  assert.equal(streak.days, 7)
  assert.deepEqual(streak.tiers[0], { tier: 'seven', days: 7, credit: 100, energy: 2, status: 'unlocked' })
})

/**
 * The streak's one-off collections must ask the paths that answer.
 *
 * The gift and compensation endpoints sit on the billing host without a `/v2`
 * prefix; with one they reply `404 route not found`, which reads as "nothing to
 * collect" and silently loses the credits. A make-up target is a calendar day in
 * the check-in zone, not the host's zone.
 */
test('streak collections use the paths the upstream answers on', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const { zonedDay } = require('../lib/checkin-time')
  const calls = []
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    return new Response(JSON.stringify({ code: 0, data: { credit: 25 } }))
  } })
  const credential = { accessToken: 'test', refreshToken: '', domain: '', expiresAtMs: 0 }

  assert.equal(await client.claimGift(credential), 25)
  assert.equal(await client.claimCompensation(credential), 25)
  await client.useMakeupCard(credential, '2026-10-18')

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/billing/meter/claim-gift',
    '/billing/meter/claim-compensation',
    '/activity/growth/makeup-cards/use',
  ], 'a /v2 prefix turns these into 404s')
  assert.deepEqual(JSON.parse(calls[2].body), { target_date: '2026-10-18' })
  assert.match(zonedDay(0), /^\d{4}-\d{2}-\d{2}$/)
  assert.notEqual(zonedDay(-1), zonedDay(0), 'yesterday is a different day')
})

for (const source of ['qoder', 'trae']) {
  test(`${source} directory reads do not advance chat rotation`, async (t) => {
    const purposes = []
    const client = source === 'qoder' ? require('../lib/qoder-client').QoderUpstreamClient : require('../lib/trae-upstream').TraeSoloUpstreamClient
    t.mock.method(client.prototype, 'fetchModels', async () => (source === 'trae'
      ? { models: [{ id: 'test-model', name: 'test-model', function: 'chat' }], partial: false }
      : [{ id: 'test-model', name: 'test-model', function: 'chat' }]))
    t.mock.method(client.prototype, 'chatStream', async () => ({ ok: true, response: new Response(source === 'qoder' ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' : 'event: output\ndata: {"response":"hello"}\n\n') }))
    const gateway = source === 'qoder'
      ? require('../lib/qoder-gateway').createQoderGateway({ region: 'cn', port: 0, credentials: async (purpose) => { purposes.push(purpose); return [{ token: 'test', region: 'cn' }] }, logger: { info() {}, warn() {}, error() {} } })
      : require('../lib/trae-gateway').createTraeGateway({ port: 0, credentials: async (purpose) => { purposes.push(purpose); return [{ accessToken: 'test', edition: 'cn' }] }, identity: async () => ({ machineId: 'test', deviceId: 'test', platform: 'win32' }), logger: { info() {}, warn() {}, error() {} } })
    try {
      await gateway.ready
      const response = await fetch(gateway.baseUrl() + '/v1/models', { headers: { connection: 'close' } })
      assert.equal(response.status, 200)
      await response.text()
      assert.deepEqual(purposes, [undefined], 'directory lookup must not identify itself as a chat turn')
      const chat = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ model: 'test-model', messages: [] }),
      })
      assert.equal(chat.status, 200)
      await chat.text()
      assert.deepEqual(purposes, [undefined, 'chat'], 'only a chat request must advance rotation')
    } finally { await gateway.close() }
  })
}

/**
 * A Qoder round that has not opened yet must be collected when it does.
 *
 * Qoder re-issues its daily round at 10:00 Beijing, and the configured check-in
 * hour is 09:00. Before 10:00 the claim answers "nothing to claim" and carries
 * the opening time, which the tick uses to come back for Qoder alone. That
 * write-back lived in `autoCheckinTick` only; when the pass moved into
 * `runCheckinPass`, the tick kept the reader and lost the writer, so the opening
 * time was dropped, the slot counted as spent, and that day's Qoder credits were
 * never collected —?silently, because a pass that finds nothing to claim is not
 * an error.
 *
 * The claim under test: after a pass that found Qoder's round unopened, the tick
 * runs Qoder again at the opening time. The opening time is the only thing that
 * can carry it across, so this fails on a pass that does not record it.
 */
test('a Qoder round that is not open yet is collected when its window opens', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-qoder-test-'))
  writeManifestFixture(temporary)
  let now = Date.now()
  const opensAt = now + 60000
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: true,
    disabledRegions: ['qoder:global'], authFile: path.join(temporary, 'none', 'login.info'),
    autoCheckin: { enabled: true, hours: [9] },
  }
  const lines = []
  let opened = false
  // The modules underneath `main.js` run in the real realm, so the fake clock
  // only governs the host: the opening time handed to Qoder has to be a real
  // timestamp for the client's own window check to read it as "not yet". The
  // deferred call flips it to an open round so the claim path is exercised too.
  const qoder = require('../lib/qoder-credentials')
  const client = require('../lib/qoder-client')
  class FakeQoderClient extends client.QoderUpstreamClient {
    async fetchCampaigns() {
      // A round that exists but has not opened: exactly what an 09:00 pass sees.
      return { campaigns: [{ actionType: 'CLAIM_BENEFIT', campaignId: 'today',
        startAt: opened ? Date.now() - 1000 : opensAt }] }
    }
    async claimCampaign() { return { success: true, grantId: 'claim-1' } }
    async fetchUsage() { return { userQuota: { remaining: 5, total: 10 }, dedicatedPackages: [] } }
    async fetchModels() { return [{ id: 'qoder-model' }] }
  }
  const qoderDiscovery = Object.create(qoder, {
    discoverQoderCredentials: { value: async () => ({
      credentials: [{ region: 'cn', userID: 'qoder-user', token: 'qoder-token', name: '', email: '', expiresAtMs: now + 3600000 }],
      failures: [],
    }), enumerable: true },
  })
  const qoderClient = Object.create(client, { QoderUpstreamClient: { value: FakeQoderClient, enumerable: true } })
  const timers = new Set()
  let service
  const context = vm.createContext({
    require: (id) => {
      if (id === './lib/qoder-credentials') return qoderDiscovery
      if (id === './lib/qoder-client') return qoderClient
      return createRequire(path.join(root, 'main.js'))(id)
    },
    module: { exports: {} }, __dirname: temporary,
    console: { log: (line) => lines.push(String(line)) }, AbortController, AbortSignal, fetch,
    // The tick reads `new Date()`, so the clock itself must be the fake one:
    // patching `Date.now` alone left the tick comparing a real timestamp
    // against the mocked one and skipping the branch under test.
    Date: class extends Date {
      constructor(...args) { super(...args.length === 0 ? [now] : args) }
      static now() { return now }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    setInterval: (callback, ms) => { const timer = { callback, at: now + ms }; timers.add(timer); return timer },
    clearInterval: (timer) => timers.delete(timer),
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
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
    await plugin.onPanelInvoke('xd.runCheckinNow')
    assert.deepEqual(
      lines.filter((line) => line.includes('deferred Qoder check-in')), [],
      'a round that has not opened must not be reported as a deferred collection yet',
    )
    // A source-only click must not cancel the deferral the full pass just set.
    // The old unconditional write replaced it with the placeholder's zero.
    await plugin.onPanelInvoke('xd.checkinAll', { source: 'trae' })
    const slots = JSON.parse(fs.readFileSync(path.join(temporary, 'data', 'checkin-slots.json'), 'utf8'))
    assert.equal(slots._qoderRetryAt, opensAt,
      'the deferred Qoder time must survive another source and be written for a reload')
    // Now the window opens: the tick that was already scheduled must collect Qoder.
    opened = true
    now = opensAt + 1000
    for (const timer of timers) if (timer.at <= now) timer.callback()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const deferred = lines.filter((line) => line.includes('deferred Qoder check-in'))
    assert.equal(deferred.length, 1,
      'the tick must come back for Qoder at the opening time it was told about')
    assert.match(deferred[0], /"claimed":1/,
      'the deferred round must actually claim, not merely report another wait')
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A caller that stops waiting is this plugin working, not an upstream failure.
 *
 * `res.on('close')` aborts the relay so a cancelled turn stops spending the
 * account's credits, and that abort reaches the body as an error. Recorded as
 * an upstream failure it wrote one warning per cancelled turn —?4484 of them on
 * one machine, a third of every line this plugin had ever logged —?which buried
 * the failures worth reading.
 *
 * Both halves are asserted, because either alone is satisfiable by moving in
 * the wrong direction: a hang-up is silent, and an upstream that falls over on
 * its own still warns. The upstream stream is endless, so the caller's hang-up
 * is the only thing that can end it —?without that, an upstream that answered
 * once and closed would satisfy the first half for the wrong reason.
 */
test('a caller hang-up is not logged as an upstream stream failure', async () => {
  const { createServer, request } = require('node:http')
  const { createTraeGateway } = require('../lib/trae-gateway')
  const { createQoderGateway } = require('../lib/qoder-gateway')
  const { createWorkBuddyShim } = require('../lib/shim')

  const WARNING = {
    trae: 'trae relay stream failed mid-flight',
    qoder: 'qoder relay stream failed mid-flight',
    workbuddy: 'upstream stream failed mid-flight',
  }
  // The first frame each upstream family reads as output.
  const OPENING = {
    trae: 'event: output\ndata: {"response":"hello"}\n\n',
    qoder: 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
    workbuddy: 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
  }
  const TRAE_ROSTER = { config_info_list: [{ config_name: 'fixture-model', display_config: { display_name: 'Fixture' } }] }
  const QODER_ROSTER = { chat: [{ key: 'fixture-model', display_name: 'Fixture', enable: true }] }
  const traeCredential = {
    accessToken: 'fixture-token', userId: 'fixture', host: '', expiresAtMs: Date.now() + 3600000,
    edition: 'cn', source: 'desktop',
  }
  const traeIdentity = { machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32', osVersion: 'fixture' }
  const qoderCredential = { userID: 'fixture', token: 'fixture-token', machineID: 'fixture' }
  const BODY = { model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }

  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const stop = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const answers = (document) => createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(document))
  })
  /** Streams until the caller goes away, unless `fails` makes it fall over. */
  const upstream = (wire, fails) => createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(wire)
    if (fails) { setTimeout(() => { try { res.socket.destroy() } catch { /* already gone */ } }, 60); return }
    const keep = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { clearInterval(keep) } }, 50)
    res.on('close', () => clearInterval(keep))
  })
  /** Re-point every upstream call at this box, so nothing leaves the machine. */
  const localFetch = (routes) => (url, init) => {
    const target = new URL(url)
    const host = routes.find((route) => route.match.test(target.pathname))
    return fetch(host === undefined ? url : `http://127.0.0.1:${host.port}${target.pathname}`, { ...init, redirect: 'error' })
  }
  // The caller's signal has to reach the upstream read: that forwarding is what
  // makes the hang-up abort the body, which is the path under test.
  const shimClient = (port) => ({
    prepareChatBody: (raw) => raw,
    chatStream: async (_credential, _prepared, signal) => ({
      ok: true,
      response: await fetch(`http://127.0.0.1:${port}/v2/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
      }),
    }),
  })
  const poolFixture = () => ({
    acquire: async () => ({ id: 'a', label: 'fixture', credential: { accessToken: 'x', domain: '', expiresAtMs: 0 } }),
    list: () => [], isDisabled: () => false, refreshAccount: async () => false, penalize() {},
  })
  const catalogFixture = { visible: () => [{ id: 'fixture-model' }], current: () => [{ id: 'fixture-model' }] }

  /** Hang up as soon as the first byte of the reply lands. */
  const hangUp = async (port) => {
    await new Promise((resolve) => {
      const sent = request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Authorization: 'Bearer x' },
      }, (response) => {
        response.once('data', () => { sent.destroy(); resolve() })
        response.on('end', resolve)
      })
      sent.on('error', () => resolve())
      sent.end(JSON.stringify(BODY))
      setTimeout(resolve, 2000)
    })
    await wait(300)
  }

  /** Run one turn against a real gateway; return the warnings it wrote. */
  const run = async (source, fails) => {
    const lines = []
    const logger = { info() {}, warn: (...args) => lines.push(args.map(String).join(' ')) }
    const stream = upstream(OPENING[source], fails)
    const streamPort = await listen(stream)
    const roster = answers(source === 'trae' ? TRAE_ROSTER : QODER_ROSTER)
    const rosterPort = await listen(roster)
    const fetchImpl = localFetch([
      { match: source === 'trae' ? /get_detail_param|remote\/v1\/models/ : /model\/list/, port: rosterPort },
      { match: /./, port: streamPort },
    ])
    const gateway = source === 'trae'
      ? createTraeGateway({ credentials: async () => [traeCredential], identity: async () => traeIdentity, logger, fetchImpl })
      : source === 'qoder'
        ? createQoderGateway({ region: 'cn', credentials: async () => [qoderCredential], logger, fetchImpl })
        : createWorkBuddyShim({ pool: poolFixture(), client: shimClient(streamPort), catalog: catalogFixture, logger })
    try {
      await gateway.ready
      if (fails) {
        // Read to completion: no hang-up here, the upstream itself falls over.
        const response = await fetch(`http://127.0.0.1:${gateway.port()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
          body: JSON.stringify(BODY),
        })
        await response.text().catch(() => {})
        await wait(250)
      } else {
        await hangUp(gateway.port())
      }
    } finally {
      await gateway.close()
      await stop(stream)
      await stop(roster)
    }
    return lines.filter((line) => line.includes(WARNING[source]))
  }

  for (const source of ['trae', 'qoder', 'workbuddy']) {
    assert.deepEqual(await run(source, false), [], `${source}: a hang-up must not be logged as an upstream failure`)
    assert.ok((await run(source, true)).length > 0, `${source}: a genuine upstream failure must still warn`)
  }
})

/**
 * A sign-in that carries no expiry is live, not expired.
 *
 * Trae omits `expiresAt` on some installs, and the discovery layer answers `0`
 * when it is absent; Qoder answers `0` for an `expiresAt` that does not parse
 * as a date. `0` therefore means "no expiry known", not "expired at the epoch".
 * Read against `Date.now()` it came out expired, and the same comparison inside
 * `traeRowProbe`/`qoderRowProbe` skipped the probe outright, so such an account
 * was listed as expired and never carried its quota. `sourceCredentialExpired`
 * is the single place that decides, and it requires a positive timestamp before
 * it will call a sign-in expired.
 *
 * The claim under test: a `0`-expiry sign-in is listed as live, and it is still
 * probed. Both halves fail on a bare `<= Date.now()` comparison.
 */
test('a sign-in with no expiry is live, not expired', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-noexpiry-test-'))
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: true, sourceQoder: false,
    disabledRegions: ['trae:ai'], autoCheckin: { enabled: false, hours: [9] },
  }
  const trae = require('../lib/trae-discovery')
  const traeUpstream = require('../lib/trae-upstream')
  // `0` is what the discovery layer produces when the stored document has no
  // usable expiry - the value every sign-in of that shape arrives with.
  t.mock.method(traeUpstream.TraeSoloUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ code: 0, enable: true, checkedIn: false, credits: 3 }))
  t.mock.method(traeUpstream.TraeSoloUpstreamClient.prototype, 'fetchUsageSummary', async () => ({ credits: [], packs: [] }))
  const traeDiscovery = Object.create(trae, {
    discoverTraeCredentials: { value: async () => ({
      credentials: [{ accessToken: 'trae-token', userId: 'trae-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: 0 }],
      failures: [],
    }), enumerable: true },
  })
  let service
  const context = vm.createContext({
    require: (id) => {
      if (id === './lib/trae-discovery') return traeDiscovery
      return createRequire(path.join(root, 'main.js'))(id)
    },
    module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
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
    // Filled by the refresh pass behind the load, so poll the way the panel does.
    let state
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = await plugin.onPanelInvoke('xd.state')
      if (state.trae.accounts.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(state.trae.accounts.length, 1, 'a sign-in with no expiry must be listed')
    assert.equal(state.trae.accounts[0].expired, false, 'an unknown expiry is not an expiry that has passed')
    assert.ok(state.trae.accounts[0].checkin, 'a sign-in with no expiry must still be probed for its check-in')
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * A fresh load must bring up the gateways it declares.
 *
 * `onLoad` publishes the provider declaration through `publishDeclarationEarly`,
 * which starts the gateways so the address it writes into the manifest is
 * already listening - the host reads that declaration and hands the address to
 * the picker before any service hook runs. A flag that only clears in
 * `onServiceStart` turns that start into a no-op, and the plugin then advertises
 * an endpoint that answers nothing until the host calls the service hook. This
 * test drives `onLoad` alone, which is what makes the difference visible.
 */
test('a load brings up the gateways it declares, before the service hook', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-loadgateway-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'), autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({ auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'test-user' } }))
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  // An empty roster keeps the static fallback, so the gateway has a model list
  // to publish without reaching the network.
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const context = vm.createContext({
    require: createRequire(path.join(root, 'main.js')),
    module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
        getDataPath: async () => path.join(temporary, 'data'),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: () => {} },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  const plugin = context.module.exports
  try {
    // Deliberately no `service.start()`: the load alone must leave a listening
    // endpoint behind, because that is the address the host was just handed.
    await plugin.onLoad()
    const state = await plugin.onPanelInvoke('xd.state')
    assert.equal(state.shims.cn.running, true, 'the load must bind the endpoint it declared')
    const response = await fetch(state.shims.cn.baseUrl.replace(/\/v1$/, '') + '/healthz', {
      signal: AbortSignal.timeout(1000), headers: { connection: 'close' },
    })
    assert.equal(response.ok, true, 'the declared endpoint must answer')
    const manifest = JSON.parse(fs.readFileSync(path.join(temporary, 'manifest.json'), 'utf8'))
    assert.equal(manifest.contributes.providers.length, 1, 'the load must publish the gateway it started')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * Clicking an account the pool cannot serve must say so.
 *
 * The popup lists every account in the pool but marks the one the next request
 * would use, and those are not the same set: a cooling, switched-off or
 * reserve-held account is listed yet skipped by `pool.available`. Storing the
 * preference for one of those changes nothing this session, so answering with a
 * bare success made the popup close on a click that switched nothing. The choice
 * still applies once the account recovers, which is why the answer keeps it and
 * flags it instead of refusing outright.
 */
test('switching to an account the pool cannot serve is reported, not silently accepted', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-unavailable-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
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
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    const accounts = state.accounts.filter((account) => account.region === 'cn')
    assert.equal(accounts.length, 4)
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to switch against')

    const points = await plugin.onRendererCall('xd.composerPoints', { chip: model.name })
    assert.equal(points.show, true)
    assert.equal(points.accounts.length, 4)
    const fourth = points.accounts[3]
    assert.equal(fourth.active, false, 'the fourth account starts out not serving')

    // Switch it off on the panel: still listed in the pool, no longer servable.
    await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: fourth.id, state: 'disabled' })

    const refused = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(refused.show, true, 'the click is answered, not dropped')
    assert.equal(refused.unavailable, true, 'an account the pool skips must be reported as unavailable')
    const active = refused.accounts.find((account) => account.active === true)
    assert.notEqual(active?.id, fourth.id, 'a switched-off account must not be marked as serving')
    assert.equal(settings.preferredAccountIds.cn, fourth.id, 'the choice is still stored for when it recovers')

    // A servable account is the control: it switches and is not flagged.
    const first = points.accounts[0]
    const switched = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: first.id, accountLabel: first.label,
    })
    assert.equal(switched.unavailable, undefined, 'a servable account must not be flagged')
    assert.equal(switched.accounts.find((account) => account.active === true)?.id, first.id)
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * A rate limit on one model must not read as "switchable".
 *
 * A 429 cools one (account, model) pair - the upstream lets the same account
 * carry on with another model - so an account can be perfectly live while the
 * model the composer is showing is cooling on it. That is the pool's own answer
 * to `available(now, modelId, region)`, and the popup marks its rows with
 * exactly it, so a click handler asking anything looser (no model id, i.e.
 * account-wide cooldowns only) calls that account servable and closes the popup
 * on a switch that changed nothing.
 */
test('an account cooling on the selected model is reported, not silently accepted', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-modelcool-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // The first attempt is the account the preference just named, so exactly that
  // account is rate-limited and the rotation has to land on a healthy one behind
  // it. The 429 is driven through the gateway rather than `pool.penalize`
  // because keying the cooldown to the model is the shim's doing, and that is
  // the state under test.
  let attempts = 0
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'chatStream', async () => {
    attempts += 1
    if (attempts === 1) {
      return { ok: false, kind: 'soft_rate', status: 429, message: `{"resetAt":${Date.now() + 3600000}}` }
    }
    return { ok: true, response: new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }
  })
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
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    assert.equal(state.shims.cn.running, true, 'the cn gateway must be listening')
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to switch against')

    const points = await plugin.onRendererCall('xd.composerPoints', { chip: model.name })
    assert.equal(points.show, true)
    assert.equal(points.accounts.length, 4)
    const fourth = points.accounts[3]

    const chosen = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(chosen.unavailable, undefined, 'a live account switches without a flag')
    assert.equal(chosen.accounts.find((account) => account.active === true)?.id, fourth.id)

    const port = Number(new URL(state.shims.cn.baseUrl).port)
    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      body: JSON.stringify({ model: model.id, stream: false, messages: [{ role: 'system', content: 'hi' }] }),
    })
    await answer.text()
    assert.equal(answer.status, 200, 'the healthy accounts behind the cooled one must still serve')
    assert.equal(attempts, 2, 'the request must rotate exactly once, past the cooled account')

    const cooled = await plugin.onRendererCall('xd.composerPoints', { chip: model.name })
    assert.equal(cooled.accounts.find((account) => account.id === fourth.id).active, false,
      'a model-cooled account must not be marked as serving')

    const refused = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(refused.show, true, 'the click is answered, not dropped')
    assert.equal(refused.unavailable, true, 'an account the pool skips for this model must be reported as unavailable')
    assert.notEqual(refused.accounts.find((account) => account.active === true)?.id, fourth.id,
      'a model-cooled account must not be marked as serving')

    // The control: an account live on this same model switches and is not flagged.
    const other = points.accounts[0]
    const switched = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: other.id, accountLabel: other.label,
    })
    assert.equal(switched.unavailable, undefined, 'an account live on this model must not be flagged')
    assert.equal(switched.accounts.find((account) => account.active === true)?.id, other.id)
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * Switching accounts while a reply is in flight must not cut it off.
 *
 * The panel stores a preference and the host announces the merged settings
 * document back, which re-applies the selection and reconciles the gateways. A
 * parked region is meant to lose its listener there - but the region the reply
 * is streaming through is not parked, so its socket has to survive the pass.
 * Rebinding the endpoint under a running turn would close the stream the user is
 * reading, which reads as the model giving up mid-sentence.
 */
test('switching accounts during a reply does not cut the stream', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-midreply-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // A reply that lands its first chunk, then waits: the window in which the
  // user clicks another account.
  let opened
  const streaming = new Promise((resolve) => { opened = resolve })
  let release
  const held = new Promise((resolve) => { release = resolve })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'chatStream', async () => ({
    ok: true,
    response: new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        opened()
        await held
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  }))
  let onSettings
  let service
  const context = vm.createContext({
    require: createRequire(path.join(root, 'main.js')),
    module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, ReadableStream,
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
        setSettings: async (patch) => { Object.assign(settings, patch) },
        getDataPath: async () => path.join(temporary, 'data'),
        getManifest: () => JSON.parse(fs.readFileSync(path.join(temporary, 'manifest.json'), 'utf8')),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: (entry) => { service = entry } },
      events: { on: (name, handler) => { if (name === 'plugin:settingsChanged') onSettings = handler }, off: () => { onSettings = undefined } },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(typeof onSettings, 'function', 'the host must be able to announce a settings change')

    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    const port = Number(new URL(state.shims.cn.baseUrl).port)
    const controller = new AbortController()
    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      body: JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'system', content: 'hi' }] }),
      signal: controller.signal,
    })
    assert.equal(answer.status, 200, 'the turn must start')
    await streaming

    // The user clicks another account mid-answer. That stores the preference and
    // the host echoes the document back, exactly as the desktop app does.
    const points = await plugin.onRendererCall('xd.composerPoints', { chip: model.name })
    const target = points.accounts.find((account) => account.active === false)
    const switched = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: target.id, accountLabel: target.label,
    })
    assert.equal(switched.unavailable, undefined, 'a live account switches while a reply is streaming')
    await onSettings({ ...settings, preferredAccountIds: { ...(settings.preferredAccountIds ?? {}), cn: target.id } })
    await new Promise((resolve) => setTimeout(resolve, 250))

    // The socket the turn is reading must still be open, and finishing it must
    // still reach the client. A closed socket raises here rather than draining,
    // so the read is caught and reported as the stream being cut.
    assert.equal(controller.signal.aborted, false, 'the turn must not be aborted by the settings pass')
    release()
    const body = await answer.text().catch((error) => { throw new Error('the reply already in flight was cut off: ' + error.message) })
    assert.ok(body.includes('hi'), 'the reply already in flight must still be delivered')
    assert.ok(body.includes('[DONE]'), 'the reply must still be terminated, not truncated')
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * The account picked in the panel must be the account that serves.
 *
 * `xd.preferAccount` is the settings-side twin of the composer's switch, and it
 * has to end in the pool: storing the id alone leaves the choice on the page and
 * the previous account still taking every request, which looks like the picker
 * refusing to stick. Switching the chosen account off has to release the
 * preference too, or the pool keeps asking for an id it may not hand out.
 */
test('the account picked in the panel is the account that serves', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-pickaccount-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // Which token the gateway actually spent, in order, and which token belongs
  // to which account id - so an assertion can name an account rather than a
  // position in the queue.
  const served = []
  const { workbuddyAccountId } = require('../lib/accounts')
  const tokenOf = {}
  for (const index of [0, 1, 2, 3]) tokenOf[workbuddyAccountId({ uin: `90000000000${index}` })] = `token-${index}`
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'chatStream', async (credential) => {
    served.push(credential.accessToken)
    return { ok: true, response: new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }
  })
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
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    const port = Number(new URL(state.shims.cn.baseUrl).port)
    const turn = async () => {
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
        body: JSON.stringify({ model: model.id, stream: false, messages: [{ role: 'system', content: 'hi' }] }),
      })
      await answer.text()
      return served.at(-1)
    }

    const accounts = state.accounts.filter((account) => account.region === 'cn')
    assert.equal(accounts.length, 4)
    const fourth = accounts[3]
    const first = accounts[0]

    // Default distribution: the head of the queue serves.
    assert.equal(await turn(), tokenOf[first.id], 'the first account serves by default')

    // Pick the fourth in the panel, exactly as the picker does.
    const picked = await plugin.onPanelInvoke('xd.preferAccount', { region: 'cn', accountId: fourth.id })
    assert.equal(picked.preferredAccountIds.cn, fourth.id, 'the pick must be stored')
    const pickedRow = picked.accounts.find((account) => account.id === fourth.id)
    assert.equal(pickedRow.preferred, true, 'the panel must mark the picked account as selected')
    assert.equal(pickedRow.active, true, 'a stored pick must be the account the next request uses')
    assert.equal(await turn(), tokenOf[fourth.id], 'the picked account must be the one that serves')

    // Switching the chosen account off must release the choice, not pin the pool
    // to an id it is no longer allowed to hand out.
    const off = await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: fourth.id, state: 'disabled' })
    assert.equal(off.preferredAccountIds.cn, '', 'switching the chosen account off must release the pick')
    assert.equal(off.accounts.find((account) => account.id === fourth.id).preferred, false)
    assert.equal(await turn(), tokenOf[first.id], 'the pool must fall back to an account it can serve')

    // And switching it back on does not silently restore the old pin.
    const on = await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: fourth.id, state: 'enabled' })
    assert.equal(on.preferredAccountIds.cn, '', 'coming back on must stay on automatic')
    assert.equal(await turn(), tokenOf[first.id], 'the released choice must not come back with the account')
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * A stored choice must never be reported as a refusal.
 *
 * `composerPoints` (and so the snapshot `composerPrefer` hands back) answers
 * `show: false` whenever the credits chip is switched off, which can happen
 * between the popup's read and the click. Reading that as a refusal told the
 * user "that account cannot be switched" about a preference that had in fact
 * just been saved and was already in force.
 */
test('a stored account choice is never reported as a refusal', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'xdpool-saved-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  writeManifestFixture(temporary)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
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
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to switch against')
    const fourth = state.accounts.filter((account) => account.region === 'cn')[3]
    assert.ok(fourth !== undefined, 'the roster must list a fourth account to switch to')

    // The chip is switched off after the popup rendered, which is what leaves
    // the answer with no snapshot at all. Driven through the panel's own
    // channel, because the plugin keeps its own copy of the settings.
    await plugin.onPanelInvoke('xd.setComposerPoints', { enabled: false })
    const answered = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(answered.saved, true, 'a stored choice must be reported as stored')
    assert.notEqual(answered.show, true, 'the snapshot really is unavailable, or this proves nothing')
    assert.equal(settings.preferredAccountIds.cn, fourth.id, 'the choice must really have been stored')

    // And a refusal still reports as one: the control.
    await plugin.onPanelInvoke('xd.setComposerPoints', { enabled: true })
    const refused = await plugin.onRendererCall('xd.composerPrefer', {
      chip: model.name, source: 'workbuddy', region: 'cn', accountId: 'no-such-account', accountLabel: 'x',
    })
    assert.equal(refused.saved, undefined, 'a refused click must not claim anything was stored')
    assert.equal(refused.show, false, 'a refused click must show nothing')
  } finally {
    await plugin.onUnload()
    if (service) await service.stop()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('every composer word the popup asks for exists in both languages', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'composer.mjs'), 'utf8')
  const start = source.indexOf('const WORDS = {')
  assert.notEqual(start, -1, 'WORDS must exist')
  const body = source.slice(start, source.indexOf('\n};', start))
  const blocks = [...body.matchAll(/^\s{2}(zh|en): \{([\s\S]*?)\n\s{2}\},/gm)]
    .map((match) => [match[1], new Set([...match[2].matchAll(/\b([A-Za-z]+):/g)].map((word) => word[1]))])
  const dicts = Object.fromEntries(blocks)
  assert.ok(dicts.zh && dicts.en, 'both languages must be present')
  const asked = [...source.matchAll(/\bW\.([A-Za-z]+)/g)].map((match) => match[1])
    .filter((word) => word !== 'addEventListener' && word !== 'removeEventListener')
  assert.ok(asked.length > 0, 'the popup must ask for at least one word')
  for (const word of new Set(asked)) {
    assert.ok(dicts.zh.has(word), `W.${word} is asked for but missing from zh`)
    assert.ok(dicts.en.has(word), `W.${word} is asked for but missing from en`)
  }
})

/**
 * The model sheet's numeric fields must refuse a value the host will not store.
 *
 * `parseOverride` rejects the whole selection payload when one window exceeds
 * the host's ceiling, so a single impossible number discarded every other edit
 * in the same save and reported only "invalid selection payload". The browser
 * bound keeps the figure inside the range the host can store, which is the only
 * place the user can be told which field is at fault.
 *
 * The field is driven, not read: a bound the page never wires up, or a ceiling
 * check that accepts everything, fails here even though the source still names
 * both.
 */
test('a token budget past the host ceiling is refused by the field itself', () => {
  const hostCeiling = /const MAX_TOKEN_BUDGET = (0x[0-9a-f]+)/.exec(
    fs.readFileSync(path.join(root, 'main.js'), 'utf8'))
  assert.ok(hostCeiling, 'the host must declare the ceiling it stores against')
  const ceiling = Number(hostCeiling[1])

  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const declared = /var MAX_TOKEN_BUDGET = (0x[0-9a-f]+)/.exec(source)
  assert.ok(declared, 'the panel must carry the same ceiling the host enforces')
  assert.equal(Number(declared[1]), ceiling,
    'a panel ceiling that drifts from the host one rejects a figure the host would store, or offers one it will not')

  const context = panelFunctions(['numberInput'], source)
  const input = context.numberInput(1000, value => { input.accepted = value })
  assert.equal(input.max, String(ceiling), 'without the attribute the browser offers no bound at all')
  assert.equal(input.value, '1000', 'the field opens on the stored value')

  input.value = String(ceiling + 1)
  input.dispatch('change')
  assert.equal(input.accepted, undefined,
    'a value past the ceiling must not reach the save, or the host discards every other edit with it')
  assert.equal(input.value, '1000', 'a refused value leaves the stored figure in the field')

  input.value = '2000'
  input.dispatch('change')
  assert.equal(input.accepted, 2000, 'a value inside the ceiling must still save')
})

/**
 * A refused number goes back to what is committed, not to what the field showed.
 *
 * The sheet is rebuilt on every repaint, and the field a keypress lands in can be
 * a half-typed number: the row holds the draft's figure, the field holds whatever
 * the user has typed so far. After one accepted edit those two differ, so a
 * refusal that restored the field's own opening text put back a number nobody had
 * finished typing - and one more Enter then saved it.
 */
test('a refused figure goes back to the committed one, not the half-typed text', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const context = panelFunctions(['numberInput'], source)
  const input = context.numberInput(
    '50000',                          // what the rebuilt field opened on
    (value) => { input.accepted = value },
    2000000,
    () => {},
    () => {},
    1000,                             // what is actually stored
  )
  input.value = '5000000'
  input.dispatch('change')
  assert.equal(input.accepted, undefined, 'the impossible figure must not be saved')
  assert.equal(input.value, '1000',
    'and the field shows the committed figure, not the half-typed one a repaint left behind')
})

/**
 * Switching the automatic check-in off must not depend on the hours box.
 *
 * The box can hold stale text from an earlier edit. Requiring it to parse before
 * an OFF would report a failure and leave the timer running while the panel went
 * on showing the schedule as off, which is the one state the user cannot see.
 */
test('switching the automatic check-in off survives an unreadable hours box', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const body = source.slice(source.indexOf('function setAutoCheckin('))
  const handler = body.slice(0, body.indexOf('\n}\n') + 3)
  assert.match(handler, /if \(enabled === true\)/,
    'only switching ON may reject an unreadable hours box')
  assert.match(handler, /autoCheckin\.hours|state\.autoCheckin/,
    'switching OFF must fall back to the stored hours rather than give up')
  const refused = handler.indexOf('auto.badHours')
  const allowed = handler.indexOf('runBusy')
  assert.ok(refused !== -1 && allowed !== -1 && refused < allowed,
    'the refusal must be inside the ON branch, before the save it would otherwise skip')
})

/**
 * The model sheet fills `defaultSelect` after creating the thinking-level row.
 * A second label was pasted in place of the `<select>`, so opening any model
 * with levels threw and the rest of the sheet never rendered.
 */
test('the model sheet creates the default-level select it fills', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const start = source.indexOf('var levels = effectiveLevels')
  assert.notEqual(start, -1)
  const sheet = source.slice(start, source.indexOf('var levelRow', start))
  assert.match(sheet, /var defaultSelect = document\.createElement\("select"\)/,
    'the select has to exist before the options are appended')
  assert.equal((source.match(/var outputCol = field\("models\.maxOutput"/g) || []).length, 1,
    'the output field is created once; a second call steals the input node')
})

/**
 * Every gateway answers the same three refusals, and the Host and Origin ones
 * had no caller of their own: each gateway spelled the sequence out separately,
 * so nothing failed when one of them answered a different status. They now
 * share `guardsPass`, and this is the caller that exercises all three codes
 * through a real listening gateway.
 *
 * `fetch` cannot forge `Host` or a non-loopback `Origin`, and a rebinding
 * attempt is exactly what these guards exist to stop, so the requests go out as
 * raw HTTP over a socket.
 */
test('every gateway refuses a non-loopback Host, a foreign Origin and a malformed bearer', async () => {
  const net = require('node:net')
  const { createTraeGateway } = require('../lib/trae-gateway')
  const { createQoderGateway } = require('../lib/qoder-gateway')
  const { createWorkBuddyShim } = require('../lib/shim')
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')

  /** Send one raw request and return its status and parsed body. */
  const raw = (port, headers) => new Promise((resolve, reject) => {
    // A gateway that accepts but never answers must fail this test, not hang
    // it: `end` is the only other exit, so the deadline is what turns a
    // silent-regression into a red test instead of an unbounded CI job.
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('no answer within 5s')) }, 5000)
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(['GET /healthz HTTP/1.1', ...headers, 'Connection: close', '', ''].join('\r\n'))
    })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { text += chunk })
    socket.on('error', (error) => { clearTimeout(deadline); reject(error) })
    socket.on('end', () => {
      clearTimeout(deadline)
      const status = Number((text.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])
      resolve({ status, body: text.slice(text.indexOf('\r\n\r\n') + 4) })
    })
  })

  const fixtures = {
    pool: {
      acquire: async () => ({ id: 'a', label: 'fixture', credential: { accessToken: 'x', domain: '', expiresAtMs: 0 } }),
      list: () => [], isDisabled: () => false, refreshAccount: async () => false, penalize() {}, status: () => ({}),
    },
    client: new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('{}') }),
    catalog: { visible: () => [{ id: 'fixture-model' }], current: () => [{ id: 'fixture-model' }] },
  }
  const gateways = [
    ['trae', createTraeGateway({
      port: 0,
      credentials: async () => [{ accessToken: 'test', edition: 'cn' }],
      identity: async () => ({ machineId: 'test', deviceId: 'test', platform: 'win32' }),
    })],
    ['qoder', createQoderGateway({ region: 'cn', port: 0, credentials: async () => [{ token: 'test', region: 'cn' }] })],
    ['workbuddy', createWorkBuddyShim({ pool: fixtures.pool, client: fixtures.client, catalog: fixtures.catalog })],
  ]
  try {
    for (const [source, gateway] of gateways) {
      await gateway.ready
      const port = gateway.port()
      // Control: the same raw shape with a loopback Host reaches the router and
      // answers 200, so the 403s below are the guards and not a malformed
      // request. Without this the refusals could pass for the wrong reason.
      const allowed = await raw(port, ['Host: 127.0.0.1'])
      assert.equal(allowed.status, 200, `${source}: a loopback Host must reach the router`)

      const host = await raw(port, ['Host: evil.example.com'])
      assert.equal(host.status, 403, `${source}: a non-loopback Host must be refused`)
      assert.equal(JSON.parse(host.body).error.type, 'host_not_allowed')

      const origin = await raw(port, ['Host: 127.0.0.1', 'Origin: https://evil.example.com'])
      assert.equal(origin.status, 403, `${source}: a foreign Origin must be refused`)
      assert.equal(JSON.parse(origin.body).error.type, 'origin_not_allowed')

      const bearer = await raw(port, ['Host: 127.0.0.1', 'Authorization: Basic abc'])
      assert.equal(bearer.status, 401, `${source}: a non-Bearer Authorization must be refused`)
      assert.equal(JSON.parse(bearer.body).error.type, 'unauthorized')
    }
  } finally {
    await Promise.all(gateways.map(([, gateway]) => gateway.close()))
  }
})

test('a credential echoed by an upstream never survives into the client body', () => {
  const { redactSecrets } = require('../lib/loopback')
  // A real base64 token carries `+`, `/`, `=` and `.`. A rule that stops at the
  // first of those redacts the head and leaves the tail in the response, so the
  // value is checked in every 8-character window, not as a whole.
  const secret = 'abcDEF123+/=ghiJKL456.mnoPQR789'
  const windows = Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8))
  const shapes = [
    `Authorization: Bearer ${secret}`,
    `Cloud-IDE-JWT ${secret}`,
    `X-Refresh-Token: ${secret}`,
    // The vendor credential in the quoted form an upstream echo takes. The header
    // spelling and the JSON field spelling are two shapes, and the field form has
    // no space before its value.
    `{"Cosy-Key":"${secret}"}`,
    `{"Cloud-IDE-JWT":"${secret}"}`,
    `{"X-Api-Key":"${secret}"}`,
    `{"upstream":"{\\"Cosy-Key\\":\\"${secret}\\"}"}`,
    `{"accessToken":"${secret}"}`,
    `?access_token=${secret}&x=1`,
    `{"upstream":"{\\"accessToken\\":\\"${secret}\\"}"}`,
    `qoder-oauth-token-${secret}`,
    `rt_${secret}`,
  ]
  for (const shape of shapes) {
    const out = redactSecrets(shape)
    for (const window of windows) {
      assert.equal(out.includes(window), false, `a credential fragment leaked from: ${shape}`)
    }
  }
  // Redaction must not eat the rest of the line: the fields after a credential are
  // the actionable half of an upstream error body.
  assert.equal(redactSecrets(`{"Authorization":"Bearer ${secret}","next":1}`).includes('"next":1'), true)
  // Prose that merely contains a scheme word is not a credential.
  assert.equal(redactSecrets('the bearer of bad news arrived'), 'the bearer of bad news arrived')
  assert.equal(redactSecrets('invalid Bearer format'), 'invalid Bearer format')
  // The business code is the actionable half of an error and must survive.
  assert.equal(redactSecrets('{"code":6004}').includes('6004'), true)
  assert.equal(redactSecrets('{"code":"soft_rate"}').includes('soft_rate'), true)
})
