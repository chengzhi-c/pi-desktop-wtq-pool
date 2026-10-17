const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createServer, request } = require('node:http')
const encoder = new TextEncoder()
const root = path.resolve(__dirname, '..')

for (const source of ['trae', 'qoder']) {
  test(`${source} completes at its terminal marker without waiting for TCP EOF`, async () => {
    const bridge = source === 'trae' ? require('../lib/trae-shim').bridgeTraeStream : require('../lib/qoder-shim').bridgeQoderStream
    const opening = source === 'trae'
      ? 'event: output\ndata: {"response":"回复完成"}\n\nevent: done\ndata: {}\n\n'
      : 'data: {"choices":[{"delta":{"content":"回复完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    let released = false
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(opening)) },
      cancel() { released = true },
    })
    const reader = bridge(upstream, 'fixture').getReader()
    const read = (async () => { let body = ''; for (;;) { const next = await reader.read(); if (next.done) return body; body += new TextDecoder().decode(next.value) } })()
    let timer
    try {
      const body = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250) })])
      assert.notEqual(body, null, 'a finished reply must not stay in flight until the upstream closes its socket')
      assert.match(body, /回复完成/)
      assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(released, true, 'the finished upstream must be released')
    } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); await read.catch(() => {}) }
  })

  test(`${source} cancellation during catalog loading cannot start a billable chat`, async (t) => {
    const client = source === 'qoder' ? require('../lib/qoder-client').QoderUpstreamClient : require('../lib/trae-upstream').TraeSoloUpstreamClient
    let release, started
    const loading = new Promise(resolve => { started = resolve })
    t.mock.method(client.prototype, 'fetchModels', () => { started(); return new Promise(resolve => { release = resolve }) })
    const calls = []
    const upstream = createServer((req, res) => { calls.push(req.url); res.end('data: [DONE]\n\n') })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const fetchImpl = (url, init) => fetch(`http://127.0.0.1:${upstream.address().port}/spent-credit`, init)
    const gateway = source === 'qoder'
      ? require('../lib/qoder-gateway').createQoderGateway({ port: 0, region: 'cn', credentials: async () => [{ userID: 'fixture', token: 'fixture' }], fetchImpl })
      : require('../lib/trae-gateway').createTraeGateway({ port: 0, credentials: async () => [{ accessToken: 'fixture', userId: 'fixture', edition: 'cn' }], identity: async () => ({ machineId: 'fixture', deviceId: 'fixture', platform: 'win32' }), fetchImpl })
    let req
    try {
      await gateway.ready
      req = request(gateway.baseUrl() + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } })
      req.on('error', () => {})
      req.end('{"model":"fixture","messages":[{"role":"user","content":"cancel"}]}')
      await loading
      req.destroy()
      await new Promise(resolve => setTimeout(resolve, 50))
      release([{ id: 'fixture', name: 'Fixture', function: 'llm_utils_chat' }])
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.deepEqual(calls, [], 'the upstream must not receive a chat after the caller has left')
    } finally { req?.destroy(); release?.([]); await gateway.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
  })
}

test('a partial startup preserves enabled providers whose directories are still warming', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function syncDeclaration\(\) \{[^]*?^\}/m)[0]
  const old = { id: 'xdpool-qoder-cn', models: [{ id: 'saved-qoder' }] }
  const writes = []
  const context = vm.createContext({
    runtimes: new Map([['cn', { signedIn: true }]]),
    activeRegions: () => ['cn'], activeTraeRegions: () => [], activeQoderRegions: () => ['cn'],
    declarationModels: () => [{ id: 'workbuddy' }], traeDeclarationModels: () => [], qoderDeclarationModels: () => [],
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn' }, TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: { cn: old.id },
    descriptorFor: () => ({ id: 'xdpool-cn', models: [{ id: 'workbuddy' }] }), descriptorForTrae() {}, descriptorForQoder() {},
    manifestProviders: () => [old], writeDeclaration: rows => { writes.push(rows); return { ok: true } }, runtimeState: {},
    // A Qoder gateway whose directory has not answered yet is the one case a row
    // is republished for; everything else that cannot publish drops its row.
    warmingGatewayIds: () => new Set([old.id]),
  })
  vm.runInContext(fn + '\nsyncDeclaration()', context)
  assert.deepEqual(Array.from(writes[0], row => row.id), ['xdpool-cn', 'xdpool-qoder-cn'])
})

/**
 * The retained row is scoped to a gateway that is still warming.
 *
 * The other half of the same partial startup: a Qoder gateway that has answered
 * and published nothing is definitively signed out or unreachable, so its saved
 * row must go. Keeping it published a stale model list for as long as the source
 * stayed switched on - the client kept picking a model the account could no
 * longer serve, which is exactly what the rule above says must not happen.
 */
