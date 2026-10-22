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
    sourceStartFailures: new Map(), sourceKey: (s, r) => s + ':' + r,
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
    sourceStartFailures: new Map(), sourceKey: (s, r) => s + ':' + r,
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
    sourceStartFailures: new Map(), sourceKey: (s, r) => s + ':' + r,
    SOURCE_SPECS: { trae: { activeRegions: () => [] }, qoder: { activeRegions: () => [] } },
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

/**
 * A Trae or Qoder gateway that never bound is drift and a failed check, not health.
 *
 * The WorkBuddy half recorded its failed starts in `gatewayStartFailures` and the
 * Trae/Qoder half recorded nothing, so a start that lost the port race read as
 * "still warming": the saved roster was republished against a port nothing was
 * listening on, `addressDrift` walked the gateways that existed and found none to
 * complain about, the doctor pushed no finding at all and reported PASS, and the
 * panel showed the region with no endpoint line. Both READMEs promise the
 * opposite - "its model group is dropped, the connection check reports the
 * reason" - so this is the test that keeps the promise true.
 */
test('a Trae or Qoder gateway that could not start is drift, not health', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^function addressDrift\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(), gatewayStartFailures: new Map(), activeRegions: () => [], PROVIDER_ID_BY_REGION: {},
    TRAE_PROVIDER_ID_BY_REGION: { cn: 'xdpool-trae-cn' }, QODER_PROVIDER_ID_BY_REGION: {},
    activeTraeRegions: () => ['cn'], activeQoderRegions: () => [],
    sourceStartFailures: new Map(), sourceKey: (s, r) => s + ':' + r,
    SOURCE_SPECS: { trae: { activeRegions: () => ['cn'] }, qoder: { activeRegions: () => [] } },
    traeGateways: new Map(), qoderGateways: new Map(),
    declaredBaseUrl: () => undefined, hostDeclaredBaseUrl: () => undefined,
    // Publishing is what makes a failed start observable: with no row there is
    // nothing for the host to send requests to.
    declaredSourceBaseUrl: (region, idByRegion) => idByRegion[region] === undefined
      ? undefined
      : 'http://127.0.0.1:41851/v1',
    shimInfo: () => ({ running: false }),
  })
  vm.runInContext(fn + '\naddressDrift()', context)
  const drift = () => vm.runInContext('addressDrift()', context)

  assert.equal(drift(), false, 'nothing failed and nothing bound: there is no drift yet')
  context.sourceStartFailures = new Map([['trae:cn', 'listen EADDRINUSE']])
  assert.equal(drift(), true,
    'a Trae start that failed after its row was published is drift, not a roster in flight')

  // And the same region is not reported as warming, which is what would keep the
  // stale row published in the first place.
  const warmingFn = source.match(/^function warmingGatewayIds\(\) \{[^]*?^\}/m)[0]
  vm.runInContext(warmingFn + '\nwarmingGatewayIds()', context)
  assert.deepEqual([...vm.runInContext('warmingGatewayIds()', context)], [],
    'a region whose start failed must not be republished from its saved roster')
})

/**
 * The start that failed is the thing that records the failure.
 *
 * The other tests drive `sourceStartFailures` directly, so deleting the `set` in
 * the catch left every one of them green while the feature was dead again. This
 * drives the reconcile pass itself with a gateway that refuses to start.
 */
test('a Trae start that throws is recorded before the pass returns', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const fn = source.match(/^async function reconcileSourceGateways\(source\) \{[^]*?^\}/m)[0]
  const logged = []
  const context = vm.createContext({
    SOURCE_SPECS: { trae: { activeRegions: () => ['cn'], gateways: new Map() } },
    loadGeneration: 1,
    stillLoaded: () => true,
    sourceStartFailures: new Map(), sourceKey: (s, r) => s + ':' + r,
    serviceStopped: false,
    regionEnabled: () => true,
    createSourceRuntime: async () => { throw new Error('listen EADDRINUSE 127.0.0.1:41851') },
    safeMessage: (error) => String(error?.message ?? error),
    log: (level, message) => logged.push(message),
  })
  vm.runInContext(fn + '\nreconcileSourceGateways', context)
  await vm.runInContext("reconcileSourceGateways('trae')", context)

  const failures = vm.runInContext('sourceStartFailures', context)
  assert.equal(failures.get('trae:cn'), 'listen EADDRINUSE 127.0.0.1:41851',
    'the pass that caught the failure is the only place that knows it: without this entry ' +
    'the failed region reads as one still warming and keeps its stale provider row')
  assert.equal(logged.length, 1, 'and the log still says so')
  assert.equal(vm.runInContext('SOURCE_SPECS.trae.gateways.size', context), 0,
    'a failed start installs nothing')
})

/**
 * The doctor names a failed Trae or Qoder start instead of passing the session.
 *
 * The report is the only surface a user checks when a model group stops
 * answering, and it iterated the gateways that existed, so the one case that
 * matters - a gateway with nothing behind it - produced no finding and
 * `findings.every(f => f.ok)` came out true.
 */
test('the connection check names a Trae or Qoder start that failed', () => {  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const block = source.match(/for \(const \[source, gateways, idByRegion, nameByRegion, ports\] of \[[^]*?^  \}/m)
  assert.ok(block !== null, 'the Trae/Qoder finding loop must exist to be checked')
  const findings = []
  const context = vm.createContext({
    sourceStartFailures: new Map([['qoder:cn', 'listen EADDRINUSE']]),
    sourceKey: (s, r) => s + ':' + r,
    SOURCE_SPECS: { trae: { activeRegions: () => [] }, qoder: { activeRegions: () => ['cn'] } },
    traeGateways: new Map(),
    qoderGateways: new Map(),
    TRAE_PROVIDER_ID_BY_REGION: {}, TRAE_PROVIDER_NAME_BY_REGION: {},
    QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn' },
    QODER_PROVIDER_NAME_BY_REGION: { cn: 'WTQ Pool Qoder (CN)' },
    TRAE_PORTS: {}, QODER_PORTS: { cn: 42871 },
    push: (label, ok, detail) => findings.push({ label, ok, detail }),
    declaredSourceBaseUrl: () => undefined,
    samePublishedAddress: () => true,
  })
  vm.runInContext(block[0], context)

  const endpoint = findings.find((finding) => finding.label === 'WTQ Pool Qoder (CN): endpoint')
  assert.ok(endpoint !== undefined, 'a gateway that never bound must produce a finding')
  assert.equal(endpoint.ok, false, 'and it must read as a failure, not as health')
  assert.match(endpoint.detail, /EADDRINUSE/, 'carrying the reason the start gave')
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
    pool: { acquire: async () => ({ label: 'fixture', credential: {} }) }, catalog: { visible: () => [] },
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

/**
 * The delete button shares the remove button's box.
 *
 * Both sit in one flex line at the right end of an account row. The delete
 * button inherited the default `button` padding while the remove button carried
 * the row's smaller one, so it stood taller and its top edge sat above the
 * control it belongs beside.
 */
test('the account row ships one box for the remove and delete buttons', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/panel.css'), 'utf8')
  const shared = css.match(/\.acct-remove,\s*\n\.acct-delete \{([^}]*)\}/)
  assert.ok(shared, 'the two buttons must be sized by one rule, not by the default button padding')
  assert.match(shared[1], /padding:\s*4px 10px/, 'and that rule must set the row padding both of them share')
  assert.match(shared[1], /font-size:\s*12\.5px/, 'with the row font size, so their heights match')
})
