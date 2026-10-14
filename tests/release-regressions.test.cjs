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
  })
  vm.runInContext(fn + '\nsyncDeclaration()', context)
  assert.deepEqual(Array.from(writes[0], row => row.id), ['xdpool-cn', 'xdpool-qoder-cn'])
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
      chip: 'fixture', host: { dispatch: async () => ({ show: true, total }) },
      setData() {}, setOpen() {}, setError() {}, setErrorFor() {},
      useEffect: run => { context.cleanup = run() }, Date,
      restartPollRef: { current: () => {} },
      REFRESH_INTERVAL_MS: 300000, WARMUP_INTERVAL_MS: 5000, WARMUP_WINDOW_MS: 60000,
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