test('a partial startup drops the row of a Qoder gateway that has answered', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function syncDeclaration\(\) \{[^]*?^\}/m)[0]
  const old = { id: 'xdpool-qoder-cn', models: [{ id: 'saved-qoder' }] }
  const writes = []
  const context = vm.createContext({
    runtimes: new Map([['cn', { signedIn: true }]]),
    activeRegions: () => ['cn'], activeTraeRegions: () => [], activeQoderRegions: () => ['cn'],
    declarationModels: () => [{ id: 'workbuddy' }], traeDeclarationModels: () => [], qoderDeclarationModels: () => [],
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn' }, TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: { cn: old.id },
    descriptorFor: () => ({ id: 'xdpool-cn', models: [{ id: 'workbuddy' }] }), descriptorForTrae() {}, descriptorForQoder() {},
    manifestProviders: () => [old], writeDeclaration: rows => { writes.push(rows); return { ok: true } }, runtimeState: {},
    // Nothing is warming: the Qoder directory has answered, and the row it saved
    // is all that is left of a sign-in that is gone.
    warmingGatewayIds: () => new Set(),
  })
  vm.runInContext(fn + '\nsyncDeclaration()', context)
  assert.deepEqual(Array.from(writes[0], row => row.id), ['xdpool-cn'])
})

/**
 * What "warming" means, decided by the real function rather than a stub of it.
 *
 * The two cases above pin `syncDeclaration` against a `warmingGatewayIds` they
 * provide themselves, so neither of them says which runtimes count as warming.
 * This one runs the shipped function over a fake runtime map: a runtime that is
 * still connecting has not landed its roster yet, so its row is worth
 * republishing; a runtime that has settled signed out has answered, and its row
 * is a stale model list for as long as the source stays switched on.
 */
test('a runtime still connecting is warming and a settled signed-out one is not', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function warmingGatewayIds\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(),
    gatewayStartFailures: new Map(),
    activeRegions: () => ['cn'],
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn' },
    traeGateways: new Map(), activeTraeRegions: () => [], TRAE_PROVIDER_ID_BY_REGION: {},
    qoderGateways: new Map(), activeQoderRegions: () => [], QODER_PROVIDER_ID_BY_REGION: {},
  })
  vm.runInContext(fn + '\nwarmingGatewayIds()', context)
  const warming = () => [...vm.runInContext('warmingGatewayIds()', context)]

  // Mid-connect: the roster is still on its way, so dropping the row would cost
  // a roster the gateway already had.
  context.runtimes = new Map([['cn', { signedIn: false, connecting: Promise.resolve() }]])
  assert.deepEqual(warming(), ['xdpool-cn'],
    'a runtime that has not finished connecting must read as warming')
  // Settled: the connect answered and the sign-in is gone, which is a verdict
  // rather than a wait.
  context.runtimes = new Map([['cn', { signedIn: false, connecting: null }]])
  assert.deepEqual(warming(), [], 'a runtime that has settled signed out must not read as warming')
  // No runtime at all is still a roster on its way - the same row is at stake.
  context.runtimes = new Map()
  assert.deepEqual(warming(), ['xdpool-cn'],
    'a region with no runtime yet is still waiting for its first roster')
  // A region whose start failed is not waiting for anything: its shim could not
  // bind, and nothing will bring the row it saved back to life.
  context.gatewayStartFailures = new Map([['cn', 'listen EADDRINUSE']])
  assert.deepEqual(warming(), [],
    'a region whose gateway could not start must not read as warming')
})

/** A Qoder gateway whose directory has not answered yet keeps its saved row. */
test('a Qoder gateway with no error and no roster is warming', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function warmingGatewayIds\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(), gatewayStartFailures: new Map(), activeRegions: () => [], PROVIDER_ID_BY_REGION: {},
    traeGateways: new Map(), activeTraeRegions: () => [], TRAE_PROVIDER_ID_BY_REGION: {},
    qoderGateways: new Map([['cn', { region: 'cn', source: 'qoder', gateway: { models: () => [] }, lastError: '' }]]),
    activeQoderRegions: () => ['cn'], QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn' },
  })
  vm.runInContext(fn + '\nwarmingGatewayIds()', context)
  assert.deepEqual([...vm.runInContext('warmingGatewayIds()', context)], ['xdpool-qoder-cn'],
    'a gateway whose directory read has neither answered nor failed still has a roster in flight')
})

/**
 * A Qoder gateway whose directory failed has nothing left to keep.
 *
 * The failure is a verdict, not a wait: the row it saved would otherwise stay
 * published for as long as the source stayed switched on, serving a model list
 * the account can no longer answer with.
 */
test('a Qoder gateway whose directory read failed is not warming', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function warmingGatewayIds\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(), gatewayStartFailures: new Map(), activeRegions: () => [], PROVIDER_ID_BY_REGION: {},
    traeGateways: new Map(), activeTraeRegions: () => [], TRAE_PROVIDER_ID_BY_REGION: {},
    qoderGateways: new Map([['cn', { region: 'cn', source: 'qoder', gateway: { models: () => [] }, lastError: 'boom' }]]),
    activeQoderRegions: () => ['cn'], QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn' },
  })
  vm.runInContext(fn + '\nwarmingGatewayIds()', context)
  assert.deepEqual([...vm.runInContext('warmingGatewayIds()', context)], [],
    'a directory read that failed is a verdict, so the row it saved must go')
})

/**
 * A gateway that never bound is drift, not health.
 *
 * The address-drift row is the only thing that names `ERR_CONNECTION_REFUSED`
 * for what it is. A gateway whose `listen` lost the port race has no runtime at
 * all, which is the same shape as one still warming up, so the comparison
 * skipped it and the panel reported a healthy session over a provider row the
 * host kept sending requests to with nothing behind it.
 */
test('a gateway that could not bind is reported as address drift', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function addressDrift\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(),
    gatewayStartFailures: new Map(),
    activeRegions: () => ['cn'], activeTraeRegions: () => [], activeQoderRegions: () => [],
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn' },
    TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: {},
    traeGateways: new Map(), qoderGateways: new Map(),
    // The row is gone from this plugin's own manifest - `syncDeclaration` drops
    // the row of a gateway that is down - so only the host's cached copy is left.
    declaredBaseUrl: () => undefined,
    hostDeclaredBaseUrl: () => undefined,
    declaredSourceBaseUrl: () => undefined,
    shimInfo: () => ({ running: false }),
  })
  vm.runInContext(fn + '\naddressDrift()', context)
  const drift = () => vm.runInContext('addressDrift()', context)

  assert.equal(drift(), false, 'with nothing failed and nothing bound there is no drift yet')
  context.gatewayStartFailures = new Map([['cn', 'listen EADDRINUSE']])
  assert.equal(drift(), false,
    'a first start that failed before any row was published has nothing to drift from')
  context.hostDeclaredBaseUrl = () => 'http://127.0.0.1:37891/v1'
  assert.equal(drift(), true,
    'once the host holds the row, a gateway with no shim is drift')
})

for (const [source, terminal, expected] of [
  ['trae', 'event: done\ndata: {}\n\n', ''],
  ['qoder', 'data: [DONE]\n\n', ''],
  ['trae', 'event: done\ndata: {"response":"最后一段"}\n\n', '最后一段'],
]) {
  test(`${source} preflight completes a ${expected === '' ? 'blank' : 'content-bearing'} terminal reply without EOF`, async () => {
    const open = source === 'trae' ? require('../lib/trae-shim').openTraeResponse : require('../lib/qoder-shim').openQoderResponse
    let controller, released = false, timer
    const upstream = new ReadableStream({
      start(next) { controller = next; next.enqueue(encoder.encode(terminal)) },
      cancel() { released = true },
    })
    const read = open(new Response(upstream), 'fixture').then(response => response.text())
    try {
      const body = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250) })])
      assert.notEqual(body, null, 'preflight and relay must both accept a terminal marker without TCP EOF')
      if (expected !== '') assert.ok(body.includes(expected), 'the terminal event must retain its final content')
      assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(released, true)
    } finally {
      clearTimeout(timer)
      try { controller.close() } catch {}
      await read.catch(() => {})
    }
  })
}

test('WorkBuddy closes at a split terminal frame without treating content as a marker', async () => {
  const { createWorkBuddyShim } = require('../lib/shim')
  let controller, released = false, timer
  const upstream = new ReadableStream({
    start(next) {
      controller = next
      next.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"正文中的 [DONE]"}}]}\n\ndata: [DO'))
      next.enqueue(encoder.encode('NE]\n\n'))
    },
    cancel() { released = true },
  })
  const gateway = createWorkBuddyShim({ port: 0,
    pool: { acquire: async () => ({ label: 'fixture', credential: {} }) }, catalog: {},
    client: { prepareChatBody: raw => raw, chatStream: async () => ({ ok: true, response: new Response(upstream) }) },
  })
  const abort = new AbortController()
  let read
  try {
    await gateway.ready
    const response = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: '{"model":"fixture","messages":[{"role":"user","content":"hello"}]}',
    })
    read = response.text()
    const body = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 500) })])
    assert.notEqual(body, null, 'WorkBuddy must complete without waiting for TCP EOF')
    assert.ok(body.includes('正文中的 [DONE]'))
    assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(released, true)
  } finally {
    clearTimeout(timer)
    abort.abort()
    try { controller.close() } catch {}
    await read?.catch(() => {})
    await gateway.close()
  }
})

test('WorkBuddy composer starts a background probe for cold credits without a panel open', async () => {
  const entry = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = entry.match(/^function composerPoints\(args\) \{[^]*?^\}/m)[0]
  let total = null, scheduled = 0
  const context = vm.createContext({
    composerPointsEnabled: () => true,
    matchComposerModel: () => ({ source: 'workbuddy', region: 'cn', id: 'fixture' }),
    workbuddyComposerAccounts: () => [{ active: true, label: 'fixture', total }],
    probesStale: () => total === null,
    scheduleRefresh: () => { scheduled++; setImmediate(() => { total = 500 }) },
  })
  vm.runInContext(fn, context)
  assert.equal(context.composerPoints({ chip: 'fixture', provider: 'xdpool-cn', model: 'fixture' }).total, null)
  assert.equal(scheduled, 1, 'cache-only composer reads must start the existing background refresh when cold')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.composerPoints({ chip: 'fixture', provider: 'xdpool-cn', model: 'fixture' }).total, 500)
  assert.equal(scheduled, 1, 'fresh credits must not start another probe')
})

test('PI composer retries unread credits quickly and slows down after a balance arrives', async () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer/composer.mjs'), 'utf8')
  const effect = renderer.match(/useEffect\(\(\) => \{\n    setData\(null\);[^]*?\}, \[chip\]\);/)[0]
  for (const [total, expected] of [[null, 5000], [500, 300000]]) {
    const waits = []
    const context = vm.createContext({
      chip: 'fixture', host: { dispatch: async () => ({ show: true, total, ours: true }) },
      setData() {}, setOpen() {}, setError() {}, setErrorFor() {},
      useEffect: run => { context.cleanup = run() }, Date,
      restartPollRef: { current: () => {} },
      REFRESH_INTERVAL_MS: 300000, WARMUP_INTERVAL_MS: 5000, WARMUP_WINDOW_MS: 120000,
      setTimeout: (_callback, ms) => { waits.push(ms); return 1 }, clearTimeout() {},
      setInterval: (_callback, ms) => { waits.push(ms); return 1 }, clearInterval() {},
    })
    vm.runInContext(effect, context)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(waits[0], expected)
    context.cleanup()
  }
})

test('PI account selection restarts credit polling after a successful preference save', async () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer/composer.mjs'), 'utf8')
  const prefer = renderer.slice(renderer.indexOf('method: "xd.composerPrefer"'))
  const body = prefer.match(/\}\)\.then\(\(next\) => \{([^]*?)\n          \}\)\.catch/)[1]
  let restarted = 0
  const context = vm.createContext({
    next: { saved: true, show: true, total: null }, chipRef: { current: 'fixture' }, requestedChip: 'fixture',
    account: { id: 'fixture' }, W: {}, setData() {}, setError() {}, setErrorFor() {}, setOpen() {},
    restartPollRef: { current: () => { restarted++ } },
  })
  await vm.runInContext('(async () => {' + body + '\n})()', context)
  assert.equal(restarted, 1, 'a preference save must not leave unread credits on the old five-minute timer')
})

/**
 * The selected row's fade is stated by the plugin, not inherited from the host.
 *
 * The two builds of this plugin run against hosts that disagree here: PI-Desktop
 * carries a global `button:disabled` rule that dims the row, DeepSeek Harness
 * has none outside its own update dialog. Relying on the host made the same row
 * look selected in one build and unmarked in the other, so the rule lives in the
 * popup's own stylesheet with the value PI-Desktop was already applying.
 */
test('PI composer states the selected row fade instead of inheriting one', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/composer.mjs'), 'utf8')
  assert.match(css, /\.xd-points-table \.xd-points-btn:disabled\{opacity:\.5\}/,
    'without this rule the selected row is undimmed wherever the host has no global rule')
})

/**
 * The dot beside a row carries one colour, written out rather than read from a
 * host token, so both builds of the panel paint the same green.
 */
test('PI composer paints the row marker in the shared colour', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/composer.mjs'), 'utf8')
  const rule = css.split('\n').find(line => line.startsWith('.xd-points-dot{'))
  assert.ok(rule, 'the row marker rule must exist')
  assert.match(rule, /background:#4f9f7c/, 'the marker is a fixed colour shared with the DeepSeek Harness build')
})
