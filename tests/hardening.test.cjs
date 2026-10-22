/**
 * The pool surviving its own refresh, its sealed sign-ins and its cooldown
 * bookkeeping, and the vendor gateways rotating past a sign-in instead of
 * answering the client with its refusal.
 *
 * Every case is stated as the observable the user sees: the token the upstream
 * is actually sent, the account the panel still lists, the status the client is
 * answered with, and the file the next restart reads. Nothing here reaches the
 * network or a real install - the upstream is an injected `fetchImpl` or a file
 * in a temp directory, and the one module swapped is the seam into the installed
 * desktop app.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')

const root = path.resolve(__dirname, '..')

/** The pool the two source gateways share, wired to readers that answer for an empty settings document. */
function sourcePoolFor(cooldown) {
  return require('../lib/source-pool').createSourcePool({
    cooldownMs: () => cooldown,
    preferredSourceAccount: () => '',
    sourceDistribution: () => 'priority',
    sourceRegionKey: (source, region) => `${source}:${region}`,
  })
}

/** A temp directory under the scratch root the suite is allowed to use. */
function scratch(prefix) {
  return fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), prefix))
}

/**
 * Lift named top-level functions out of the bundled entry.
 *
 * `main.js` runs these as top-level functions of the plugin process, so the
 * case drives the real code rather than a copy of it: a bound the entry never
 * wires up, or a guard whose `return` was dropped, then fails where a source
 * match would still pass.
 *
 * The brace walk skips string literals, template substitutions and line
 * comments, so a function that mentions a brace in prose is not cut short.
 */
function entryFunctions(names, source) {
  const parts = []
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the entry`)
    // `indexOf` finds the `function` keyword, which drops an `async ` modifier
    // in front of it: the lifted text would then hold an `await` outside any
    // async function and fail to parse.
    const modifier = source.slice(Math.max(0, from - 6), from) === 'async ' ? 'async ' : ''
    let depth = 0
    let quote = ''
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      const character = source[index]
      if (quote !== '') {
        if (character === '\\') index += 1
        else if (character === quote) quote = ''
        continue
      }
      if (character === "'" || character === '"' || character === '`') { quote = character; continue }
      if (character === '/' && source[index + 1] === '/') {
        while (index < source.length && source[index] !== '\n') index += 1
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(modifier + source.slice(from, index + 1))
  }
  return parts.join('\n')
}

/** One declaration line out of the entry, asserted present exactly once. */
function entryDeclaration(pattern, source) {
  const found = source.match(pattern)
  assert.notEqual(found, null, `${pattern} must exist in the entry`)
  return found[0]
}

/** An auth directory holding one sign-in for `uin`, with a dead access token. */
function writeSignIn(auth, uin, accessToken, expiresAt) {
  fs.mkdirSync(auth, { recursive: true })
  fs.writeFileSync(path.join(auth, `${uin}.info`), JSON.stringify({
    auth: { accessToken, refreshToken: `refresh-${uin}`, expiresAt, domain: 'codebuddy.cn' },
    account: { uin, nickname: uin },
  }))
}

/**
 * A refreshed token is not swapped back for the stale one the file still holds.
 *
 * The desktop app keeps the file it wrote, so the next scan re-reads a snapshot
 * of the token the refresh just replaced. Nothing on disk says which of the two
 * is newer, so without the issue-time stamp the scan fell through to the expiry
 * tiebreaker and handed back the revoked token - which the on-disk expiry, being
 * further out, always won. Every request then rode the dead token until it was
 * refreshed again, once per turn.
 */
test('a refreshed token is not swapped back for the stale one on disk', async () => {
  const temporary = scratch('xdpool-refresh-test-')
  const auth = path.join(temporary, 'auth')
  // An expiry that outlives the refreshed one: that is the tiebreaker the scan
  // used to lose, and the only thing that makes the stamp observable.
  writeSignIn(auth, 'refresh-user', 'revoked', Date.now() + 10 * 86400000)
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({
    authDirs: [auth],
    client: { refreshToken: async () => ({ accessToken: 'refreshed', expiresInSec: 3600 }) },
  })
  try {
    const [account] = await pool.scan()
    assert.equal(await pool.refreshAccount(account.id), true, 'the refresh must really have replaced the token')
    assert.equal(account.credential.accessToken, 'refreshed')
    assert.equal((await pool.scan())[0].credential.accessToken, 'refreshed',
      'the next scan must keep the refreshed token, not re-read the file it replaced')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * A sign-in this build cannot open yet is kept, not dropped.
 *
 * WorkBuddy 5.6+ seals `accessToken` at rest and the key lives in the installed
 * app, so a machine where that app has not been started reads the file as
 * unopenable. Reading that as "no credential" emptied the pool: the account
 * disappeared from the panel and the gateway answered 503 for a sign-in that was
 * working a moment ago.
 */
test('a sealed sign-in keeps its account until the at-rest key is available', async () => {
  const accountsPath = require.resolve('../lib/accounts')
  const atRestPath = require.resolve('../lib/at-rest')
  const realAtRest = require(atRestPath)
  const realAtRestEntry = require.cache[atRestPath]
  const realAccountsEntry = require.cache[accountsPath]
  // The opener is the one seam into the installed app. Swapping the module is
  // what makes "no at-rest key available" a fixture instead of a property of
  // whatever machine happens to run this check.
  const stub = new Module(atRestPath, null)
  stub.filename = atRestPath
  stub.loaded = true
  stub.exports = { ...require(atRestPath), encryptedFieldOpener: async () => undefined }
  require.cache[atRestPath] = stub
  delete require.cache[accountsPath]
  const { WorkBuddyAccountPool } = require(accountsPath)
  const temporary = scratch('xdpool-sealed-test-')
  const auth = path.join(temporary, 'auth')
  const file = path.join(auth, 'sealed-user.info')
  try {
    writeSignIn(auth, 'sealed-user', 'live', Date.now() + 3600000)
    const pool = new WorkBuddyAccountPool({ authDirs: [auth] })
    assert.equal((await pool.scan()).length, 1, 'the plain sign-in must be listed first')

    // The desktop app rewrites the same file with the fields sealed: same
    // account, same directory, nothing a reader without the key can open.
    fs.writeFileSync(file, JSON.stringify({
      auth: {
        accessToken: { $wbEncrypted: 1, envelope: Buffer.from('{"keyId":"0123456789abcdef","suite":1}').toString('base64') },
        refreshToken: 'refresh-sealed-user', expiresAt: Date.now() + 3600000,
      },
      account: { uin: 'sealed-user', nickname: 'sealed-user' },
    }))
    const kept = await pool.scan()
    assert.equal(kept.length, 1, 'a sign-in this build cannot open must not empty the pool')
    assert.equal(kept[0].credential.accessToken, 'live', 'the incumbent credential must survive the sealed rewrite')
  } finally {
    require.cache[atRestPath] = realAtRestEntry
    if (realAccountsEntry === undefined) delete require.cache[accountsPath]
    else require.cache[accountsPath] = realAccountsEntry
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * Two sign-ins with no identity stay two accounts.
 *
 * The pool hashes a credential into its account id, and a sign-in the desktop
 * app wrote with no uin, uid or nickname fell back to one shared constant: the
 * second such sign-in hashed to the same id and was silently dropped, so a
 * machine with two of them served from one and never noticed the other.
 */
test('two identity-less sign-ins from different files are two accounts', () => {
  const { workbuddyAccountId } = require('../lib/accounts')
  const first = workbuddyAccountId({ sourcePath: '/fixture/auth/first.info' })
  const second = workbuddyAccountId({ sourcePath: '/fixture/auth/second.info' })
  assert.match(first, /^[0-9a-f]{16}$/, 'the id is a hash, so the path itself never reaches the panel')
  assert.notEqual(first, second, 'two files with no identity must not collapse into one pool entry')
  assert.equal(workbuddyAccountId({ sourcePath: '/fixture/auth/first.info' }), first,
    'the id must be stable, or a rescan would read as a new account')
  // Identity still wins over the path: one account signed in twice is one
  // account, whichever file it was read from.
  assert.equal(
    workbuddyAccountId({ uin: '90000000001', sourcePath: '/fixture/auth/a.info' }),
    workbuddyAccountId({ uin: '90000000001', sourcePath: '/fixture/auth/b.info' }),
    'the same account in two files must still be one account',
  )
})

/**
 * A configured cooldown longer than the cap is honoured; a raw reset is not.
 *
 * The cap exists so one mis-parsed timestamp cannot sleep an account all day.
 * Applied to the configured window as well, it overrode the user's own setting:
 * a six-hour cooldown came back as two hours and the account was retried while
 * it was still limited.
 */
test('a configured cooldown past the cap is honoured and a raw reset is clamped', async () => {
  const temporary = scratch('xdpool-cooldown-test-')
  const auth = path.join(temporary, 'auth')
  const future = Date.now() + 3600000
  writeSignIn(auth, 'cool-user-a', 'token-a', future)
  writeSignIn(auth, 'cool-user-b', 'token-b', future)
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({ authDirs: [auth], cooldownMs: 6 * 60 * 60 * 1000 })
  try {
    const [first, second] = await pool.scan()
    const now = Date.now()
    pool.penalize(first.id)
    assert.ok(Math.abs(first.cooldownUntilMs - (now + 6 * 60 * 60 * 1000)) < 5000,
      'the configured window is the user\'s own choice and must not be capped')
    pool.penalize(second.id, now + 24 * 60 * 60 * 1000)
    assert.ok(second.cooldownUntilMs > now, 'a raw reset must still cool the account')
    assert.ok(second.cooldownUntilMs <= now + 2 * 60 * 60 * 1000 + 5000,
      'a caller-supplied reset past the cap must be clamped to the cap')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * Per-model cooldowns are pruned when they lapse, and capped in count.
 *
 * The key is whatever model string the request carried, so a client that sprays
 * distinct ids grew one map per account forever. A cooldown that has already
 * lapsed is dropped rather than kept as a dead entry the pool would consult on
 * every pick.
 */
test('per-model cooldowns lapse out and are capped in count', async () => {
  const temporary = scratch('xdpool-modelcool-test-')
  const auth = path.join(temporary, 'auth')
  writeSignIn(auth, 'model-cool-user', 'token', Date.now() + 3600000)
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({ authDirs: [auth] })
  try {
    const [account] = await pool.scan()
    account.modelCooldowns['lapsed-model'] = Date.now() - 5000
    pool.penalize(account.id, undefined, 'live-model')
    assert.equal('lapsed-model' in account.modelCooldowns, false,
      'a cooldown that has already lapsed must be dropped by the next penalize')
    assert.ok(account.modelCooldowns['live-model'] > Date.now(), 'the live cooldown must be recorded')

    for (let index = 0; index < 200; index += 1) pool.penalize(account.id, undefined, `sprayed-${index}`)
    // The prune runs before the insert, so the map holds the cap plus the key
    // the last call just added; what the case pins is that the spray cannot
    // grow it without bound.
    assert.ok(Object.keys(account.modelCooldowns).length <= 129,
      '200 distinct model ids must not grow the cooldown map without bound')
    await pool.scan()
    assert.equal(Object.keys(account.modelCooldowns).length, 128, 'the live key count is capped')
    assert.equal('sprayed-0' in account.modelCooldowns, false, 'the soonest cooldowns are the ones dropped')
    assert.equal('sprayed-199' in account.modelCooldowns, true, 'the newest cooldowns are the ones kept')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * The status the upstream chose is not reclassified by the body it quotes.
 *
 * A 429 routinely quotes quota text, and reading that as billing exhaustion
 * answered 402 for a limit that clears on its own - the client stopped instead
 * of waiting. A session marker on any other status is the mirror image: a rate
 * limit whose text happens to carry the code rotated the account without ever
 * cooling it, so the same limited account was hit on every attempt.
 */
test('a status the upstream chose is not reclassified by the body it quotes', () => {
  const { classifyUpstreamError } = require('../lib/upstream')
  assert.equal(classifyUpstreamError(429, '{"msg":"insufficient credit; quota exceeded"}'), 'soft_rate',
    'a 429 that quotes quota text is still a rate limit that clears on its own')
  assert.notEqual(classifyUpstreamError(500, 'Offline user session not found'), 'session_dead',
    'a session marker on a 500 is an upstream outage, not a dead sign-in')
  assert.equal(classifyUpstreamError(401, '{"code":12153}'), 'session_dead',
    'a 401 carrying the session marker is the one place it may fire')
})

/**
 * An oversized body is refused without cutting the socket that carries the 413.
 *
 * The refusal used to destroy the request as soon as the limit passed, and with
 * a large upload mid-stream the OS answers a destroy with RST: the client saw a
 * reset and no reason for it. The body is drained instead, and the listeners
 * that watch for the end are attached once rather than once per chunk - a fresh
 * pair per chunk walked straight into Node's own listener ceiling.
 */
test('an oversized request body is refused without destroying the socket', async () => {
  const { EventEmitter } = require('node:events')
  const { readRequestBody } = require('../lib/loopback')
  const request = new EventEmitter()
  request.destroyed = false
  request.destroy = () => { request.destroyed = true }
  const reading = readRequestBody(request)
  request.emit('data', Buffer.alloc(64 * 1024 * 1024 + 1))
  await assert.rejects(reading, /request body too large/, 'a body past the limit must be refused')
  assert.equal(request.destroyed, false,
    'the 413 is written after the refusal, so the socket must still be alive to carry it')
  // And it stays alive: with a large upload mid-stream the OS answers a destroy
  // with RST, and the 413 the caller is about to write is discarded with the
  // socket. The body is drained instead, so the socket closes only once the
  // upload has finished.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(request.destroyed, false, 'an oversized upload must be drained, not destroyed')
  for (let chunk = 0; chunk < 4; chunk += 1) request.emit('data', Buffer.alloc(1024))
  assert.ok(request.listenerCount('end') <= 2, 'the drain listeners must not accumulate per chunk')
  assert.ok(request.listenerCount('error') <= 2, 'the drain listeners must not accumulate per chunk')
  request.emit('end')
  assert.equal(request.destroyed, true, 'the drained socket must still be closed once the body ends')

  // The control: a body inside the limit still resolves, or the refusal above
  // could be passing for a reader that refuses everything.
  const small = new EventEmitter()
  small.destroyed = false
  const read = readRequestBody(small)
  small.emit('data', Buffer.from('{"model":"fixture"}'))
  small.emit('end')
  assert.deepEqual(await read, Buffer.from('{"model":"fixture"}'), 'a body inside the limit must still be read')

  // And the declared size is refused before a byte arrives: waiting for the
  // bytes held the request for as long as the client chose to send them, so a
  // declared 100 MiB with nothing behind it hung until Node's own timeout.
  const declaredOver = new EventEmitter()
  declaredOver.destroyed = false
  // The grace timer the refusal arms calls this once it expires, so the fixture
  // has to answer it rather than throw after the test has ended.
  declaredOver.destroy = () => { declaredOver.destroyed = true }
  declaredOver.headers = { 'content-length': String(100 * 1024 * 1024) }
  await assert.rejects(readRequestBody(declaredOver), /request body too large/,
    'a declared body past the limit must be refused before any byte is read')
  const declaredUnder = new EventEmitter()
  declaredUnder.headers = { 'content-length': String(1024) }
  const insideLimit = readRequestBody(declaredUnder)
  declaredUnder.emit('data', Buffer.from('{}'))
  declaredUnder.emit('end')
  assert.deepEqual(await insideLimit, Buffer.from('{}'), 'a declared body inside the limit must still be read')
})

/**
 * A Trae refusal is read from its shape, not from its event name.
 *
 * Trae sends the subscription gate (code 1005) on `event: message`, nested under
 * `error`, and as a JSON document inside `message`. Keying on the name alone let
 * all of those through as content, so the client was answered with an empty 200
 * turn and no error at all - for an account whose subscription had run out.
 */
test('a Trae refusal is recognised wherever the frame chose to put it', () => {
  const { traeFailureOf } = require('../lib/trae-shim')
  for (const frame of [
    { type: 'unknown', event: 'message', data: { code: 1005, message: 'subscription required' } },
    { type: 'unknown', event: 'x', data: { error: { code: 1005 } } },
    { type: 'unknown', event: 'x', data: { message: '{"code":1005,"message":"nested"}' } },
  ]) {
    assert.equal(traeFailureOf(frame)?.code, 1005, 'a refusal must be recognised in: ' + JSON.stringify(frame))
  }
  // The controls: a keepalive that happens to carry a zero code is not a
  // refusal, and neither is a content frame - a rule that flagged either would
  // end every healthy turn in an error.
  assert.equal(traeFailureOf({ type: 'unknown', event: 'x', data: { code: 0 } }), undefined,
    'a keepalive carrying a zero code is not a refusal')
  assert.equal(traeFailureOf({ type: 'delta', text: 'hello' }), undefined, 'a content frame is not a refusal')
})

/**
 * An empty `choices` with no usage is a refusal, not a chunk.
 *
 * Qoder reports refusals in the chunk's own shape, and forwarding them as chunks
 * answered the client with an empty turn - a 200 with no content and no error.
 * The token-accounting frame also carries `choices: []` and has to stay a chunk,
 * or every turn would end in a failure.
 */
test('a Qoder refusal wearing a chunk shape is read as a failure', () => {
  const { decodeQoderFrame } = require('../lib/qoder-sse')
  const refused = decodeQoderFrame('{"choices":[],"errorCode":"10605"}')
  assert.equal(refused.type, 'failure', 'an empty choices list carrying a code is a refusal')
  assert.equal(refused.code, '10605')
  const accounting = decodeQoderFrame('{"choices":[],"usage":{"total_tokens":42}}')
  assert.equal(accounting.type, 'chunk', 'the token-accounting frame is still a chunk')
})

/**
 * A Qoder sign-in that is dead does not take the turn down with it.
 *
 * The gateway used the first sign-in it was handed, so an expired login answered
 * 401 to the client no matter how many healthy sign-ins sat behind it in the
 * ordered list. A refusal is usually a property of the sign-in - which is what
 * the next one in the list is for.
 */
test('a Qoder chat rotates past a sign-in that answers 401', async () => {
  const { createQoderGateway } = require('../lib/qoder-gateway')
  const dead = { userID: 'dead-user', token: 'dead-token', name: '', email: '' }
  const live = { userID: 'live-user', token: 'live-token', name: '', email: '' }
  const served = []
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init?.headers)
    if (String(url).includes('/model/list')) {
      return new Response(JSON.stringify({ chat: [{ key: 'qoder-model', display_name: 'Qoder', enable: true }] }))
    }
    // The token rides inside the signed COSY envelope, so the user id the
    // request was signed for is the part of the credential a fixture can see.
    const user = headers.get('cosy-user') ?? ''
    served.push(user)
    if (user === dead.userID) {
      return new Response(JSON.stringify({ code: 105, message: 'Login expired' }), { status: 401 })
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"served by the second sign-in"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const gateway = createQoderGateway({ region: 'cn', port: 0, credentials: async () => [dead, live], fetchImpl })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'qoder-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.equal(answer.status, 200, 'the healthy sign-in behind the dead one must serve the turn')
    assert.ok(body.includes('served by the second sign-in'), 'the reply must come from the second sign-in')
    assert.deepEqual(served, ['dead-user', 'live-user'],
      'the dead sign-in must be tried first and then rotated past, in order')
  } finally { await gateway.close() }
})

/**
 * A Trae sign-in that is dead does not take the turn down with it either.
 *
 * Same shape, same reason: the ordered credential list is the failover, and the
 * upstream sees the token of whichever sign-in actually served.
 */
test('a Trae chat rotates past a sign-in that answers 401', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  const dead = { accessToken: 'dead-token', userId: 'dead-user', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  const live = { accessToken: 'live-token', userId: 'live-user', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  const served = []
  const fetchImpl = async (url, init) => {
    const token = new Headers(init?.headers).get('x-ide-token') ?? ''
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    // The reasoning table lives on the remote directory; an empty one leaves the
    // roster callable, which is all this case needs from it.
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    served.push(token)
    if (token === dead.accessToken) {
      return new Response(JSON.stringify({ code: 4001, message: 'Login expired' }), { status: 401 })
    }
    return new Response(
      'event: output\ndata: {"response":"served by the second sign-in"}\n\nevent: done\ndata: {}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [dead, live], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.equal(answer.status, 200, 'the healthy sign-in behind the dead one must serve the turn')
    assert.ok(body.includes('served by the second sign-in'), 'the reply must come from the second sign-in')
    assert.deepEqual(served, ['dead-token', 'live-token'],
      'the dead sign-in must be tried first and then rotated past, in order')
  } finally { await gateway.close() }
})

/**
 * A discovery answer is reused inside its TTL, and a rescan sees the disk again.
 *
 * The gateways read credentials per request so a desktop re-login is picked up
 * without a rescan, and the read itself walks and decrypts every candidate file:
 * on the chat path that was a directory walk per turn. A caller that names its
 * own files is asking about those files, so only the machine-wide walk is cached
 * - and `reset*CredentialCache` is what a rescan uses to see a change at once.
 */
test('a credential discovery answer is cached inside its TTL and reset on demand', async () => {
  const trae = require('../lib/trae-discovery')
  const qoder = require('../lib/qoder-credentials')
  const { qoderStorageCandidates } = require('../lib/qoder-discovery')
  const temporary = scratch('xdpool-discovery-test-')
  const home = path.join(temporary, 'home')
  const roaming = path.join(temporary, 'appdata')
  const namedHome = path.join(temporary, 'named-home')
  const signIn = { token: 'trae-token', userId: 'trae-user', host: '', expiredAt: Date.now() + 3600000 }
  const writeTrae = (target) => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(signIn) }))
  }
  // The explicit-candidate file: a root of its own that the case names itself.
  const named = trae.traeStorageCandidates('linux', namedHome, {}).find((candidate) => candidate.source === 'desktop').path
  writeTrae(named)
  // The default candidate set is derived from the environment, so the fixture
  // has to be the machine for the duration of the cached half.
  const previous = { APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.APPDATA = roaming
  process.env.USERPROFILE = home
  process.env.HOME = home
  try {
    const machineWide = trae.traeStorageCandidates().find((candidate) => candidate.source === 'desktop').path
    writeTrae(machineWide)
    const qoderBlob = qoderStorageCandidates().find((candidate) => candidate.kind === 'auth-v1').path
    fs.mkdirSync(path.dirname(qoderBlob), { recursive: true })
    fs.writeFileSync(qoderBlob, Buffer.concat([Buffer.from('v10'), Buffer.alloc(64)]))

    // Explicit candidates are answered from those files, every time: the caller
    // named them, so a cache would answer about files it was not asked about.
    const candidates = trae.traeStorageCandidates('linux', namedHome, {})
    assert.equal((await trae.discoverTraeCredentials(candidates)).credentials.length, 1)
    fs.rmSync(named)
    assert.equal((await trae.discoverTraeCredentials(candidates)).credentials.length, 0,
      'a caller that names its own files must not be answered from a cache')

    // The machine-wide walk is cached: a sign-in deleted inside the TTL is still
    // reported, and only a reset makes the deletion visible.
    assert.equal((await trae.discoverTraeCredentials()).credentials.length, 1)
    fs.rmSync(machineWide)
    assert.equal((await trae.discoverTraeCredentials()).credentials.length, 1,
      'a file deleted inside the TTL must not be re-read on every call')
    trae.resetTraeCredentialCache()
    assert.equal((await trae.discoverTraeCredentials()).credentials.length, 0,
      'a rescan must see the deletion the cached answer still hides')

    // Qoder caches its failures the same way, with one boundary: an answer
    // that found nothing is re-read rather than cached, so a read that came
    // back empty under load cannot answer a chat with "no sign-in" for the
    // whole TTL. An answer that found something is cached like Trae's.
    const before = await qoder.discoverQoderCredentials()
    assert.deepEqual(before.failures.map((failure) => failure.reason), ['no-key'],
      'the unopenable slot must report why it is unopenable')
    fs.rmSync(qoderBlob)
    assert.deepEqual((await qoder.discoverQoderCredentials()).failures, [],
      'an empty answer is re-read, not cached')
    qoder.resetQoderCredentialCache()
    assert.deepEqual((await qoder.discoverQoderCredentials()).failures, [],
      'a rescan reads the slot as absent once its blob is gone')
  } finally {
    if (previous.APPDATA === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous.APPDATA
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous.USERPROFILE
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The collected check-in slots outlive the process, and only for as long as they
 * matter.
 *
 * The set was memory only, so a restart after 09:00 read as a fresh day: the
 * earliest hour was unconsumed and the whole pass ran again, claiming twice for
 * one day. The file keeps the recent days only, or it would grow forever and a
 * day long past would still read as spent.
 */
test('the collected check-in slots persist and are pruned to the retention window', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  // The zone and the slot id live in the shared module now, so they are required
  // rather than lifted out of the entry text.
  const checkinTime = require('../lib/checkin-time')
  const dataPath = scratch('xdpool-slots-test-')
  const context = vm.createContext({
    fs, path, Date, Intl, JSON, Set, Object, Array, console: { log() {}, warn() {} },
    log: () => {}, safeMessage: (error) => String(error?.message ?? error),
    zonedDayHour: checkinTime.zonedDayHour,
    checkinSlotId: checkinTime.checkinSlotId,
  })
  vm.runInContext([
    entryDeclaration(/^const CHECKIN_SLOTS_FILE = "[^"]+";$/m, source),
    entryDeclaration(/^const CHECKIN_SLOTS_KEEP_DAYS = \d+;$/m, source),
    entryDeclaration(/^const autoCheckinSlots = new Set\(\);$/m, source),
    entryDeclaration(/^let dataPath = "";$/m, source),
    entryFunctions(['recentCheckinDays', 'loadCheckinSlots', 'saveCheckinSlots'], source),
  ].join('\n'), context)
  const read = (expression) => vm.runInContext(expression, context)
  const slotsFile = read('CHECKIN_SLOTS_FILE')
  try {
    read(`dataPath = ${JSON.stringify(dataPath)}`)
    const today = read('zonedDayHour(new Date())')
    const todaySlot = read(`checkinSlotId(${JSON.stringify(today.day)}, ${today.hour})`)
    const staleDay = read(`zonedDayHour(new Date(Date.now() - 5 * 86400000))`).day
    read(`autoCheckinSlots.add(${JSON.stringify(todaySlot)})`)
    read(`autoCheckinSlots.add(${JSON.stringify(staleDay + 'T09')})`)
    read('saveCheckinSlots()')

    const stored = JSON.parse(fs.readFileSync(path.join(dataPath, slotsFile), 'utf8'))
    assert.deepEqual(Object.keys(stored), [today.day],
      'only the days inside the retention window may be written')
    assert.deepEqual(stored[today.day], [todaySlot], 'the slot the pass recorded must be the one stored')

    // The read side takes the same view: a day outside the window on disk is not
    // read back as a day already spent, or a restart would skip today's pass.
    fs.writeFileSync(path.join(dataPath, slotsFile), JSON.stringify({
      [today.day]: [todaySlot], '2001-01-01': ['2001-01-01T09'],
    }, null, 2))
    read('autoCheckinSlots.clear()')
    read('loadCheckinSlots()')
    assert.deepEqual([...read('autoCheckinSlots')], [todaySlot],
      'a day outside the retention window must not be read back as already collected')
  } finally { fs.rmSync(dataPath, { recursive: true, force: true }) }
})

/**
 * A catalog figure the host will not store is clamped before it is published,
 * and the panel's arrays are capped where they are written to settings.
 *
 * `positiveInteger` rounds whatever the catalog says and the manifest is written
 * verbatim, so a figure of 1e20 was published as-is and the host's own validator
 * refused the whole declaration with it. The selection list is untrusted input
 * stored in the same document, so it is capped to what a gateway can publish.
 */
test('a token budget past the host ceiling is clamped and panel arrays are capped', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const ceiling = /const MAX_TOKEN_BUDGET = (0x[0-9a-f]+);/.exec(source)
  assert.ok(ceiling, 'the host must declare the ceiling it stores against')
  const numbers = vm.createContext({ MAX_TOKEN_BUDGET: Number(ceiling[1]) })
  vm.runInContext(entryFunctions(['positiveInteger'], source), numbers)
  assert.equal(numbers.positiveInteger(1e20, 4096), 0xffffffff,
    'a catalog figure past the ceiling must be clamped, not published verbatim')
  assert.equal(numbers.positiveInteger(2000, 4096), 2000, 'a figure inside the ceiling still publishes')
  assert.equal(numbers.positiveInteger('nonsense', 4096), 4096, 'an unreadable figure still falls back')

  // The hours rule lives in the shared module now. Its cap is defensive only -
  // the 0-23 filter already leaves at most one entry per hour of the day - so
  // what is observable is the filter, the sort, the dedupe and the fallback.
  const checkinTime = require('../lib/checkin-time')
  assert.deepEqual([...checkinTime.normaliseCheckinHours([5, 1, 3, 23, 1])], [1, 3, 5, 23],
    'the hours list is sorted, deduplicated and kept inside 0-23')
  assert.deepEqual([...checkinTime.normaliseCheckinHours([])], [9], 'an empty list falls back to the default hour')
  assert.deepEqual([...checkinTime.normaliseCheckinHours([25, -1, 'nonsense', 9.7])], [9],
    'an out-of-range or unreadable hour is dropped rather than guessed at')

  const stored = /const MAX_STORED_MODEL_IDS = (\d+);/.exec(source)
  assert.ok(stored, 'the entry must declare how many stored ids it keeps')
  const idCap = /const MAX_MODEL_ID_LENGTH = (\d+);/.exec(source)
  assert.ok(idCap, 'the entry must declare the longest model id it stores')
  const selection = vm.createContext({
    MAX_STORED_MODEL_IDS: Number(stored[1]),
    MAX_MODEL_ID_LENGTH: Number(idCap[1]),
  })
  vm.runInContext(entryFunctions(['parseSelection'], source), selection)
  const ids = Array.from({ length: 600 }, (_, index) => `model-${index}`)
  assert.equal(selection.parseSelection({ enabledModelIds: ids }).enabledModelIds.length, 512,
    'an untrusted selection list is capped to what a gateway can publish')
  assert.equal(selection.parseSelection({ enabledModelIds: ['x'.repeat(300)] }), undefined,
    'an id longer than the declaration can publish is refused rather than stored')
})

/**
 * A stored model override past the gateway's own figure is clamped before it is
 * published.
 *
 * The panel's own save path bounds these figures, but the read path folds a
 * settings document in verbatim, so a hand-edited or legacy file can carry a
 * figure the host's manifest validator rejects - and a rejected declaration
 * takes every provider this plugin publishes down with it. A figure that is
 * merely larger than the model accepts is just as wrong: the host sizes its
 * context budget and compaction threshold from the declared number, so it waited
 * for room the gateway never had and the reply was cut short.
 */
test('a stored model override past what the model accepts is clamped, not published verbatim', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const constant = (name) => Number(new RegExp(`const ${name} = (0x[0-9a-f]+|\\d+);`).exec(source)[1])
  const context = vm.createContext({
    MAX_TOKEN_BUDGET: constant('MAX_TOKEN_BUDGET'),
    CONSERVATIVE_CONTEXT_WINDOW: constant('CONSERVATIVE_CONTEXT_WINDOW'),
    DEFAULT_MAX_TOKENS: constant('DEFAULT_MAX_TOKENS'),
    // The one collaborator `sourceModelView` reads outside its arguments.
    gatewayOverrides: () => ({ 'm-1': { contextWindow: 1e20, maxOutputTokens: 1e20 } }),
  })
  vm.runInContext(entryFunctions(['positiveInteger', 'sourceModelView'], source), context)
  const view = vm.runInContext(
    "sourceModelView('trae:cn', { id: 'm-1' }, { contextWindow: 128000, maxTokens: 32000, supportsImages: false })",
    context,
  )
  assert.equal(view.contextWindow, 128000, 'the stored context window is clamped to what the model accepts')
  assert.equal(view.maxOutputTokens, 32000, 'the stored output limit is clamped to what the model accepts')
  // A figure the model can take still passes through untouched, so the clamp is
  // not a silent downgrade of every edited model.
  context.gatewayOverrides = () => ({ 'm-1': { contextWindow: 200000, maxOutputTokens: 64000 } })
  const smaller = vm.runInContext(
    "sourceModelView('trae:cn', { id: 'm-1' }, { contextWindow: 1000000, maxTokens: 128000 })",
    context,
  )
  assert.equal(smaller.contextWindow, 200000, 'a window the model can take is published as stored')
  assert.equal(smaller.maxOutputTokens, 64000, 'an output limit the model can take is published as stored')
})

/**
 * The editor's "default tier" output ceiling does not follow the declared window.
 *
 * `nativeMaxOutputTokens` is the budget of the model's DEFAULT window, because that
 * is what the editor compares a draft window against. Filling it with the figure
 * for the window in force meant that a user who raised the window to the Max tier
 * and then went back to the default one was told the ceiling was the Max tier's
 * smaller budget, and the field refused an output the gateway accepts.
 */
test('the default-tier output ceiling stays put after the window is raised', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const constant = (name) => Number(new RegExp(`const ${name} = (0x[0-9a-f]+|\\d+);`).exec(source)[1])
  const context = vm.createContext({
    MAX_TOKEN_BUDGET: constant('MAX_TOKEN_BUDGET'),
    CONSERVATIVE_CONTEXT_WINDOW: constant('CONSERVATIVE_CONTEXT_WINDOW'),
    DEFAULT_MAX_TOKENS: constant('DEFAULT_MAX_TOKENS'),
    // The live row measured on the AI region: 200000 with 32000 output, and a 1M
    // Max tier whose function grants only 16000.
    gatewayOverrides: () => ({ 'm-1': { contextWindow: 1000000 } }),
  })
  vm.runInContext(entryFunctions(['positiveInteger', 'sourceModelView'], source), context)
  const view = vm.runInContext(
    "sourceModelView('trae:ai', { id: 'm-1' },"
      + " { contextWindow: 200000, maxTokens: 32000, maxTokensAtCeiling: 16000, maxContextWindow: 1000000, supportsImages: false })",
    context,
  )
  assert.equal(view.contextWindow, 1000000, 'the declared window is the one stored')
  assert.equal(view.maxOutputTokens, 16000,
    'and the declaration states the Max-serving budget, which is what that window gets')
  assert.equal(view.nativeMaxOutputTokens, 32000,
    'the editor\'s default-tier ceiling stays at the default tier\'s budget')
  assert.equal(view.maxOutputAtCeiling, 16000, 'while the raised tier states its own')
})

/**
 * An upstream refusal reaches the client as the sentence the upstream wrote.
 *
 * Both vendor gateways hand the upstream's own JSON error document straight to
 * `writeOpenAIError`, which double-wraps it: the client then reads a serialized
 * document where a sentence should be. Lifting one layer off is what turns that
 * back into something a user can act on, and the redaction runs on the way out
 * because that document is exactly where an echoed credential rides - Trae's 401
 * quotes the `Cloud-IDE-JWT` header it was sent.
 */
/**
 * The vendor's channel check is answered as a cause, not as a wall of tips.
 *
 * WorkBuddy's domestic host refuses any request whose prompt names DeepSeek
 * Harness as the client (code 11128), on every account of that region. Rotation
 * cannot clear it, so the pool must not spend four upstream calls pretending to
 * try; and the body it returns is a block of mixed Chinese and English advice
 * that names no cause and no way forward. This pins the sentence the user reads.
 */
test('the channel refusal names its cause and the way forward', () => {
  const { unapprovedChannelRefusal } = require('../lib/loopback')
  const body = '{"code":11128,"msg":"Illegal API invocation from an unapproved channel","displayTips":{"zh":"这次调用没通过渠道校验"}}'
  const sentence = unapprovedChannelRefusal(body)
  assert.ok(typeof sentence === 'string', 'the refusal has to be recognised')
  assert.match(sentence, /DeepSeek Harness/, 'it names the identity the vendor rejected')
  assert.match(sentence, /international|Trae|Qoder/, 'and the sources that do serve it')
  assert.doesNotMatch(sentence, /unapproved channel|displayTips/, 'the vendor block of tips is not what the user reads')
  // A 400 that is not this one keeps the ordinary sentence, or the mapping would
  // swallow every real client error.
  assert.equal(unapprovedChannelRefusal('{"code":4003,"msg":"messages must not be empty"}'), undefined)
  assert.equal(unapprovedChannelRefusal('nothing structured'), undefined)
})
test('an upstream refusal reaches the client as a sentence, not as a document', () => {
  const { liftUpstreamMessage } = require('../lib/loopback')
  assert.equal(liftUpstreamMessage('{"error":{"message":"service busy"}}'), 'service busy',
    'the double-wrapped envelope must be lifted to the sentence inside it, not relayed as a document')
  assert.equal(liftUpstreamMessage('{"message":"quota reached"}'), 'quota reached',
    'the flat spelling of the same envelope is lifted the same way')
  // The control: a body that is not a document at all is passed through
  // untouched, or a prose refusal would be swallowed by the lift.
  assert.equal(liftUpstreamMessage('service busy'), 'service busy',
    'a non-JSON body is already a sentence and must survive unchanged')
  assert.equal(liftUpstreamMessage('{"error":{"message":"Cloud-IDE-JWT abcdef123456 rejected"}}'),
    'Cloud-IDE-JWT [redacted] rejected',
    'the credential an upstream quoted must stay redacted after the lift')
  assert.equal(liftUpstreamMessage(''), '', 'an empty body lifts to nothing rather than to itself')
})

/**
 * A transport failure is a 502 the client can act on, not a 500 about a status
 * code.
 *
 * A fetch that never reaches the upstream reports status 0, and `writeHead(0)`
 * throws: the answer the client got was a 500 carrying `Invalid status code: 0`
 * instead of the transport error that actually happened. That regression came
 * back once already, so the mapping is pinned against a `fetchImpl` that throws
 * for every credential.
 */
test('a Trae transport failure is answered 502 with the transport message', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  const credentials = [
    { accessToken: 'token-a', userId: 'user-a', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
    { accessToken: 'token-b', userId: 'user-b', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
  ]
  const chats = []
  const fetchImpl = async (url) => {
    const target = String(url)
    // The directory is served so the request gets as far as the chat call: the
    // 503 a cold directory answers says nothing about the status mapping.
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    chats.push(target)
    throw new Error('fixture transport collapse')
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => credentials, fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.equal(answer.status, 502, 'a transport failure must be answered as a bad gateway, not as a plugin bug')
    assert.equal(chats.length, 2, 'a transport failure belongs to no sign-in, so every one of them is tried')
    assert.match(body, /fixture transport collapse/, 'the answer must carry the reason the transport gave')
    assert.doesNotMatch(body, /Invalid status code/,
      'writeHead(0) throws, and that 500 hides the refusal the client could act on')
  } finally { await gateway.close() }
})

/**
 * A stream that goes idle mid-turn ends in an error, not in a clean close.
 *
 * The watchdog cancels a body that has stopped sending, and the cancelled read
 * resolves `done`. Without the check after it the relay closed the stream as
 * though the upstream had finished: the client saw a truncated turn that ended
 * successfully, and the only record of the stall was the warning the relay
 * logged. The constant is not injectable, so the function is lifted out of the
 * shipped module and run under a shortened one - the text is the shipped text,
 * and only the figure the timer waits for is the fixture's.
 */
test('a stalling upstream body errors the relayed stream instead of closing it', async () => {
  const source = fs.readFileSync(path.join(root, 'lib/upstream.js'), 'utf8')
  const context = vm.createContext({
    STREAM_IDLE_TIMEOUT_MS: 40, ReadableStream, Error, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  vm.runInContext(entryFunctions(['withIdleWatchdog'], source), context)
  const encoder = new TextEncoder()

  let controller
  const stalling = new ReadableStream({
    start(next) { controller = next; next.enqueue(encoder.encode('data: {"choices":[]}\n\n')) },
  })
  const reader = context.withIdleWatchdog(stalling).getReader()
  try {
    const first = await reader.read()
    assert.equal(first.done, false, 'the chunk that did arrive must still be relayed')
    await assert.rejects(reader.read(), /upstream stream went idle/,
      'a body that stops sending must end the relay in an error the client can see')
  } finally {
    await reader.cancel().catch(() => {})
    try { controller.close() } catch {}
  }

  // The control: a body that ends on its own still closes cleanly, or the case
  // above would pass for a watchdog that errors on every stream.
  const closing = new ReadableStream({
    start(next) { next.enqueue(encoder.encode('data: {"choices":[]}\n\n')); next.close() },
  })
  const clean = context.withIdleWatchdog(closing).getReader()
  let body = ''
  try {
    for (;;) {
      const next = await clean.read()
      if (next.done) break
      body += new TextDecoder().decode(next.value)
    }
    assert.match(body, /"choices"/, 'a body that ends on its own must still be relayed whole')
  } finally { await clean.cancel().catch(() => {}) }
})

/**
 * A `choices` that is not a list is not a chunk.
 *
 * The decoder reads output off `Array.isArray(choices)`, and a payload whose
 * `choices` arrived as an object has neither output nor usage to forward.
 * Forwarding it anyway answered the client with an empty turn wearing a 200.
 */
test('a Qoder frame whose choices is not a list is not forwarded as a chunk', () => {
  const { decodeQoderFrame } = require('../lib/qoder-sse')
  const frame = decodeQoderFrame('{"choices":{}}')
  assert.notEqual(frame.type, 'chunk',
    'a choices that is not a list carries no output, so it must not be relayed as one')
  assert.equal(frame.type, 'unknown', 'with no code and no usage there is nothing to report either')
  // The control: the same field as a list is still a chunk, or the case above
  // would pass for a decoder that forwards nothing at all.
  assert.equal(decodeQoderFrame('{"choices":[{"delta":{"content":"hi"}}]}').type, 'chunk')
})

/**
 * A key that is in hand is not reported as missing.
 *
 * WorkBuddy 5.6+ seals `accessToken` at rest, and the panel's at-rest line is
 * the only place the user is told why a sealed credential will not open. Once
 * the desktop app has handed over its key that line has to read as fine: an
 * account whose key is loaded but whose last fetch attempt failed would
 * otherwise be reported as unopenable, and the advice it prints (point
 * `WORKBUDDY_APP_EXECUTABLE` at the install) sends the user chasing a problem
 * that is already solved.
 */
test('an at-rest key that is loaded is not reported as missing', async (t) => {
  const temporary = scratch('xdpool-atrest-test-')
  const stub = path.join(temporary, 'WorkBuddyStub.exe')
  // The stub prints the payload the installed app prints; reading it back is
  // what the launcher is stubbed to do, so the fixture is a file rather than a
  // hard-coded string.
  fs.writeFileSync(stub, JSON.stringify({ atRestSecretKey: 'fixture-secret' }))
  const previous = process.env.WORKBUDDY_APP_EXECUTABLE
  // The two seams into the installed app: the launch itself, and the registry
  // walk that only runs when the standard roots hold nothing. Both are stubbed
  // so the case is a property of the fixture and not of this machine.
  const childProcess = require('node:child_process')
  t.mock.method(childProcess, 'execFileSync', () => '')
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    if (file !== stub) {
      callback(new Error('fixture: the desktop app did not answer'), '', 'fixture stderr')
      return
    }
    callback(null, fs.readFileSync(stub, 'utf8'), '')
  })
  // A private copy of the module per half: the key map is module state, and the
  // two halves need opposite states in the same process.
  const freshAtRest = () => {
    const atRestPath = require.resolve('../lib/at-rest')
    const original = require.cache[atRestPath]
    delete require.cache[atRestPath]
    const loaded = require(atRestPath)
    if (original === undefined) delete require.cache[atRestPath]
    else require.cache[atRestPath] = original
    return loaded
  }
  try {
    delete process.env.WORKBUDDY_APP_EXECUTABLE
    const cold = freshAtRest()
    assert.equal(await cold.encryptedFieldOpener(), undefined,
      'with no executable to ask there is no key, so nothing can be opened')
    assert.match(cold.atRestKeyFailure(), /WorkBuddy executable/,
      'a machine with no candidate must say which roots were walked')

    process.env.WORKBUDDY_APP_EXECUTABLE = stub
    const warm = freshAtRest()
    // The opener coming back is what proves the key really is in the map, so the
    // empty reason below is the guard answering rather than an absent one.
    assert.equal(typeof await warm.encryptedFieldOpener(), 'function',
      'the stub must be seen to hand over a key, or the case proves nothing')
    assert.equal(warm.atRestKeyFailure(), '',
      'a key that is loaded must not be reported as missing')
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_APP_EXECUTABLE
    else process.env.WORKBUDDY_APP_EXECUTABLE = previous
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * One composer answer carries eight packs, whatever the probe cached.
 *
 * The answer crosses the host's renderer relay, which refuses an oversized
 * payload - and five refusals in a row open a breaker that disables every
 * control in the popup. An account's pack list is whatever the upstream pages
 * back, so the cap is applied where the answer is built rather than trusted.
 */
test('a composer answer carries at most eight packages', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const ceiling = /^const MAX_COMPOSER_PACKAGES = (\d+);$/m.exec(source)
  assert.ok(ceiling, 'the entry must declare the pack cap it answers with')
  assert.equal(Number(ceiling[1]), 8, 'the shipped cap is eight packs per account')
  const packages = Array.from({ length: 100 }, (_, index) => ({
    packageName: `pack-${index}`, nameKey: `key-${index}`, remain: index, size: 1000,
    roundExpiresAtMs: 1, expiresAtMs: 2, neverExpires: true, monthly: true, validDays: 3,
  }))
  const context = vm.createContext({
    settings: { showComposerPoints: true },
    core: { pool: {
      list: () => [{ id: 'acct-1', label: 'Fixture' }],
      available: () => [{ id: 'acct-1', label: 'Fixture' }],
    } },
    probeCache: new Map([['acct-1', { value: { credits: { total: 1000, packages } } }]]),
    preferredAccountId: () => 'acct-1',
    distributionSetting: () => 'round-robin',
    probesStale: () => false,
    activeRegions: () => ['cn'],
    declarationModels: () => [{ id: 'fixture', name: 'Fixture Model' }],
    activeTraeRegions: () => [], traeDeclarationModels: () => [],
    activeQoderRegions: () => [], qoderDeclarationModels: () => [],
    // The chip text is resolved against the published declaration, and this
    // fixture stands in for one WorkBuddy region.
    manifestProviders: () => [{ id: 'xdpool-cn', models: [{ id: 'fixture', name: 'Fixture Model' }] }],
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn', global: 'xdpool-global' },
    TRAE_PROVIDER_ID_BY_REGION: { cn: 'xdpool-trae-cn', ai: 'xdpool-trae-ai' },
    QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn', global: 'xdpool-qoder-global' },
    REGIONS: ['cn', 'global'],
    TRAE_REGIONS: ['cn', 'ai'],
    QODER_REGIONS: ['cn', 'global'],
    composerPrefer: async () => ({}), composerRefresh: async () => ({}),
  })
  vm.runInContext([
    ceiling[0],
    entryFunctions(['composerPointsEnabled', 'composerModels', 'composerChipText', 'composerChipTextOf',
      'matchComposerModel', 'composerPackages', 'workbuddyComposerAccounts', 'composerPoints',
      'routeOfProviderId', 'modelTag', 'onRendererCall'], source),
  ].join('\n'), context)
  const answer = await context.onRendererCall('xd.composerPoints',
    { chip: 'Fixture Model', provider: 'xdpool-cn', model: 'fixture' })
  assert.equal(answer.show, true, 'the probe cache must be seen to answer, or the cap is untested')
  assert.equal(answer.accounts.length, 1)
  assert.equal(answer.accounts[0].packages.length, 8,
    'a probe that cached a hundred packs must not put a hundred packs in one relayed answer')
  assert.equal(answer.accounts[0].packages[0].packageName, 'pack-0',
    'the cap keeps the head of the list, which is the part the popup shows first')
  assert.equal(answer.accounts[0].packages[7].packageName, 'pack-7')
})



/**
 * The cached OSCrypt key survives the reader that zeroes its own copy.
 *
 * The reader zeroes the buffer it was handed, and the cache used to hand out
 * the very buffer it kept: the first read in a process worked and every later
 * one decrypted with an empty key, which reads as an unopenable sign-in for
 * the rest of the process. A machine only saw it once the discovery TTL had
 * expired, because until then the cached answer was served without a read.
 *
 * The blob is a real AES-256-GCM ciphertext under a known key, and the DPAPI
 * unwrap is the stubbed seam (the one that would need the installed app), so
 * the decipher and the cache are the real code.
 */
test('a second Qoder read in one process still opens the sealed session', async () => {
  const { EventEmitter } = require('node:events')
  const { createCipheriv } = require('node:crypto')
  const { readQoderCredential, resetQoderCredentialCache } = require('../lib/qoder-credentials')
  const { qoderStorageCandidates } = require('../lib/qoder-discovery')
  const temporary = scratch('xdpool-qoder-key-')
  const restore = { APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.APPDATA = temporary
  process.env.USERPROFILE = temporary
  process.env.HOME = temporary
  const key = Buffer.alloc(32, 7)
  const nonce = Buffer.alloc(12, 3)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify({ token: 'qoder-token', user: { id: 'user-1' } }), 'utf8'),
    cipher.final(),
  ])
  const blob = Buffer.concat([Buffer.from('v10'), nonce, sealed, cipher.getAuthTag()])
  const child = require('node:child_process')
  const realSpawn = child.spawn
  child.spawn = () => {
    const fake = new EventEmitter()
    fake.stdout = new EventEmitter()
    fake.stdout.setEncoding = () => {}
    fake.stderr = new EventEmitter()
    fake.stderr.setEncoding = () => {}
    fake.kill = () => {}
    // The unwrap writes the blob on stdin and reads the key on stdout; both
    // listeners are attached by the time stdin is ended.
    fake.stdin = {
      end: () => {
        fake.stdout.emit('data', key.toString('base64'))
        fake.emit('close', 0)
      },
    }
    return fake
  }
  try {
    const candidates = qoderStorageCandidates()
    const auth = candidates.find((candidate) => candidate.kind === 'auth-v1')
    const local = candidates.find((candidate) => candidate.kind === 'local-state')
    fs.mkdirSync(path.dirname(auth.path), { recursive: true })
    fs.writeFileSync(auth.path, blob)
    // A Local State whose encrypted_key is a DPAPI blob, so the unwrap reaches
    // the stubbed spawn rather than refusing the file.
    fs.writeFileSync(local.path, JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(48)]).toString('base64') },
    }))
    resetQoderCredentialCache()
    const group = candidates.filter((candidate) => candidate.appDir === auth.appDir)
    const first = await readQoderCredential(group)
    assert.equal(first.credential?.token, 'qoder-token', 'the first read must open the session')
    const second = await readQoderCredential(group)
    assert.equal(second.credential?.token, 'qoder-token',
      'the second read must open it too: the reader zeroes its own copy, not the cached key')
  } finally {
    child.spawn = realSpawn
    for (const name of Object.keys(restore)) {
      if (restore[name] === undefined) delete process.env[name]
      else process.env[name] = restore[name]
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The response-headers deadline is not the stream's deadline.
 *
 * A signal handed to `fetch` stays attached to the response body: undici errors
 * the body when it fires, so a deadline meant for the headers phase cut every
 * turn that ran longer than the deadline. Measured on this machine, WorkBuddy
 * turns died at 60s and Trae and Qoder turns at 120s, the client meeting a
 * reset connection with the reply half-read. The fixture drips its body slower
 * than the headers deadline on purpose: the whole stream must still arrive.
 */
test('a chat stream outlives its response-headers deadline', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  const pieces = ['data: {"choices":[{"delta":{"content":"he"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n', 'data: [DONE]\n\n']
  let served = 0
  const fetchImpl = async (_url, init) => {
    served += 1
    const signal = init?.signal
    return new Response(new ReadableStream({
      async start(next) {
        // Faithful to what undici does with the signal it is handed: it stays
        // attached to the body, and firing it errors the stream. A fixture that
        // ignored the signal could not tell a headers deadline from a stream
        // deadline, which is the whole difference under test.
        signal?.addEventListener('abort', () => next.error(signal.reason))
        for (const piece of pieces) {
          await new Promise((resolve) => setTimeout(resolve, 30))
          if (signal?.aborted === true) { next.error(signal.reason); return }
          next.enqueue(new TextEncoder().encode(piece))
        }
        next.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const result = await client.chatStream(credential, '{}', undefined, { headersMs: 40, idleMs: 5000 })
  assert.equal(result.ok, true, 'the request itself must succeed')
  if (!result.ok) return
  const body = await result.response.text()
  assert.match(body, /"content":"he"/, 'the first piece of the stream must arrive')
  assert.match(body, /"content":"llo"/, 'and so must the last: the headers deadline may not cut the body')
  assert.match(body, /\[DONE\]/, 'the stream must run to its own end')
  assert.equal(served, 1, 'one request, one stream')
})

/**
 * A body that stops sending mid-turn fails the stream, through the client.
 *
 * The watchdog was reachable only by lifting the function out of the shipped
 * module, which proved the function and nothing about the wiring: the fetch's
 * own deadline always fired first, so the watchdog never ran at all. This goes
 * through the client, so the body really is the one the watchdog wraps.
 */
test('a silent body fails the stream through the client that opened it', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  const fetchImpl = async () => new Response(new ReadableStream({
    start(next) { next.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')) },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const result = await client.chatStream(credential, '{}', undefined, { headersMs: 5000, idleMs: 40 })
  assert.equal(result.ok, true, 'the headers arrived, so the stream is open')
  if (!result.ok) return
  await assert.rejects(result.response.text(), /upstream stream went idle/,
    'a body that stops sending must end the relay in an error the client can see')
})

/**
 * A chat request that never answers is cut at the headers deadline.
 *
 * The deadline exists for the upstream that accepts the POST and then goes
 * quiet, which used to hold the turn until the host's own fetch timeout. It has
 * to fire while the request is still waiting for headers, and it has to surface
 * as the transport failure the failover rotates on.
 */
test('a chat request that never answers is cut at the headers deadline', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
  })
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const result = await client.chatStream(credential, '{}', undefined, { headersMs: 40 })
  assert.equal(result.ok, false, 'a request that never answers must fail rather than hang')
  if (result.ok) return
  assert.equal(result.status, 0, 'the failure is a transport one, which is what rotates')
  assert.match(result.message, /transport error/, 'the answer must carry the deadline as its reason')
})

/**
 * A connection that dies during the peek still rotates to the next sign-in.
 *
 * The peek reads ahead before anything reaches the client, and a transport
 * failure inside it escaped `attemptOnce` altogether: the turn was answered
 * with a plugin-level 500 and the second sign-in was never tried, even though a
 * transport failure belongs to no sign-in and every one of them is worth a try.
 */
test('a connection that dies during the peek still rotates to the next sign-in', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  const first = { accessToken: 'token-a', userId: 'user-a', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  const second = { accessToken: 'token-b', userId: 'user-b', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  let chats = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    chats += 1
    if (chats === 1) {
      // 200 headers, then the connection dies before the peek has a frame.
      return new Response(new ReadableStream({
        start(next) { next.error(new TypeError('terminated')) },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('data: {"response":"served by the second sign-in"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [first, second], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.equal(answer.status, 200, 'the sign-in behind the broken connection must serve the turn')
    assert.ok(body.includes('served by the second sign-in'), 'the reply must come from the second sign-in')
    assert.equal(chats, 2, 'the broken connection must cost one attempt, not the whole turn')
  } finally { await gateway.close() }
})

/**
 * A Trae refusal is recognised on the event names the shape decoder files as
 * content and as a terminator.
 *
 * The refusal recogniser only looked at frames the decoder could not place, and
 * Trae sends the subscription gate on `event: output` and `event: done` as
 * readily as on a bare frame: those were answered as an empty 200 turn with no
 * error at all. The other direction matters just as much - a bare code in the
 * 400..1004 band is bookkeeping, and reading it as a refusal turned healthy
 * turns into 4xx answers.
 */
test('a Trae refusal is recognised wherever the frame put it, and only there', () => {
  const { decodeTraeEvent } = require('../lib/trae-sse')
  const { traeFailureOf } = require('../lib/trae-shim')
  const of = (data, event) => traeFailureOf(decodeTraeEvent({ data, ...event === undefined ? {} : { event } }))
  // A refusal on the two event names that decode as an empty delta and as a
  // terminator, plus the bare spelling.
  assert.equal(of('{"code":1005,"message":"subscription gate"}', 'output')?.code, 1005,
    'a refusal riding on the output event name must not pass as an empty turn')
  assert.equal(of('{"code":4001,"message":"bad config"}', 'done')?.code, 4001,
    'a refusal riding on the done event name must not pass as a clean finish')
  assert.equal(of('{"code":1005,"response":"","message":"gate"}')?.code, 1005,
    'the bare spelling of the same refusal is still a refusal')
  // The other direction: a code with no words in the undocumented band is
  // bookkeeping, and Trae's own codes above 1005 speak for themselves.
  assert.equal(of('{"code":429}'), undefined, 'a bare 429 is a usage figure until it says otherwise')
  assert.equal(of('{"code":400}'), undefined, 'a bare 400 is metadata until it says otherwise')
  assert.equal(of('{"code":1005}')?.code, 1005, 'a code in Trae\'s own range is a refusal on its own')
  assert.equal(of('{"prompt_tokens":10,"code":429}', 'token_usage'), undefined,
    'a usage frame is bookkeeping whatever code it carries')
  assert.equal(of('{"response":"hi","code":1005}', 'output'), undefined,
    'a frame that carries output is content, whatever else it says')
})

/**
 * A Qoder refusal spelled as a bare string is still a failure.
 *
 * The unwrap read the code from `errorCode`/`code` and the message from
 * `message`/`errorMessage`, and only descended into `error`/`details` when they
 * were objects. Qoder spells a refusal `{"choices":[],"error":"Login expired"}`
 * as often as it spells one with a code, and those frames were dropped as
 * unnamed, which answered the client with an empty turn and no error.
 */
test('a Qoder refusal spelled as a bare string is still a failure', () => {
  const { decodeQoderFrame } = require('../lib/qoder-sse')
  assert.equal(decodeQoderFrame('{"choices":[],"error":"Login expired"}').type, 'failure',
    'a refusal whose only text sits in a bare error string must not be dropped')
  assert.equal(decodeQoderFrame('{"choices":[],"details":"quota spent"}').type, 'failure',
    'the same text under details is the same refusal')
  // The control: a keepalive with neither a code nor words is still unnamed.
  assert.equal(decodeQoderFrame('{"success":true}').type, 'unknown')
})

/**
 * An upstream rate limit carries its own wait time to the client.
 *
 * The in-stream path relays the wait the upstream put in its frame; the
 * non-2xx path dropped the `Retry-After` header, so a client told to wait had
 * no wait to read and retried straight back into the limited account.
 */
test('an upstream rate limit carries its own wait time to the client', async () => {
  const { createQoderGateway } = require('../lib/qoder-gateway')
  const limited = { userID: 'limited-user', token: 'limited-token', name: '', email: '' }
  const fetchImpl = async (url) => {
    if (String(url).includes('/model/list')) {
      return new Response(JSON.stringify({ chat: [{ key: 'qoder-model', display_name: 'Qoder', enable: true }] }))
    }
    return new Response(JSON.stringify({ code: 429, message: 'slow down' }), {
      status: 429, headers: { 'retry-after': '120' },
    })
  }
  const gateway = createQoderGateway({ region: 'cn', port: 0, credentials: async () => [limited], fetchImpl })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'qoder-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 429, 'the upstream\'s own status is what the client is answered with')
    assert.equal(answer.headers.get('retry-after'), '120',
      'the wait the upstream named must reach the client instead of being dropped')
  } finally { await gateway.close() }
})

/**
 * A Qoder session that records no expiry is not read as long dead.
 *
 * The numeric fallback ran `Date.parse` over whatever was left, and `0` parses
 * as the year 2000: a layout that spells "no expiry" as 0 had its sign-in
 * dropped out of rotation for looking decades old.
 */
test('a Qoder session that records no expiry stays in rotation', () => {
  const { parseQoderAuthSession } = require('../lib/qoder-credentials')
  const session = (expiresAt) => JSON.stringify({ token: 'fixture-token', user: { id: 'fixture-user' }, expiresAt })
  assert.equal(parseQoderAuthSession(session(0))?.expiresAtMs, 0, 'a numeric 0 is no expiry, not the year 2000')
  assert.equal(parseQoderAuthSession(session('0'))?.expiresAtMs, 0, 'the string spelling of 0 is the same')
  assert.equal(parseQoderAuthSession(session(-5))?.expiresAtMs, 0, 'a nonsense number is no expiry either')
  assert.equal(parseQoderAuthSession(session(1794032368000))?.expiresAtMs, 1794032368000,
    'a millisecond timestamp is still read as one')
  assert.equal(parseQoderAuthSession(session(1794032368))?.expiresAtMs, 1794032368000,
    'a second timestamp is still read as one')
  const iso = '2027-01-01T00:00:00Z'
  assert.equal(parseQoderAuthSession(session(iso))?.expiresAtMs, Date.parse(iso),
    'a date string is still read as one')
})

/**
 * A Qoder claim that paid nothing carries no amount.
 *
 * `amount` fell back to the campaign's advertised figure whenever the answer
 * was not a replay, so a claim that never reached CLAIMED reported credits that
 * never landed.
 */
test('a Qoder claim that paid nothing carries no amount', () => {
  const { qoderNormalizeClaimResult } = require('../lib/qoder-client')
  const campaign = { benefit: { amount: 30 } }
  const unpaid = qoderNormalizeClaimResult({}, campaign)
  assert.equal(unpaid.claimed, false, 'an empty answer granted nothing')
  assert.equal(unpaid.amount, undefined, 'and must not name the credits it did not pay')
  const replayed = qoderNormalizeClaimResult({ data: { status: 'CLAIMED', replayed: true } }, campaign)
  assert.equal(replayed.replayed, true, 'a repeat is still a success')
  assert.equal(replayed.amount, undefined, 'but it paid nothing, so it names no amount')
  const paid = qoderNormalizeClaimResult({ data: { status: 'CLAIMED' } }, campaign)
  assert.equal(paid.claimed, true)
  assert.equal(paid.amount, 30, 'a claim that paid out names what it paid')
})

/**
 * A promo window that runs past midnight is promised only as far as the rule's
 * last day allows.
 *
 * The night window is 23:00 to 08:00, so on the rule's final day the hours
 * after midnight are outside it. The badge used to answer "free from 00:00"
 * for the whole last evening, which is wrong in both directions: the model IS
 * free from 23:00, and 00:00 is past the rule so it is not free then either.
 */
test('a promo window is not promised past the rule\'s last day', () => {
  const { promoStatusFor } = require('../lib/promo')
  const model = { id: 'hy4-preview' }
  const lastDay = { day: '2026-10-31', hour: 23 }
  assert.deepEqual(promoStatusFor(model, lastDay, 'cn'), { kind: 'night', untilHour: 24 },
    'on the last day the window is promised up to midnight, not past it')
  assert.equal(promoStatusFor(model, { day: '2026-10-30', hour: 23 }, 'cn')?.untilHour, 8,
    'the day before, the same window is promised in full')
  assert.equal(promoStatusFor(model, { day: '2026-10-31', hour: 2 }, 'cn')?.untilHour, 8,
    'and inside the rule\'s last day the window still ends before midnight')
  assert.equal(promoStatusFor(model, { day: '2026-10-31', hour: 22 }, 'cn')?.kind, 'night-later',
    'before the window opens on the last day it is still offered as opening later')
  assert.equal(promoStatusFor(model, { day: '2026-11-01', hour: 2 }, 'cn'), undefined,
    'past the rule there is no window at all')
})

/**
 * A Trae install holding two sign-ins says its device id is a fallback.
 *
 * The device number is what the check-in endpoint accepts, and one install with
 * two device-center ids has none to send: the fallback is a hash, which the
 * endpoint answers 9074. That used to arrive as a bare code with nothing said
 * about why.
 */
test('a Trae install with two sign-ins reports a fallback device id', async () => {
  const { readTraeIdentity } = require('../lib/trae-identity')
  const temporary = scratch('xdpool-trae-identity-')
  try {
    const storagePath = path.join(temporary, 'User', 'globalStorage', 'storage.json')
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
    fs.writeFileSync(storagePath, JSON.stringify({
      'telemetry.machineId': 'fixture-machine',
      'telemetry.devDeviceId': '11111111-2222-3333-4444-555555555555',
      'iCubeAuthInfo://icube-dc:1000000000000001': '{}',
      'iCubeAuthInfo://icube-dc:1000000000000002': '{}',
    }))
    const identity = await readTraeIdentity({ path: storagePath, edition: 'cn', source: 'desktop' })
    assert.equal(identity.deviceIdIsFallback, true,
      'two device-center ids leave no persisted device number, and the caller must be able to say so')
    assert.notEqual(identity.deviceId, '1000000000000001',
      'the id of one of the two accounts must not be sent as the machine\'s')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A Trae storage file that is not an object fails as unreadable, not as a
 * TypeError.
 *
 * `null` on disk read as a crash about reading a property of null, which lost
 * the one thing worth knowing: the file is there and will not parse.
 */
test('a Trae storage file that is not an object fails as unreadable', async () => {
  const { readTraeIdentity } = require('../lib/trae-identity')
  const temporary = scratch('xdpool-trae-storage-')
  try {
    const storagePath = path.join(temporary, 'User', 'globalStorage', 'storage.json')
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
    fs.writeFileSync(storagePath, 'null')
    await assert.rejects(readTraeIdentity({ path: storagePath, edition: 'cn', source: 'desktop' }),
      /not a JSON object/, 'a storage file holding null must be reported as unreadable')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A stream whose lines end on a bare carriage return is still read.
 *
 * The SSE grammar allows a lone `\r` as a line separator, and Trae's decoder
 * learned it. Qoder's reader looked for `\n` only, so a CR-terminated stream
 * buffered whole until the line guard threw: twenty thousand frames, none of
 * them delivered.
 */
test('a Qoder stream whose lines end on a bare carriage return is read', () => {
  const { QoderFrameDecoder } = require('../lib/qoder-sse')
  const decoder = new QoderFrameDecoder()
  const payloads = []
  for (let frame = 0; frame < 3; frame += 1) {
    // A blank line ends the frame, spelled with the same lone CR: the shape a
    // CR-only stream really has.
    payloads.push(...decoder.push('data: {"choices":[{"delta":{"content":"x"}}]}\r\r'))
  }
  assert.equal(payloads.length, 3, 'a lone CR ends a line exactly as a newline does')
  // The control: the newline spelling still works, and `[DONE]` still ends it.
  const plain = new QoderFrameDecoder()
  assert.deepEqual(plain.push('data: {"a":1}\ndata: [DONE]\n'), ['{"a":1}'])
  assert.equal(plain.ended, true)
})

/**
 * A stream that ends on a bare carriage release still carries its `[DONE]`.
 *
 * The tail of the buffer was handed to the line consumer with the `\r` still
 * attached, so the literal did not match and the turn ran to EOF instead of
 * ending on the upstream's own marker.
 */
test('a Trae stream ending on a bare carriage return still ends on its marker', () => {
  const { SseDecoder, decodeTraeEvent } = require('../lib/trae-sse')
  const decoder = new SseDecoder()
  const events = [...decoder.push('data: [DONE]\r'), ...decoder.finish()]
  assert.equal(events.length, 1, 'the trailing marker must survive the carriage return')
  assert.equal(decodeTraeEvent(events[0]).type, 'done', 'and it must read as the end of the turn')
})

/**
 * An upstream refusal that carries no sentence lifts to nothing.
 *
 * `{}`, `{"error":{}}` and a page of HTML all lifted to themselves, and the
 * gateway's own fallback sentence never fired because the lifted text was not
 * empty: the client read a serialized document where a reason should be.
 */
test('an upstream refusal that carries no sentence lifts to nothing', () => {
  const { liftUpstreamMessage } = require('../lib/loopback')
  assert.equal(liftUpstreamMessage('{}'), '', 'an empty document has no sentence to lift')
  assert.equal(liftUpstreamMessage('{"error":{}}'), '', 'an empty error object has none either')
  assert.equal(liftUpstreamMessage('{"code":429}'), '', 'a bare code is not a sentence')
  assert.equal(liftUpstreamMessage('{"error":"service busy"}'), 'service busy',
    'a refusal whose error arrived as a string is lifted like any other')
  assert.equal(liftUpstreamMessage('service busy'), 'service busy',
    'and a body that is already a sentence survives unchanged')
})

/**
 * A caller that already hung up gets no upstream request.
 *
 * The deadline controller only forwarded aborts that arrived after it was
 * built, so a hang-up that landed in the window between the gateway's check and
 * the fetch still sent the request: the turn was paid for by nobody, and the
 * relay kept writing to a socket the client had closed.
 */
test('a caller that already hung up gets no upstream request', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  let served = 0
  const fetchImpl = async (_url, init) => {
    // Faithful to undici: a signal that is already aborted refuses the request
    // before it is made. A fixture that ignored the signal could not tell a
    // hang-up that arrived in time from one that arrived too late.
    if (init?.signal?.aborted === true) throw init.signal.reason
    served += 1
    return new Response('data: [DONE]\n\n', { status: 200 })
  }
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const hung = AbortSignal.abort(new Error('the client is gone'))
  const result = await client.chatStream(credential, '{}', hung, { headersMs: 40 })
  assert.equal(result.ok, false, 'the request must not be made for a turn nobody is reading')
  assert.equal(served, 0, 'and the upstream must see nothing at all')
  // The control: a live caller still gets its request.
  const live = await client.chatStream(credential, '{}', undefined, { headersMs: 40 })
  assert.equal(live.ok, true, 'a caller that is still there must be served')
  assert.equal(served, 1)
})

/**
 * A stream that ends releases its watchdog timer.
 *
 * The timer was armed again after every chunk and never cleared on the last
 * one, so every finished turn left one counting down for the full idle window,
 * holding the reader and the upstream response with it.
 */
test('a stream that ends releases its watchdog timer', async () => {
  const source = fs.readFileSync(path.join(root, 'lib/upstream.js'), 'utf8')
  const encoder = new TextEncoder()
  let armed = 0
  let cleared = 0
  // Instrumented into the context rather than patched onto the globals
  // afterwards: the watchdog takes its timers from the realm it was lifted
  // into, so only what that realm sees can be counted.
  const context = vm.createContext({
    STREAM_IDLE_TIMEOUT_MS: 40,
    ReadableStream, Error,
    setTimeout: () => { armed += 1; return { unref() {} } },
    clearTimeout: () => { cleared += 1 },
  })
  vm.runInContext(entryFunctions(['withIdleWatchdog'], source), context)
  const closing = new ReadableStream({
    start(next) { next.enqueue(encoder.encode('data: {"choices":[]}\n\n')); next.close() },
  })
  const reader = context.withIdleWatchdog(closing).getReader()
  await reader.read()
  await reader.read()
  assert.ok(armed > 0, 'the watchdog must have armed at least once')
  assert.equal(cleared, armed,
    'every timer the watchdog armed must be cleared, including the one the last chunk armed')
})

/**
 * A `Retry-After` is validated and bounded before it is sent.
 *
 * The upstream's wait time was forwarded as it arrived. An empty string, prose
 * or a number of years is enough to park a client - or a whole model pool - for
 * as long as it chooses to honour the header.
 */
test('a retry-after is validated and bounded before it is sent', () => {
  const { retryAfterHeader } = require('../lib/loopback')
  assert.equal(retryAfterHeader('120'), '120', 'a plain wait is forwarded as it is')
  assert.equal(retryAfterHeader(42), '42', 'and so is a numeric one')
  assert.equal(retryAfterHeader('1e9'), '7200', 'a wait of thirty years is bounded to two hours')
  assert.equal(retryAfterHeader(''), undefined, 'an empty value is dropped rather than sent')
  assert.equal(retryAfterHeader('soon'), undefined, 'and so is prose')
  assert.equal(retryAfterHeader('-5'), undefined, 'a negative wait is not a wait')
  assert.equal(retryAfterHeader(undefined), undefined, 'and an absent one is simply absent')
})

/**
 * A Trae refusal spelled with a bare string is still a refusal.
 *
 * The recogniser read the message out of `message`/`errorMessage` and only
 * descended into `error`/`details` when they were objects. Trae spells a refusal
 * `{"error":"Login expired"}` as often as it spells one with a code, and those
 * frames passed as an empty turn.
 */
test('a Trae refusal spelled with a bare string is still a refusal', () => {
  const { decodeTraeEvent } = require('../lib/trae-sse')
  const { traeFailureOf, describeTraeFailure } = require('../lib/trae-shim')
  const of = (data, event) => traeFailureOf(decodeTraeEvent({ data, ...event === undefined ? {} : { event } }))
  assert.equal(of('{"error":"Login expired"}')?.message, 'Login expired',
    'a refusal whose only text sits in a bare error string must not pass as an empty turn')
  assert.equal(of('{"details":"quota spent"}')?.message, 'quota spent',
    'the same text under details is the same refusal')
  // And a refusal with neither a code nor words still says something.
  const silent = of('{}', 'error')
  assert.notEqual(silent, undefined, 'an error event with no payload is still a refusal')
  assert.notEqual(describeTraeFailure(silent), '', 'and its message must not be empty')
})

/**
 * A Trae queue frame is answered as the rate limit it is.
 *
 * The wait rides inside the message as a JSON document. Reading it as a server
 * failure told the client to retry at once and kept the sign-in out of the
 * rotation, where the Qoder path answers 429 with the wait and moves on.
 */
test('a Trae queue frame is answered as the rate limit it is', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  const first = { accessToken: 'token-a', userId: 'user-a', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  const second = { accessToken: 'token-b', userId: 'user-b', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  let chats = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    chats += 1
    if (chats === 1) {
      const frame = JSON.stringify({ code: '10605', message: JSON.stringify({ queueType: 'q', retryAfterSeconds: 45 }) })
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('data: {"response":"served by the second sign-in"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [first, second], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 200, 'the sign-in behind the queued one must serve the turn')
    assert.equal(chats, 2, 'a queue belongs to the sign-in, so it rotates')
    const body = await answer.text()
    assert.ok(body.includes('served by the second sign-in'), 'the reply must come from the second sign-in')
  } finally { await gateway.close() }
})

/**
 * A refusal the vendor fragments across many chunks is still a refusal.
 *
 * The relay reads ahead a bounded number of chunks looking for a failure before
 * it commits a status, and a peek that stops early answers a failure as a
 * truncated success: the client gets a 200 whose body ends mid-sentence, which
 * reads as an upstream outage rather than as the sign-in it is about. Neither
 * vendor promises a refusal in one piece - a chunk boundary can fall anywhere -
 * so the peek has to keep reading until it has actually seen one.
 */
test('a Trae refusal the vendor fragments across many chunks is still a refusal', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  const signin = {
    accessToken: 'token', userId: 'user', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop',
    expiresAtMs: Date.now() + 3600000,
  }
  const encode = (text) => new TextEncoder().encode(text)
  const frame = (data) => `data: ${data}\n\n`
  // Two bytes at a time: no single chunk carries a whole frame, so the refusal
  // only exists once the peek has read enough of them and reassembled it.
  const refusal = frame(JSON.stringify({ error: 'Login expired' }))
  const pieces = []
  for (let at = 0; at < refusal.length; at += 2) pieces.push(encode(refusal.slice(at, at + 2)))
  pieces.push(encode(frame('[DONE]')))
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    return new Response(new ReadableStream({
      start(controller) { for (const piece of pieces) controller.enqueue(piece); controller.close() },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [signin], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 401,
      'a refusal split across chunks must be answered as the sign-in failure it is, not as a truncated success')
    const body = await answer.text()
    assert.ok(!body.includes('[DONE]'),
      'and it must not be relayed as a stream that merely stopped early')
  } finally { await gateway.close() }
})

/**
 * A refusal that arrives after the first content byte is relayed, not re-spelled.
 *
 * Once the client has bytes, the status is committed: HTTP cannot change it, and
 * answering a second status mid-body would be the client's bug to parse. The
 * refusal is still forwarded as an event so the client can act on it.
 *
 * This boundary is enforced twice, and the redundancy is deliberate rather than
 * accidental: the peek's event loop stops looking as soon as it has seen output,
 * and the relay separately refuses to re-spell a status once output has started.
 * Either alone is enough, which is why removing only one of them leaves this case
 * green - the pair is what makes the boundary survive a change to either.
 */
test('a Trae refusal after the first content byte is forwarded, not re-spelled', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  const signin = {
    accessToken: 'token', userId: 'user', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop',
    expiresAtMs: Date.now() + 3600000,
  }
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    return new Response(
      'data: {"response":"the first words"}\n\ndata: {"error":"Login expired"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [signin], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 200,
      'the status is committed once the first content byte is on the wire')
    const body = await answer.text()
    assert.ok(body.includes('the first words'), 'the content the vendor sent is relayed')
    assert.ok(body.includes('Login expired'),
      'and the refusal that followed it is forwarded too, so the client can act on it')
  } finally { await gateway.close() }
})

/**
 * A Qoder acknowledgement is not a refusal.
 *
 * `{"code":0}` is how Qoder acks, and reading it as a failure answered a healthy
 * turn with a 502 naming code 0. The error spellings carry business codes below
 * the success range and keep them.
 */
test('a Qoder acknowledgement is not read as a refusal', () => {
  const { decodeQoderFrame } = require('../lib/qoder-sse')
  assert.equal(decodeQoderFrame('{"choices":[],"code":0}').type, 'unknown',
    'a bare success code is an acknowledgement, not a refusal')
  assert.equal(decodeQoderFrame('{"choices":[],"code":200}').type, 'unknown',
    'and so is a 2xx one')
  assert.equal(decodeQoderFrame('{"choices":[],"errcode":"110"}').type, 'failure',
    'a business code under the error spelling is still a refusal')
  assert.equal(decodeQoderFrame('{"choices":[],"code":105,"message":"Login expired"}').type, 'failure',
    'and a code that carries words is a refusal whatever its number')
})

/**
 * The daily check-in decision, in Beijing time whatever the host's zone is.
 *
 * The reward windows are defined in Beijing time, so an hour has to mean the
 * same instant everywhere: reading the host's local hour would make "9 o'clock"
 * slip by a day on a laptop set to another zone, and the day's credits would
 * either never collect or collect twice. This rule had no test at all - breaking
 * the hour list, the slot id and the due-slot decision together left both suites
 * green.
 *
 * The instants below are chosen because at least one other zone disagrees with
 * Shanghai about the calendar day or the hour, which is what makes them prove
 * anything. The comparison is computed rather than assumed, so the test says so
 * itself if it ever stops being discriminating.
 */
test('the check-in hour is read in Beijing time, not the host zone', () => {
  const { zonedDayHour, checkinSlotId, dueCheckinSlot, normaliseCheckinHours, CHECKIN_TIME_ZONE } = require('../lib/checkin-time')
  assert.equal(CHECKIN_TIME_ZONE, 'Asia/Shanghai', 'the zone is the one the reward windows are defined in')

  const localIn = (date, zone) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '00'
    return pick('year') + '-' + pick('month') + '-' + pick('day') + 'T' + Number(pick('hour'))
  }

  const cases = [
    ['2026-10-16T16:30:00Z', '2026-10-17', 0], // 00:30 the next day in Shanghai
    ['2026-10-16T15:59:59Z', '2026-10-16', 23], // 23:59, one second before the day turns
    ['2026-10-16T00:00:00Z', '2026-10-16', 8],
    ['2026-10-16T16:00:00Z', '2026-10-17', 0], // exactly midnight in Shanghai
  ]
  let discriminating = 0
  for (const [iso, day, hour] of cases) {
    const date = new Date(iso)
    const zoned = zonedDayHour(date)
    assert.equal(zoned.day, day, `${iso} must read as ${day} in the check-in zone`)
    assert.equal(zoned.hour, hour, `${iso} must read as hour ${hour} in the check-in zone`)
    for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Auckland']) {
      if (localIn(date, zone) !== `${day}T${hour}`) { discriminating += 1; break }
    }
  }
  assert.ok(discriminating >= 3,
    'at least three of these instants must distinguish Shanghai from another zone, or the test is vacuous')

  assert.equal(checkinSlotId('2026-10-17', 0), '2026-10-17T00', 'a single-digit hour is zero-padded')
  assert.equal(checkinSlotId('2026-10-17', 9), '2026-10-17T09')
  assert.equal(checkinSlotId('2026-10-17', 23), '2026-10-17T23')
})

/**
 * What the configured hours mean, and which slot is due.
 *
 * Catch-up is deliberate: a machine that slept through 09:00 still collects when
 * it wakes instead of waiting for tomorrow. The earliest unconsumed hour wins,
 * so two configured hours still give two passes a day, and a future hour is
 * never due however the list is ordered.
 */
test('a check-in slot is due once its hour has passed, earliest unconsumed first', () => {
  const { dueCheckinSlot, normaliseCheckinHours } = require('../lib/checkin-time')

  assert.deepEqual([...normaliseCheckinHours([5, 1, 3, 23, 1])], [1, 3, 5, 23])
  assert.deepEqual([...normaliseCheckinHours([])], [9], 'an empty list falls back to the default hour')
  assert.deepEqual([...normaliseCheckinHours([25, -1, 'nonsense', 9.7])], [9],
    'an out-of-range or unreadable hour is dropped, not rounded into range')
  assert.deepEqual([...normaliseCheckinHours([0, 23, 12])], [0, 12, 23], 'midnight and the last hour are valid')

  const at = (iso) => new Date(iso)
  const SH_0800 = '2026-10-17T00:00:00Z'
  const SH_1000 = '2026-10-17T02:00:00Z'
  const SH_0830 = '2026-10-17T00:30:00Z'

  assert.equal(dueCheckinSlot(at(SH_0830), [9], new Set()), undefined,
    'an hour that has not arrived yet is not due')
  assert.equal(dueCheckinSlot(at(SH_0800), [9], new Set()), undefined,
    'and the exact start of the hour is not due either')
  assert.equal(dueCheckinSlot(at(SH_1000), [9], new Set()), '2026-10-17T09',
    'a past hour is due: a machine that slept through 09:00 still collects')
  assert.equal(dueCheckinSlot(at(SH_1000), [9], new Set(['2026-10-17T09'])), undefined,
    'a slot already collected is not due again')
  assert.equal(dueCheckinSlot(at(SH_1000), [21], new Set()), undefined,
    'a later configured hour is not due while an earlier one has not been reached')
  assert.equal(dueCheckinSlot(at(SH_1000), [21, 9], new Set()), '2026-10-17T09',
    'the list order does not matter: the earliest due hour wins')
  assert.equal(dueCheckinSlot(at(SH_1000), [9, 21], new Set(['2026-10-17T09'])), undefined,
    'with the first hour spent and the second not yet reached, nothing is due')
  const bothPast = at('2026-10-17T14:00:00Z') // 22:00 Shanghai
  assert.equal(dueCheckinSlot(bothPast, [9, 21], new Set()), '2026-10-17T09',
    'with both hours past, the earlier one is due first')
  assert.equal(dueCheckinSlot(bothPast, [9, 21], new Set(['2026-10-17T09'])), '2026-10-17T21',
    'and once it is spent, the later one becomes due')
  assert.equal(dueCheckinSlot(bothPast, [9, 21], new Set(['2026-10-17T09', '2026-10-17T21'])), undefined,
    'and with both spent the day is done')
  assert.equal(dueCheckinSlot(at(SH_1000), [9], new Set(['2026-10-16T09'])), '2026-10-17T09',
    "a slot spent yesterday does not spend today's")
})

/**
 * The zone is read from the constant, not from the machine.
 *
 * The assertion above cannot prove this on its own: a machine already set to
 * UTC+8 gives the same answer whether the code reads Shanghai or reads the local
 * zone, so a regression there would look green. This runs the same instants in
 * child processes under four other zones and requires the Shanghai answer every
 * time, which is the only form of the claim that is falsifiable everywhere.
 */
test('the check-in zone holds on a machine set to any other zone', () => {
  const { execFileSync } = require('node:child_process')
  const path = require('node:path')
  const { zonedDayHour } = require('../lib/checkin-time')
  const cases = [
    ['2026-10-16T16:30:00Z', '2026-10-17', 0],
    ['2026-10-16T15:59:59Z', '2026-10-16', 23],
    ['2026-10-16T00:00:00Z', '2026-10-16', 8],
  ]
  const expected = cases.map(([iso, day, hour]) => `${iso} ${day} ${hour}`).join('\n')
  for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    const out = execFileSync(process.execPath, ['-e', `
      const { zonedDayHour } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'checkin-time.js'))})
      const cases = ${JSON.stringify(cases)}
      for (const [iso, day, hour] of cases) {
        const zoned = zonedDayHour(new Date(iso))
        console.log(iso + ' ' + zoned.day + ' ' + zoned.hour)
      }
    `], { env: { ...process.env, TZ: zone }, encoding: 'utf8' })
    assert.equal(out.trim(), expected,
      `under TZ=${zone} the check-in zone must still read as Beijing time`)
  }
  for (const [iso, day, hour] of cases) {
    const zoned = zonedDayHour(new Date(iso))
    assert.equal(`${iso} ${zoned.day} ${zoned.hour}`, `${iso} ${day} ${hour}`)
  }
})

/**
 * A check-in pass that starts after a stop runs, instead of reporting zero.
 *
 * The service stop aborts the flag every account loop reads. Re-arming it at
 * the service start resurrected the pass that stop had retired, so the entries
 * that come through `runCheckinPass` - the scheduled tick, the command, "run
 * now" - are the ones that must re-arm for themselves. Without it they broke
 * out of every loop at once, reported "checked in 0 account(s)" and marked the
 * day's slot as spent: the day's credits were lost silently.
 */
test('a check-in pass that starts after a stop still collects', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const claims = { workbuddy: 0, travel: 0, qoder: 0, trae: 0, growth: 0 }
  const slots = new Set()
  const context = vm.createContext({
    AbortController,
    GROWTH_AFTER_CHECKIN_MS: 0,
    // The state a service stop leaves behind: the flag is aborted, nothing is
    // running, and the pass this entry is about to start must not inherit it.
    checkinAbort: new AbortController(),
    checkinScope: { enterWith() {} },
    checkinPassRunning: false,
    checkinPassToken: 0,
    // Nothing is in growth, which is the state the guard has to let through.
    growthPassRunning: false,
    // The service is running again: a pass the user starts by hand after a stop
    // belongs to the activation that came back, which is the case under test.
    serviceStopped: false,
    checkinHours: () => [9],
    autoCheckinSlots: slots,
    autoCheckinLast: null,
    qoderRetryAt: 0,
    loadGeneration: 7,
    stillLoaded: () => true,
    zonedDayHour: () => ({ day: '2026-10-15', hour: 9 }),
    dueCheckinSlot: () => undefined,
    checkinSlotId: (day, hour) => `${day}T${hour}`,
    saveCheckinSlots: () => { slots.add('2026-10-15T9') },
    isolatedCheckinWorker: (work) => work,
    claimAllCheckins: async () => { claims.workbuddy += 1; return { claimed: 2, skipped: 0, failed: 0 } },
    travelAllAccounts: async () => { claims.travel += 1; return { departed: 0, claimed: 0, adopted: 0 } },
    qoderCheckinAll: async () => { claims.qoder += 1; return { claimed: 1, skipped: 0, failed: 0 } },
    traeCheckinAll: async () => { claims.trae += 1; return { claimed: 1, skipped: 0, failed: 0 } },
    checkinPause: async () => {},
    claimAllGrowth: async () => { claims.growth += 1; return { streak: 0, credit: 0 } },
    scheduleRefresh: () => {},
    log: () => {},
    safeMessage: (error) => String(error),
  })
  vm.runInContext(entryFunctions(['runCheckinPass'], source), context)
  // Aborted, exactly as a stop leaves it.
  context.checkinAbort.abort(new Error('the service stopped'))
  const answer = await context.runCheckinPass({ manual: true })
  assert.equal(answer.running, undefined, 'the pass must have run rather than reported one in flight')
  assert.equal(claims.workbuddy, 1, 'the WorkBuddy worker must have been called')
  assert.equal(claims.qoder, 1, 'and so must Qoder and Trae')
  assert.equal(claims.trae, 1)
  assert.equal(claims.growth, 1, 'the growth pass runs after the accounts')
  assert.equal(answer.claimed, 2, 'the counts the workers returned must reach the answer')
  assert.equal(context.checkinAbort.signal.aborted, false,
    'the pass must have re-armed the flag, or the next one inherits this stop')
  assert.equal(slots.has('2026-10-15T9'), true, 'a pass that ran has spent its slot')
})

/**
 * A reload installs a new controller while a pass is still between accounts.
 * The pause has to keep the signal that pass captured. Reading the global
 * instead returned at once, and the pass walked the rest of the pool.
 */
test('a check-in pause follows the pass that started it', async () => {
  const { AsyncLocalStorage } = require('node:async_hooks')
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const scope = new AsyncLocalStorage()
  const stopped = new AbortController()
  stopped.abort()
  const context = vm.createContext({
    AbortController,
    checkinAbort: stopped,
    checkinScope: scope,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(entryFunctions(['currentCheckinSignal', 'checkinPause'], source), context)
  const pass = new AbortController()
  const started = Date.now()
  await scope.run(pass.signal, () => context.checkinPause(40))
  assert.ok(Date.now() - started >= 30, 'the pause must wait on the pass signal, not the aborted global')
  const cut = new AbortController()
  const cutAt = Date.now()
  const pending = scope.run(cut.signal, () => context.checkinPause(5000))
  cut.abort()
  await pending
  assert.ok(Date.now() - cutAt < 500, 'aborting the pass signal must cut the pause')
})

/**
 * A reload aborts the previous load's work without touching its gateways.
 *
 * Clearing the maps here looked like the tidy thing to do, and it cost the Trae
 * and Qoder directory caches with them: those rows dropped out of the manifest
 * until the next warm-up happened to rebuild them, which on a machine whose
 * preferred ports are taken is not soon. `onUnload` already closes them.
 */
test('a load leaves the source gateways alone', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const body = entryFunctions(['onLoad'], source)
  assert.match(body, /checkinAbort\.abort\(\)/, 'a reload must still abort the pass it replaces')
  assert.match(body, /abortWarmups\(\)/, 'and stop its warm-ups')
  assert.doesNotMatch(body, /traeGateways\.clear\(\)/,
    'clearing Trae here drops its directory cache and its provider row with it')
  assert.doesNotMatch(body, /qoderGateways\.clear\(\)/, 'and the same for Qoder')
  // A WorkBuddy runtime is different: it closed over the pool and the client this
  // load has just replaced, so leaving it in the map serves the previous
  // activation's account list. It is retired and cleared instead, and the clear
  // is only allowed when every runtime it drops was first handed to a stop.
  if (/runtimes\.clear\(\)/.test(body)) {
    assert.match(body, /stopRuntime\(runtime\)/,
      'a runtime cleared here must be closed first, or its port is never released')
    assert.ok(body.indexOf('stopRuntime(runtime)') < body.indexOf('runtimes.clear()'),
      'and stopped before the map lets go of it')
  }
})

/**
 * A sign-in the panel started does not survive the reload that replaced it.
 *
 * `deviceLogins` holds the state each browser-based login is polled against. Its
 * own comment says a reload drops them so the panel starts over; nothing cleared
 * the map, so a poll arriving after an in-place reload was answered with a state
 * this activation never issued and could complete that sign-in.
 */
test('a reload drops the sign-ins the previous activation started', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const body = entryFunctions(['onUnload'], source)
  assert.match(body, /deviceLogins\.clear\(\)/,
    'the map is process state, and the poll that would read it outlives the reload')
})

/**
 * A reload rebuilds the WorkBuddy runtimes against the core it just made.
 *
 * Each shim closes over the pool and client it was created with. When a reload
 * arrived without the previous unload - the case `onLoad` handles explicitly -
 * the old shims kept serving from the old pool while `applySettingsToCore`,
 * `prefer`, `disable`, the credit reserves and `scan` all wrote to the new one:
 * the panel showed one account list and the gateway drew from another. This pins
 * the retirement, and that the Trae and Qoder directories are still left alone.
 */
test('a reload retires the runtimes bound to the core it replaced', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const stopped = []
  const context = vm.createContext({
    serviceStopped: false,
    loadGeneration: 1,
    refreshTimer: null,
    runtimes: new Map([['cn', { region: 'cn' }], ['global', { region: 'global' }]]),
    traeGateways: new Map([['cn', { source: 'trae', region: 'cn' }]]),
    qoderGateways: new Map(),
    pendingRuntimeStops: [],
    stopRuntime: async (runtime) => { stopped.push(runtime.region) },
    checkinAbort: { abort: () => {} },
    abortWarmups: () => {},
    stopAutoCheckin: () => {},
    stopAccountWatch: () => {},
    clearModelRetries: () => {},
    checkinScope: { enterWith: () => {} },
    checkinPassRunning: false,
    autoCheckinSlots: new Map(),
    growthPassRunning: false,
  })
  // Only the retirement itself: everything around it needs the host, and the
  // retirement is what this case is about.
  const body = entryFunctions(['onLoad'], source)
  const from = body.indexOf('for (const runtime of Array.from(runtimes.values()))')
  assert.notEqual(from, -1, 'the retirement must sit in the entry')
  const retirement = body.slice(from, body.indexOf('await adoptHostSettings()', from))
  assert.ok(retirement.length > 0, 'the retirement must sit before the core is rebuilt')
  // The globals it assigns are not declared in this snippet, so they are declared
  // here as the module would have them.
  vm.runInContext('var checkinAbort, checkinPassRunning, autoCheckinSlots, growthPassRunning;\n' + retirement, context)

  assert.deepEqual(stopped.sort(), ['cn', 'global'],
    'a runtime left over from the previous activation must be closed, not kept')
  assert.equal(context.runtimes.size, 0,
    'and dropped, so the declaration pass rebuilds it against this load\'s pool')
  assert.equal(context.traeGateways.size, 1,
    'the Trae directory is not a closure over the core: clearing it drops its provider row')
})

/**
 * A `connect` on a runtime the service already stopped writes nothing.
 *
 * The two post-await guards catch a stop that lands while the model fetch is in
 * flight. Nothing caught one that landed before the call began, so a stop
 * racing a scheduled refresh still cleared `lastError`, claimed a roster for a
 * runtime no map owns, and ran `applyEffectiveSelection` against it. The guard
 * at the entry is what makes the three below the only paths that write.
 */
test('a connect that begins after a stop writes no shared state', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  let poolReads = 0
  let selectionApplied = 0
  const context = vm.createContext({
    core: {
      pool: { list: () => { poolReads += 1; return [{ credential: {} }] } },
      client: { fetchModels: async () => [] },
    },
    applyEffectiveSelection: () => { selectionApplied += 1 },
    safeMessage: (error) => String(error),
    AbortSignal,
    MODELS_TIMEOUT_MS: 1000,
    catalogFresh: () => false,
  })
  vm.runInContext(entryFunctions(['connect'], source), context)
  const runtime = {
    stopped: true,
    region: 'cn',
    lastError: 'stale error',
    lastWarning: 'stale warning',
    signedIn: true,
    catalogFetchedAtMs: 123,
    catalog: {},
  }
  const answer = await context.connect(runtime, false)
  assert.equal(answer, false, 'a stopped runtime must be reported as not connected')
  assert.equal(poolReads, 0, 'the pool must not be read for a runtime that is gone')
  assert.equal(runtime.lastError, 'stale error', 'the guard must return before it clears the error')
  assert.equal(runtime.lastWarning, 'stale warning', 'and before it clears the warning')
  assert.equal(runtime.signedIn, true, 'and before it claims a sign-in for it')
  assert.equal(selectionApplied, 0, 'and no selection may be applied for it')
})


/**
 * A credit verdict on the REQUEST must not be read as one about the ACCOUNT.
 *
 * A 400 or 422 judges the body the client sent, and its answer routinely
 * quotes the quota it measured the request against. Matching the credit
 * markers there classed a malformed request as `hard_credit`, which rotated
 * the whole pool and answered 402 naming the wrong problem. Only a status
 * the upstream itself uses for "this account cannot pay" may be refined by
 * a credit marker.
 */
test('a request-side status is not refined into a whole-pool credit rotation', () => {
  const { classifyUpstreamError } = require('../lib/upstream')
  assert.equal(classifyUpstreamError(400, '积分不足'), 'client',
    'a 400 that quotes a quota is still a verdict on the request')
  assert.equal(classifyUpstreamError(422, 'insufficient credit'), 'client')
  assert.equal(classifyUpstreamError(500, '额度用尽'), 'server',
    'and so is a server error that quotes one')
  assert.equal(classifyUpstreamError(402, '积分不足'), 'hard_credit',
    'the status the upstream uses for a spent account still reads as one')
  assert.equal(classifyUpstreamError(403, '额度用尽'), 'hard_credit',
    'and so does a 403 that quotes the quota')
})

/**
 * The growth streak is lit by a chat report, and only by one that names the
 * account's uid.
 *
 * `uin` is a different identifier from `uid`, and the upstream answers 200
 * while dropping a report that carries the wrong one. Substituting it made
 * the whole streak chain a silent no-op, which is why the tiers never opened.
 */
test('the activity report refuses to substitute the uin for the uid', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const calls = []
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  } })
  await assert.rejects(
    () => client.reportChatActivity({ accessToken: 't', refreshToken: 'r', expiresAtMs: 0, uin: '900000000000', domain: 'www.workbuddy.cn', sourcePath: '' }, 'c1'),
    /uid/,
    'a credential with no uid must fail loudly rather than send the uin',
  )
  assert.equal(calls.length, 0, 'and no request may go out with the wrong id')
})

/**
 * A transport failure rotates; a caller hang-up does not.
 *
 * DNS, reset and TLS failures are the network path's, not the account's, and
 * answering them as `server` broke the rotation out with the healthy accounts
 * behind it untried. The caller hanging up is the client's own doing, and
 * must not spend a rotation or look like a network fault in the log.
 */
test('a transport failure rotates and a caller hang-up does not', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const hangUp = new AbortController()
  hangUp.abort()
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED') } })
  const failed = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', hangUp.signal,
  )
  assert.equal(failed.kind, 'aborted', 'a cancelled turn is the client doing')
  const open = new AbortController()
  const transport = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', open.signal,
  )
  assert.equal(transport.kind, 'transport',
    'a network failure must be classed so the shim tries the next sign-in')
})

/**
 * The upstream's own `Retry-After` reaches the pool.
 *
 * The body parser only covers the spellings it knows, so a 429 that states
 * its window in the standard header fell back to the configured cooldown:
 * the account came back into rotation while the limit was still standing and
 * the next request hit the same wall.
 */
test('an upstream Retry-After header reaches the pool', async () => {
  const { WorkBuddyUpstreamClient, retryAfterSeconds } = require('../lib/upstream')
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '90' })), 90)
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '0' })), undefined,
    'a zero is not a wait worth honouring')
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'soon' })), undefined)
  assert.equal(retryAfterSeconds(new Headers()), undefined)
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': String(99 * 60 * 60) })), 2 * 60 * 60,
    'an absurd header is bounded to the same ceiling the sender uses')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('quota', {
    status: 429, headers: { 'retry-after': '120' },
  }) })
  const limited = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', new AbortController().signal,
  )
  assert.equal(limited.kind, 'soft_rate')
  assert.equal(limited.retryAfter, 120, 'the header must ride along with the failure')
})

/**
 * A spent account is held, not put back at the head of the queue each minute.
 *
 * A 402 and a dead session do not clear by themselves, and the configured
 * cooldown window is sized for a limit that expires. Using it here returned
 * the spent account to rotation every minute, where it failed again and
 * burned the attempts of the healthy accounts behind it.
 */
test('a spent account is held out of rotation instead of returning each minute', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const SPENT_HOLD_MS = 6 * 60 * 60 * 1000
  const dir = scratch('spent-hold')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uid: 'u1', nickname: 'A' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60_000 })
  await pool.scan()
  const account = pool.list()[0]
  const before = Date.now()
  pool.penalize(account.id, before + SPENT_HOLD_MS, undefined, true)
  assert.ok(account.cooldownUntilMs - before > 60 * 60 * 1000,
    'the hold must far outlast the configured cooldown window')
  assert.deepEqual(pool.available(Date.now(), undefined, 'cn'), [],
    'and the account must be out of rotation for the whole of it')
})

/**
 * A rate-limit marker only reclassifies the 503 that states the limit.
 *
 * The upstream wraps a standing limit in a 503 with `soft_rate` in the body, and
 * reading that as a server outage answered the client with a 500 and left the
 * account in rotation until the client gave up. The same marker on any other
 * status is only a quotation: a 400 judges the request, a 404 is a route that
 * does not exist, a 500 is an outage. A quote is not a classification, and the
 * status the upstream chose still wins.
 */
test('a rate-limit marker only reclassifies the 503 that states the limit', () => {
  const { classifyUpstreamError } = require('../lib/upstream')
  assert.equal(classifyUpstreamError(503, '{"msg":"soft_rate"}'), 'soft_rate',
    'a 503 quoting the standing limit is the limit, so the account cools and the client is told to wait')
  assert.equal(classifyUpstreamError(400, 'rate limit exceeded, slow down'), 'client',
    'a 400 is a verdict on the request, and quoting a limit does not turn it into one')
  assert.equal(classifyUpstreamError(404, 'soft_rate'), 'not_found',
    'a 404 stays a missing route even when its body carries the limit marker')
  assert.equal(classifyUpstreamError(500, 'rate limit reached'), 'server',
    'and a 500 quoting a limit is still an upstream outage')
})

/**
 * Every reset-time spelling the upstream uses reads as one instant.
 *
 * The reset arrives as an epoch in milliseconds, the same epoch quoted as a
 * string, a seconds-level epoch, and a Beijing wall-clock sentence. A spelling
 * the parser missed fell back to the configured cooldown, so the account came
 * back into rotation while the limit was still standing. The wall-clock sentence
 * is Beijing time, eight hours ahead of UTC, and reading it as UTC parked the
 * account for the wrong eight hours.
 */
test('every reset-time spelling the upstream uses reads as one instant', () => {
  const { parseRateLimitReset } = require('../lib/upstream')
  // Thirty minutes out, so the cap never fires and the parsed value is the
  // instant the spelling named rather than the ceiling.
  const soonMs = Date.now() + 30 * 60000
  assert.equal(parseRateLimitReset(`{"resetAt": ${soonMs}}`), soonMs,
    'an epoch in milliseconds is read as the instant it names')
  assert.equal(parseRateLimitReset(`{"resetAt": "${soonMs}"}`), soonMs,
    'the same epoch quoted as a string is the same instant')
  const soonSec = Math.floor(soonMs / 1000)
  assert.equal(parseRateLimitReset(`{"resetAt": ${soonSec}}`), soonSec * 1000,
    'a seconds-level epoch is scaled up to the instant it names')
  const target = new Date(soonMs)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(target)
  const pick = (type) => parts.find((part) => part.type === type).value
  const sentence = `将在 ${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} 解除限制`
  const parsed = parseRateLimitReset(`{"msg":${JSON.stringify(sentence)}}`)
  assert.ok(typeof parsed === 'number' && Math.abs(parsed - soonMs) < 1000,
    'a Beijing wall-clock sentence is read as UTC+8, not as UTC')
})

/**
 * A sign-in the upstream just refused is demoted, not dropped, and for as long
 * as the upstream said.
 *
 * The source gateways re-read their credential list per request, and a refusal
 * used to leave no trace: the same sign-in led every request and paid the
 * failure again each time. The hold it now carries sorts it behind the healthy
 * ones, so a working account answers first, but it is still there when it is all
 * there is. The wait is the upstream's own figure, not the pool's default
 * cooldown, which is sized for a limit that expires on its own.
 */
test('a refused source sign-in is demoted behind the healthy ones, not dropped', () => {
  const pool = sourcePoolFor(60000)
  const labelOf = (credential) => credential.label
  const live = Date.now() + 3600000
  const credentials = [
    { label: 'held-acct', expiresAtMs: live },
    { label: 'healthy-acct', expiresAtMs: live },
  ]
  const before = Date.now()
  pool.noteSourceFailure('trae', 'cn', 'held-acct', '7200')
  const ordered = pool.orderSourceCredentials('trae', 'cn', credentials, labelOf, false)
  assert.deepEqual(ordered.map(labelOf), ['healthy-acct', 'held-acct'],
    'the refused sign-in must sort behind the healthy one, so the next request is not spent on the same failure')
  assert.equal(ordered.length, 2, 'and it must still be in the list, for when it is the only one left')

})

/**
 * A hold the upstream gave no wait for ends at the cooldown, not forever.
 *
 * The same hold, but the upstream named no wait: the only figure to fall back on
 * is the user's own cooldown setting, and a setting of zero means the hold is
 * already over. Reading it as a standing hold kept the sign-in demoted for good
 * and left a dead entry in the map the next load would inherit.
 */
test('a source hold with no stated wait ends at the cooldown', () => {
  const pool = sourcePoolFor(0)
  const labelOf = (credential) => credential.label
  const live = Date.now() + 3600000
  const credentials = [
    { label: 'held-acct', expiresAtMs: live },
    { label: 'healthy-acct', expiresAtMs: live },
  ]
  pool.noteSourceFailure('trae', 'cn', 'held-acct', undefined)
  const ordered = pool.orderSourceCredentials('trae', 'cn', credentials, labelOf, false)
  assert.deepEqual(ordered.map(labelOf), ['held-acct', 'healthy-acct'],
    'a hold whose cooldown is already past must not keep the sign-in demoted')
  assert.equal(pool.sourceFailureHold.size, 0,
    'and the lapsed entry must be dropped, or the next load inherits a hold on an account that is not there')
})

/**
 * The order a source region's sign-ins are tried in, which is the whole of
 * "which account serves this region".
 *
 * The gateways take the first usable entry and re-read this list per request, so
 * a wrong order is not a cosmetic problem: leading with an expired token spends
 * every request on a guaranteed 401 before rotation reaches a live one, and
 * leading with one the upstream just refused makes every request pay that
 * failure again. The expired-last rule had no test at all - forcing the rank's
 * expired term to zero left the whole suite green.
 */
function orderingPool(overrides = {}) {
  return require('../lib/source-pool').createSourcePool({
    cooldownMs: () => 60000,
    preferredSourceAccount: () => '',
    sourceDistribution: () => 'priority',
    sourceRegionKey: (source, region) => `${source}:${region}`,
    ...overrides,
  })
}

const sourceLabel = (credential) => credential.label

test('a live sign-in is tried before an expired one, whatever the list order', () => {
  const pool = orderingPool()
  const now = Date.now()
  const dead = { label: 'dead', expiresAtMs: now - 60000 }
  const live = { label: 'live', expiresAtMs: now + 3600000 }
  // Dead first in the input: the order is the pool's to decide, not the reader's.
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, live], sourceLabel, false).map(sourceLabel), ['live', 'dead'],
    'an expired sign-in must never lead, even when the discovery read lists it first')
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [live, dead], sourceLabel, false).map(sourceLabel), ['live', 'dead'],
    'and the same the other way round')
  // A sign-in with no expiry at all is live, not expired.
  const unknown = { label: 'unknown' }
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, unknown], sourceLabel, false).map(sourceLabel), ['unknown', 'dead'],
    'a sign-in that states no expiry is still usable')
  // An expiry of exactly now is dead: the comparison is `<=`.
  const edge = { label: 'edge', expiresAtMs: now }
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [edge, live], sourceLabel, false).map(sourceLabel), ['live', 'edge'],
    'an expiry equal to now has passed')
})

test('a sign-in the upstream just refused is tried after the healthy ones but before the expired', () => {
  const pool = orderingPool()
  const now = Date.now()
  const healthy = { label: 'healthy', expiresAtMs: now + 3600000 }
  const held = { label: 'held', expiresAtMs: now + 3600000 }
  const dead = { label: 'dead', expiresAtMs: now - 60000 }
  pool.noteSourceFailure('trae', 'cn', 'held', undefined)
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, held, healthy], sourceLabel, false).map(sourceLabel),
    ['healthy', 'held', 'dead'],
    'healthy first, then the refused one, then the expired one')
  // With nothing healthy left it still answers: the request falls back to it.
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, held], sourceLabel, false).map(sourceLabel),
    ['held', 'dead'],
    'a held sign-in is still used when it is all there is')
})

/**
 * A hold belongs to one region's sign-in, not to its name.
 *
 * The scanner keys its rows by label *and* region because one Trae account keeps
 * a copy in each region (and two different accounts can share a numeral). Keying
 * the hold by the label alone handed a 429 in one region to the other region's
 * copy, which then sorted behind a healthy account it had never failed against.
 */
test('a hold in one region does not reach the same name in the other', () => {
  const pool = orderingPool()
  const now = Date.now()
  const cnCopy = { label: 'same-name', expiresAtMs: now + 3600000 }
  const aiCopy = { label: 'same-name', expiresAtMs: now + 3600000 }
  const aiHealthy = { label: 'other', expiresAtMs: now + 3600000 }
  pool.noteSourceFailure('trae', 'cn', 'same-name', '7200')
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [cnCopy, aiHealthy], sourceLabel, false).map(sourceLabel),
    ['other', 'same-name'],
    'the refused copy in this region sorts behind the healthy one')
  assert.deepEqual(pool.orderSourceCredentials('trae', 'ai', [aiCopy, aiHealthy], sourceLabel, false).map(sourceLabel),
    ['same-name', 'other'],
    "the other region's copy of that name never failed, so it leads")
})

test('the picked account leads in every mode, and a retired pick does not', () => {
  const now = Date.now()
  const a = { label: 'a', expiresAtMs: now + 3600000 }
  const b = { label: 'b', expiresAtMs: now + 3600000 }
  for (const distribution of ['priority', 'round-robin', 'expiry']) {
    const pool = orderingPool({ preferredSourceAccount: () => 'b', sourceDistribution: () => distribution })
    assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, false).map(sourceLabel), ['b', 'a'],
      `the picked account leads under ${distribution} too`)
  }
  // A label no credential still carries is not a preference: renaming or
  // re-signing in retires it, and honouring it returned it before the expiry
  // sort could run, so the panel showed round-robin while one account served
  // every chat. The observable damage is that a truthy `preferred` also switches
  // rotation off, so a retired pick freezes the pool on one account.
  const retired = orderingPool({ preferredSourceAccount: () => 'gone' })
  assert.deepEqual(retired.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, false).map(sourceLabel), ['a', 'b'],
    'a pick naming an account that is no longer there does not lead')
  const spinning = orderingPool({ preferredSourceAccount: () => 'gone', sourceDistribution: () => 'round-robin' })
  const turns = []
  for (let turn = 0; turn < 3; turn += 1) {
    turns.push(spinning.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, true).map(sourceLabel).join(','))
  }
  assert.deepEqual(turns, ['a,b', 'b,a', 'a,b'],
    'a retired pick must not switch rotation off, or one account serves every chat')
})

test('the expiry mode spends the soonest-expiring pack first, and never an expired one', () => {
  const pool = orderingPool({ sourceDistribution: () => 'expiry' })
  const now = Date.now()
  // The urgency comes from the recorded credit pack, not from the token expiry:
  // a one-off pack has to be spent before it lapses, and a monthly pack can
  // wait. `packUrgency` returns Infinity for a sign-in with nothing recorded, so
  // both of these carry a pack.
  pool.sourceCreditExpiry.set(pool.accountStateKey('trae', 'cn', 'soon'), now + 3600000)
  pool.sourceCreditExpiry.set(pool.accountStateKey('trae', 'cn', 'later'), now + 86400000)
  const soon = { label: 'soon', expiresAtMs: now + 7 * 86400000 }
  const later = { label: 'later', expiresAtMs: now + 3600000 }
  const dead = { label: 'dead', expiresAtMs: now - 60000 }
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [later, soon, dead], sourceLabel, false).map(sourceLabel),
    ['soon', 'later', 'dead'],
    'the pack that expires soonest is spent first, so a one-off pack is not wasted - and the token expiry says the opposite, which is the point')
  // An expired sign-in is last even when its pack is the most urgent.
  pool.sourceCreditExpiry.set(pool.accountStateKey('trae', 'cn', 'dead'), now + 60000)
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [later, soon, dead], sourceLabel, false).map(sourceLabel),
    ['soon', 'later', 'dead'],
    'an expired sign-in is never spent first however urgent its pack is')
})

test('round-robin rotates only among the sign-ins that can still answer', () => {
  const pool = orderingPool({ sourceDistribution: () => 'round-robin' })
  const now = Date.now()
  const a = { label: 'a', expiresAtMs: now + 3600000 }
  const b = { label: 'b', expiresAtMs: now + 3600000 }
  const dead = { label: 'dead', expiresAtMs: now - 60000 }
  const seen = []
  for (let turn = 0; turn < 4; turn += 1) {
    seen.push(pool.orderSourceCredentials('trae', 'cn', [a, b, dead], sourceLabel, true).map(sourceLabel).join(','))
  }
  assert.deepEqual(seen, ['a,b,dead', 'b,a,dead', 'a,b,dead', 'b,a,dead'],
    'the cursor walks the live accounts one per chat and leaves the expired one last')
  // A read that is not a chat must not advance the cursor: it would make the
  // account a chat lands on depend on whichever read ran last. An odd number of
  // non-rotating reads is what makes the difference observable - an even number
  // lands back on the same step either way.
  const first = pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, true).map(sourceLabel).join(',')
  for (let read = 0; read < 3; read += 1) pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, false)
  const second = pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, true).map(sourceLabel).join(',')
  assert.notEqual(first, second, 'two rotating calls with nothing in between give two different orders')
  assert.equal(second, first === 'a,b' ? 'b,a' : 'a,b',
    'a model-list or health read must not consume a rotation step')
  // With one live account there is nothing to rotate.
  const single = orderingPool({ sourceDistribution: () => 'round-robin' })
  assert.deepEqual(single.orderSourceCredentials('trae', 'cn', [dead, a], sourceLabel, true).map(sourceLabel), ['a', 'dead'],
    'a single live account leads and rotation is a no-op')
})

/**
 * "Clear all cooldowns" clears the source holds too.
 *
 * A pool cooldown and a source hold are the same refusal from the user's side:
 * one account cooling and one whole upstream cooling. The button used to clear
 * only the pool's, so it reported success while the source gateway kept failing
 * on the sign-in the hold still covered.
 */
test('clearing all cooldowns clears the source holds as well', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const marker = 'case "xd.resetCooldowns":'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'the panel must answer the reset-cooldowns channel')
  const bodyStart = start + marker.length
  const bodyEnd = source.indexOf('case "xd.checkin"', bodyStart)
  assert.notEqual(bodyEnd, -1, 'the reset-cooldowns case must be followed by the next one')
  let reset = false
  const sourceFailureHold = new Map([['trae\nheld-acct', Date.now() + 3600000]])
  const context = vm.createContext({
    core: { pool: { resetCooldowns: () => { reset = true } } },
    sourceFailureHold,
    statusDocument: async () => ({ accounts: [] }),
  })
  // The case body is the panel channel's own statements, lifted whole rather
  // than re-typed, so the wiring under test is the shipped one.
  vm.runInContext('async function resetCooldownsChannel() {' + source.slice(bodyStart, bodyEnd) + '}', context)
  await context.resetCooldownsChannel()
  assert.equal(reset, true, 'the pool cooldowns must still be cleared')
  assert.equal(sourceFailureHold.size, 0,
    'and so must the source holds, or the button reports success while the gateway keeps failing')
})

/**
 * A switched-off account does not hold the panel's polling open.
 *
 * A disabled account is never probed, so it can never have a cache entry, and
 * counting it as stale kept every state call reporting a detection pass in
 * progress for a row that will never probe. The panel polled forever for a row
 * the user had switched off.
 */
test('a switched-off account does not hold the panel polling open', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const context = vm.createContext({
    Date,
    PROBE_TTL_MS: 60000,
    probeCache: new Map(),
    regionOf: () => 'cn',
    regionEnabled: () => true,
    core: { pool: {
      list: () => [{ id: 'off-acct', cooldownUntilMs: 0, credential: { domain: 'codebuddy.cn' } }],
      isDisabled: () => true,
    } },
  })
  vm.runInContext(entryFunctions(['probesStale'], source), context)
  assert.equal(context.probesStale(), false,
    'an account the pool will never probe must not read as one whose answers are still missing')
})

/**
 * A probe pass drops the accounts that have left the pool.
 *
 * The probe cache is keyed by account id and only ever grows: without a prune,
 * an account whose sign-in was removed keeps its entry and every stale check
 * walks the dead entries alongside the live ones. The prune runs when the cache
 * holds more than the pool does, which is the one moment a departed id is
 * provably in there.
 */
test('a probe pass drops the cache entries of accounts that left the pool', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const probeCache = new Map()
  const list = () => [{ id: 'live-acct', credential: {} }]
  const context = vm.createContext({
    Date,
    // No freshness window, so a second probe of the same account reaches the
    // prune rather than answering from the cache the first one just wrote.
    PROBE_TTL_MS: 0,
    probeCache,
    safeMessage: (error) => String(error?.message ?? error),
    core: {
      client: {
        fetchCredits: async () => ({ total: 100, packages: [] }),
        fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: false, streakDays: 0 }),
      },
      pool: { list, setCreditBalance: () => {} },
    },
  })
  vm.runInContext(entryFunctions(['accountProbe'], source), context)
  await context.accountProbe({ id: 'live-acct', credential: {} }, true)
  assert.equal(probeCache.has('live-acct'), true, 'the live account must be cached by its probe')
  // A departed id, so the cache now holds more than the pool lists.
  probeCache.set('gone-acct', { atMs: Date.now(), value: {} })
  assert.ok(probeCache.size > list().length, 'the fixture must put a dead id in ahead of the prune')
  await context.accountProbe({ id: 'live-acct', credential: {} }, true)
  assert.equal(probeCache.has('gone-acct'), false,
    'an account that left the pool must not keep a cache entry the stale checks walk')
  assert.equal(probeCache.has('live-acct'), true, 'and the live one must survive the prune')
})

/**
 * A declaration that says the same thing is not rewritten.
 *
 * `manifest.json` was compared byte for byte, so a document whose provider keys
 * sat in a different order - written by an earlier version, or reformatted by
 * any external tool - read as changed and was rewritten on every pass. The panel
 * footer then claimed the model list had just updated, forever. Comparing the
 * canonical form compares what the declaration says, not how it is spelled.
 */
test('a declaration that already says the same thing is not rewritten', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const temporary = scratch('xdpool-decl-test-')
  const manifestPath = path.join(temporary, 'manifest.json')
  // The same provider as the descriptors below, with its keys in another order.
  // `alias` is what the host's chip prints, so a declaration carries it beside the
  // name; the comparison is about key order, not about which fields exist.
  const onDisk = {
    contributes: {
      providers: [{
        models: [{ name: 'Fixture', id: 'fixture-model', alias: 'Fixture' }],
        baseUrl: 'http://127.0.0.1:41831/v1',
        id: 'xdpool-cn',
      }],
    },
  }
  fs.writeFileSync(manifestPath, JSON.stringify(onDisk, null, 2) + '\n')
  const before = fs.readFileSync(manifestPath)
  const context = vm.createContext({
    path, fs,
    packageRoot: temporary,
    manifestCache: undefined,
    errorCodeOf: () => 'unknown',
    // Nothing here is one of this plugin's pools, so the labels are published
    // exactly as given and the case stays about the canonical comparison.
    PROVIDER_ID_BY_REGION: {}, TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: {},
    REGIONS: [], TRAE_REGIONS: [], QODER_REGIONS: [],
  })
  vm.runInContext(entryFunctions([
    'canonicalJson', 'writeDeclaration', 'disambiguateModelLabels', 'stripModelTag', 'modelTag', 'routeOfProviderId',
  ], source), context)
  const descriptors = [{ id: 'xdpool-cn', baseUrl: 'http://127.0.0.1:41831/v1', models: [{ id: 'fixture-model', name: 'Fixture' }] }]
  const result = context.writeDeclaration(descriptors)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, changed: false, providerCount: 1 },
    'a manifest that already carries the same provider must read as unchanged')
  assert.equal(before.equals(fs.readFileSync(manifestPath)), true,
    'and it must not be rewritten, or the footer claims an update that did not happen')
  // The control: a genuinely different declaration still writes, or the case
  // above would pass for a writer that never writes at all.
  const changed = context.writeDeclaration([{ id: 'xdpool-cn', baseUrl: 'http://127.0.0.1:41831/v1', models: [{ id: 'other-model', name: 'Other' }] }])
  assert.equal(changed.changed, true, 'a different model list is a real change and must be written')
  assert.equal(before.equals(fs.readFileSync(manifestPath)), false, 'and the file on disk must reflect it')
  fs.rmSync(temporary, { recursive: true, force: true })
})

/**
 * The region tagging pass is idempotent, so a pass over its own output writes
 * nothing.
 *
 * Two halves of one declaration are built differently: the rosters this run read
 * carry plain names, while the rows retained for a warming gateway already carry
 * the tag from the previous write. Counting those two as they are makes the
 * same declaration read as changed - the CN row loses its suffix while a sibling
 * warms, then gets it back afterwards - and each flip is a manifest rewrite plus
 * a window in which the composer chip names nothing.
 */
test('a declaration written over its own output is unchanged', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const context = vm.createContext({
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn', global: 'xdpool-global' },
    TRAE_PROVIDER_ID_BY_REGION: { cn: 'xdpool-trae-cn', ai: 'xdpool-trae-ai' },
    QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn', global: 'xdpool-qoder-global' },
    REGIONS: ['cn', 'global'], TRAE_REGIONS: ['cn', 'ai'], QODER_REGIONS: ['cn', 'global'],
  })
  vm.runInContext(entryFunctions([
    'disambiguateModelLabels', 'stripModelTag', 'modelTag', 'routeOfProviderId',
  ], source), context)
  const roster = (name) => [{ id: 'm', name }]
  const first = context.disambiguateModelLabels([
    { id: 'xdpool-cn', models: roster('Shared \u00b7 x0.29') },
    { id: 'xdpool-global', models: roster('Shared \u00b7 x0.29') },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(first.map((provider) => provider.models[0].name))),
    ['Shared \u00b7 x0.29 (CN)', 'Shared \u00b7 x0.29 (Global)'],
    'both spellings of a shared name carry their region')

  // The next pass is handed one read roster and one retained row, which is what
  // `syncDeclaration` builds while a sibling gateway is still warming.
  const second = context.disambiguateModelLabels([
    { id: 'xdpool-cn', models: roster('Shared \u00b7 x0.29') },
    { id: 'xdpool-global', models: roster('Shared \u00b7 x0.29 (Global)') },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(second.map((provider) => provider.models[0].name))),
    ['Shared \u00b7 x0.29 (CN)', 'Shared \u00b7 x0.29 (Global)'],
    'the retained row keeps its tag and the fresh one regains it, so the output equals the first pass')

  // A name that merely ends in parentheses is not a tag and has to survive.
  const plain = context.disambiguateModelLabels([{ id: 'xdpool-cn', models: roster('Model (beta)') }])
  assert.equal(plain[0].models[0].name, 'Model (beta)', 'a name that ends in parentheses keeps it')
})

/**
 * The manifest is read once, not once per lookup.
 *
 * The declaration is consulted by several callers on one pass, and each used to
 * re-read `manifest.json` off the disk - on a file this plugin had itself just
 * rewritten, so a read could land mid-rewrite. The parsed copy is kept and reused
 * until a write changes it.
 */
test('the manifest is read once and reused across lookups', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  let reads = 0
  const context = vm.createContext({
    path,
    packageRoot: '/fixture/package',
    fs: { readFileSync: () => { reads += 1; return JSON.stringify({ contributes: { providers: [{ id: 'xdpool-cn' }] } }) } },
  })
  vm.runInContext([
    entryDeclaration(/^let manifestCache;$/m, source),
    entryFunctions(['readManifest', 'manifestProviders'], source),
  ].join('\n'), context)
  const first = context.manifestProviders()
  const second = context.manifestProviders()
  assert.equal(reads, 1, 'the manifest must be read off the disk once, not once per lookup')
  assert.deepEqual(JSON.parse(JSON.stringify(second)), [{ id: 'xdpool-cn' }],
    'and every lookup must be answered from the same parsed copy')
})

/**
 * With the feature off, the readout is told to stop, not to keep waiting.
 *
 * `show: false` alone is indistinguishable from another plugin's model, which is
 * a wait: the readout would keep polling for a balance that will never come. The
 * `enabled: false` the answer carries when the feature is switched off is what
 * tells it to stop for good.
 */
test('composer points tell the readout to stop when the feature is off', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const context = vm.createContext({
    settings: { showComposerPoints: false },
    activeRegions: () => [],
    declarationModels: () => [],
    activeTraeRegions: () => [],
    traeDeclarationModels: () => [],
    activeQoderRegions: () => [],
    qoderDeclarationModels: () => [],
    // The label a chip carries is resolved against what the host was given, and
    // nothing has been published here.
    manifestProviders: () => [],
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn', global: 'xdpool-global' },
    TRAE_PROVIDER_ID_BY_REGION: { cn: 'xdpool-trae-cn', ai: 'xdpool-trae-ai' },
    QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn', global: 'xdpool-qoder-global' },
    REGIONS: ['cn', 'global'],
    TRAE_REGIONS: ['cn', 'ai'],
    QODER_REGIONS: ['cn', 'global'],
    runtimes: new Map(),
    traeGateways: new Map(),
    qoderGateways: new Map(),
  })
  vm.runInContext(entryFunctions([
    'composerPointsEnabled', 'composerPoints', 'matchComposerModel', 'composerChipTextOf',
    'composerModels', 'composerChipText', 'composerChipTexts', 'routeOfProviderId',
  ], source), context)
  const off = context.composerPoints({ chip: 'anything' })
  assert.deepEqual(JSON.parse(JSON.stringify(off)), { show: false, ours: false, enabled: false },
    'a switched-off feature must answer enabled false, so the readout stops rather than waits')

  context.settings.showComposerPoints = true
  const noMatch = context.composerPoints({ chip: 'some other plugin model' })
  assert.equal(noMatch.enabled, true, 'with the feature on, the readout keeps polling')
  assert.equal(noMatch.show, false, 'but a model that is not ours shows nothing')
})

/**
 * A forced refresh does not free the slot the background pass is still using.
 *
 * The click runs its own pass so it answers with figures it fetched itself, but
 * releasing the slot when ITS work ended left the background pass running with
 * nothing marking the slot as taken. A panel open or a settings change landing
 * in that window started a third pass beside it: the two reconciled the same
 * gateways, both wrote the declaration, and every account was probed twice.
 */
test('a forced refresh holds the pass slot until the background pass has finished', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  let release;
  const gate = new Promise((resolve) => { release = resolve });
  let documents = 0;
  const context = vm.createContext({
    setTimeout, clearTimeout, setInterval, clearInterval,
    serviceStopped: false,
    loadGeneration: 1,
    refreshInflight: null,
    refreshTimer: null,
    REFRESH_PASS_BUDGET_MS: 18000,
    // Stands in for the handover budget. Shrunk so the test
    // does not spend two seconds waiting for a handover that no longer exists:
    // what matters is that the click's slot outlives it.
    REFRESH_HANDOVER_MS: 25,
    activeRegions: () => [],
    runtimes: new Map(), traeGateways: new Map(), qoderGateways: new Map(),
    poolNeedsScan: false, pendingRuntimeStops: [],
    stillLoaded: () => true,
    stalePass: () => ({ stale: true }),
    adoptHostSettings: async () => {},
    applySettingsToCore: () => {},
    reconcileTraeGateways: async () => {},
    reconcileQoderGateways: async () => {},
    refreshSourceAccounts: async () => {},
    warmSourceDirectory: async () => {},
    refreshRuntime: async () => ({ ok: true }),
    syncDeclaration: () => {},
    settleWithin: (work, budgetMs) => {
      // The race is what makes a bounded handover time out, so the timer has to
      // be real; it is cleared the moment the race settles, or the test file
      // would hold the event loop open for the length of a pass budget.
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      return Promise.race([Promise.resolve(work), timeout])
        .finally(() => clearTimeout(timer));
    },
    // The first pass to reach its document stops there, which is the state a slow
    // background pass is in when a Refresh click lands on top of it.
    statusDocument: async () => {
      documents += 1;
      return documents === 1 ? gate : { pass: documents };
    },
  })
  vm.runInContext(entryFunctions(['refreshAll'], source), context)
  const slot = () => vm.runInContext('refreshInflight', context)

  const background = context.refreshAll('panel', false)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.notEqual(slot(), null, 'the background pass holds the slot while it runs')

  const forced = context.refreshAll('click', true)
  // Past the handover window: releasing the slot when the
  // click's own work ended happened inside that window, which is exactly what
  // let a third caller start a pass beside the background one.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.notEqual(slot(), null,
    'the forced pass must not free the slot while the background pass is still running')

  release({ pass: 0 })
  assert.deepEqual(JSON.parse(JSON.stringify(await forced)), { pass: 2 },
    'the click still ran a pass of its own rather than answering with the background figures')
  assert.deepEqual(JSON.parse(JSON.stringify(await background)), { pass: 0 },
    'the background pass answers with the document it fetched')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(slot(), null, 'the slot is freed once both passes have finished')
})

/**
 * A field sealed under the at-rest key opens, and one sealed under another does
 * not.
 *
 * The envelope is built here rather than mocked, because the layout is the
 * contract: the AAD names the suite and the key id, which is what makes a field
 * sealed under a rotated key refuse by name instead of decrypting into garbage,
 * and what makes an edited ciphertext fail the tag instead of yielding a token
 * nobody issued. Nothing here asks the installed app for its key, so the case
 * runs on a machine with no WorkBuddy install at all.
 */
test('a WorkBuddy field sealed under the at-rest key opens, and one sealed under another does not', () => {
  const { createCipheriv, createHash } = require('node:crypto')
  const { openEncryptedField } = require('../lib/at-rest')
  // The key is the one the app hands over, so the derivation is lifted out of
  // the shipped module rather than re-typed: a payload the build stops reading
  // as a key then fails here instead of reading as a field nobody can open.
  const atRest = fs.readFileSync(path.join(root, 'lib/at-rest.js'), 'utf8')
  const derived = vm.createContext({ import_node_crypto: require('node:crypto') })
  vm.runInContext(entryFunctions(['deriveAtRestKey', 'deriveAtRestKeyId'], atRest), derived)
  const uint32 = (value) => {
    const bytes = Buffer.allocUnsafe(4)
    bytes.writeUInt32BE(value)
    return bytes
  }
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([uint32(bytes.length), bytes])
  }
  // The AAD the opener binds, spelled out so a change to the layout on either
  // side of the wire fails this case rather than reading as an unavailable key.
  const fieldAad = (keyId, suite) => Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    uint32(suite),
    lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ])
  const seal = (key, plaintext) => {
    const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
    const nonce = Buffer.alloc(12, 9)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(fieldAad(keyId, 1))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({
      suite: 1,
      keyId,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    })).toString('base64') }
  }
  const key = derived.deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'fixture at-rest secret' }))
  const keyId = derived.deriveAtRestKeyId(key)
  assert.equal(keyId, createHash('sha256').update(key).digest('hex').slice(0, 16),
    'the envelope names its key by the first 16 hex of its sha256, which is the name a reader matches on')
  const field = seal(key, 'fixture-access-token')
  assert.equal(openEncryptedField(field, key), 'fixture-access-token',
    'a field sealed under the key the app derived must open to the token it holds')
  // The app re-derives its at-rest key when it is reinstalled or upgraded, and
  // the field names the key it was sealed with: the refusal has to say which key
  // is missing, because that name is the signal the reader drops its cache on. An
  // auth failure instead reads as a foreign field and keeps the old key.
  const rotated = derived.deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'a later at-rest secret' }))
  assert.throws(() => openEncryptedField(field, rotated), /belongs to key/,
    'a field sealed under a key this process does not hold must be refused by key id')
  const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  const edited = Buffer.from(record.ciphertext, 'base64')
  edited[0] ^= 0xff
  assert.throws(() => openEncryptedField({
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({ ...record, ciphertext: edited.toString('base64') })).toString('base64'),
  }, key), /authenticate/i, 'an edited ciphertext must fail the tag, not decrypt to a token nobody issued')
})

/**
 * The signature scan is handed a module path its own edition can load.
 *
 * `powershell` is Windows PowerShell 5.1, and it binds
 * `Microsoft.PowerShell.Security` by walking `PSModulePath` in order. Any machine
 * with a Store-installed PowerShell 7 carries that build's Modules directory
 * ahead of the system one, because the Store install prepends it to the variable
 * the desktop host inherited. 5.1 then binds the 7 build's copy of the module, the
 * import dies on a type-data conflict, and `Get-AuthenticodeSignature` throws for
 * every candidate. The scan's own catch swallows that, the policy function is
 * handed an empty status, and the at-rest key reads as "no WorkBuddy executable
 * found" on a machine holding two signed installs - which is what it read as
 * here, until the scan was given a path of its own.
 *
 * The scan is driven with a stubbed `execFileSync` rather than a real PowerShell,
 * so the case proves the environment is handed over at all: dropping the option
 * fails it just as surely as getting the order wrong. It also runs on a machine
 * with no registry to plant an uninstall key in.
 */
test('the signature scan is handed a module path 5.1 can load', () => {
  const atRestSource = fs.readFileSync(path.join(root, 'lib/at-rest.js'), 'utf8')
  const spawns = []
  const context = vm.createContext({
    // esbuild's namespace import, the same shape the crypto case below stubs.
    import_node_child_process: { execFileSync: (file, args, options) => { spawns.push({ file, args, options }); return '' } },
    signatureScanEnv: require('../lib/at-rest').signatureScanEnv,
    scanInterpreter: require('../lib/at-rest').scanInterpreter,
    import_node_path: require('node:path'),
    process,
  })
  vm.runInContext(entryFunctions(['cleanIconPath', 'systemRootOf', 'scanInterpreter', 'readRegistryAppPaths'], atRestSource), context)
  vm.runInContext('readRegistryAppPaths()', context)
  assert.equal(spawns.length, 1, 'the scan runs exactly once')
  // By absolute path, not by bare name: a user-writable directory is on the
  // default PATH, and the scan exists precisely because a user-level process can
  // plant what it runs.
  assert.ok(path.isAbsolute(spawns[0].file), 'the interpreter is pinned, not looked up on PATH')
  assert.match(spawns[0].file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i)

  const handed = spawns[0].options.env
  assert.notEqual(handed, undefined, 'the child must be handed an environment of our own, not the ambient one')
  const systemRoot = process.env['SystemRoot']
  if (systemRoot !== undefined && systemRoot !== '') {
    const modules = path.join(systemRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules')
    assert.equal(handed.PSModulePath.split(';')[0], modules,
      'the 5.1 modules directory leads the path the child is given, so it binds its own edition of the module')
  }
  // The ordering property itself, stated against a path shaped like the one that
  // broke it, so the case holds on a machine whose own path is already clean.
  const store = path.join('C:\\Program Files', 'WindowsApps', 'microsoft.powershell_7.6.7.0_x64__8wekyb3d8bbwe', 'Modules')
  const ambient = [
    path.join('C:\\Users\\fixture', 'Documents', 'PowerShell', 'Modules'),
    path.join('C:\\Program Files', 'PowerShell', 'Modules'),
    store,
    path.join('C:\\Program Files', 'WindowsPowerShell', 'Modules'),
    path.join('C:\\Windows', 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  ].join(';')
  const { signatureScanEnv } = require('../lib/at-rest')
  const built = signatureScanEnv({ SystemRoot: 'C:\\Windows', PSModulePath: ambient, PATH: 'unchanged' })
  const order = built.PSModulePath.split(';')
  assert.ok(order.indexOf(path.join('C:\\Windows', 'system32', 'WindowsPowerShell', 'v1.0', 'Modules')) < order.indexOf(store),
    'the system modules directory precedes the Store PowerShell 7 one, which is the whole fix')
  assert.equal(order.length, ambient.split(';').length + 1,
    'nothing is dropped: a user\'s own modules still resolve behind the system one')
  assert.equal(built.PATH, 'unchanged', 'the rest of the environment is passed through untouched')
  assert.equal(signatureScanEnv(built).PSModulePath, built.PSModulePath,
    'building it twice is a no-op, so the path cannot grow on every scan')
  assert.equal(signatureScanEnv({ PATH: 'unchanged' }).PATH, 'unchanged',
    'with no SystemRoot to derive from the environment is left as it is rather than given an invented path')
})

/**
 * A credential whose refresh token has expired still reaches the pool.
 *
 * The two tokens expire on their own clocks, and the access token routinely has
 * hours left when the refresh one is spent. Reading the whole document as
 * unreadable then took the account out of the pool for that window, and the
 * panel reported "no WorkBuddy sign-in found" over a token that was still
 * serving. Blanking the refresh token lands the request path in the no-refresh
 * branch instead, which warns once and keeps serving.
 */
test('a credential whose refresh token has expired still reaches the pool', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const temporary = scratch('xdpool-refresh-spent-')
  const spentDir = path.join(temporary, 'spent')
  const liveDir = path.join(temporary, 'live')
  const future = Date.now() + 3600000
  const past = Date.now() - 3600000
  const signIn = (dir, refreshExpiresAt) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'refresh-user.info'), JSON.stringify({
      auth: {
        accessToken: 'live-token', refreshToken: 'refresh-me', expiresAt: future,
        refreshExpiresAt, domain: 'codebuddy.cn',
      },
      account: { uin: 'refresh-user', nickname: 'refresh-user' },
    }))
  }
  const spentPool = new WorkBuddyAccountPool({ authDirs: [spentDir] })
  const livePool = new WorkBuddyAccountPool({ authDirs: [liveDir] })
  try {
    signIn(spentDir, past)
    assert.equal((await spentPool.scan()).length, 1,
      'a sign-in whose refresh token is spent must still be listed, not discarded whole')
    const spent = spentPool.list()[0].credential
    assert.equal(spent.accessToken, 'live-token',
      'the access token beside a spent refresh token is still a usable sign-in')
    assert.equal(spent.refreshToken, '',
      'a refresh token past its own expiry renews nothing, so it must not be carried')
    assert.equal(spent.refreshExpiresAtMs, undefined,
      'and the expiry that disqualified it must not be published either')
    // The control: the same file with time left on the refresh token keeps it.
    signIn(liveDir, future)
    assert.equal((await livePool.scan()).length, 1, 'the control must list the same sign-in')
    const live = livePool.list()[0].credential
    assert.equal(live.accessToken, 'live-token', 'the control must read the same access token')
    assert.equal(live.refreshToken, 'refresh-me', 'a refresh token with time left is still carried')
    assert.equal(live.refreshExpiresAtMs, future, 'and so is the expiry it carries')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * The upstream's own default effort reaches the model row it belongs to.
 *
 * `defaultEffort` is the level the upstream opens a new session on, and dropping
 * it published the plugin's own fallback instead: a model that starts at `high`
 * opened at the lowest offered level, and the first turn of every session was
 * answered at the wrong depth. A model that declares no default must carry no
 * field at all, or the host would publish a level the upstream never named.
 */
test('the upstream default effort reaches the model row it belongs to', () => {
  const { toModelInfo, catalogFromUpstream, FALLBACK_WORKBUDDY_MODELS } = require('../lib/catalog')
  const declared = toModelInfo({
    id: 'fixture-model', name: 'Fixture', contextWindow: 200000, maxTokens: 32000,
    reasoning: { supportedEfforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'high' },
  })
  assert.equal(declared.defaultThinkingLevel, 'high',
    'a model that opens at a non-minimum level must publish that level, not the plugin fallback')
  assert.deepEqual(declared.supportedEfforts, ['minimal', 'low', 'medium', 'high'],
    'the offered levels must survive the mapping alongside the default')
  const bare = toModelInfo({ id: 'bare-model', name: 'Bare', contextWindow: 200000, maxTokens: 32000 })
  assert.equal('defaultThinkingLevel' in bare, false,
    'a model that declares no default must carry no field, or the host invents a level upstream never named')
  assert.deepEqual(catalogFromUpstream([{
    id: 'fixture-model', name: 'Fixture', contextWindow: 200000, maxTokens: 32000,
    reasoning: { defaultEffort: 'high' },
  }]).map((row) => row.defaultThinkingLevel), ['high'],
    'the live list is mapped through the same function, so the default reaches the picker either way')
  // A read that failed is not the upstream saying it has no models, and the
  // fallback is what a fresh install serves, so an empty list must keep it.
  assert.equal(catalogFromUpstream([]), FALLBACK_WORKBUDDY_MODELS,
    'an empty live list must keep the static fallback rather than publish an empty picker')
})

/**
 * A refusal is answered in the class the upstream actually used.
 *
 * All four classifiers are pure and each one decides the status the client is
 * answered with, so a class read one band off turns a rate limit into a client
 * error the client never retries, or an upstream outage into the caller's own
 * mistake. Trae reports its outages inside the stream on the same `event: error`
 * frame a bad request uses, so the leading digit of its code is the class; Qoder
 * spells its own as strings and delivers a spent allowance together with queue
 * markers, so the daily check has to run before the queue one.
 */
test('a Trae or Qoder refusal is answered in the class the upstream used', () => {
  const { classifyTraeUpstreamError } = require('../lib/trae-upstream')
  const { classifyQoderUpstreamError } = require('../lib/qoder-client')
  const { classifyTraeFailure } = require('../lib/trae-shim')
  const { classifyQoderFailure, QoderQueueRejection, QoderDailyLimitRejection, QoderSignInExpiredError } = require('../lib/qoder-shim')

  const byStatus = [
    [401, 'authentication'],
    [403, 'authentication'],
    [402, 'hard_credit'],
    [429, 'soft_rate'],
    [404, 'not_found'],
    [500, 'server'],
    [503, 'server'],
    [400, 'client'],
    [422, 'client'],
  ]
  for (const classify of [classifyTraeUpstreamError, classifyQoderUpstreamError]) {
    for (const [status, kind] of byStatus) {
      assert.equal(classify(status), kind, `${classify.name}(${status}) must read as ${kind}`)
    }
  }

  // The subscription gate is the one code answered 402 outright: 402 is what
  // makes a client stop rather than retry, and it is truthful.
  assert.deepEqual(classifyTraeFailure({ code: 1005, message: 'subscription gate' }),
    { status: 402, kind: 'hard_credit' }, 'the Trae subscription gate is a 402, not a client error')
  // A queue frame names its own wait inside its message as a JSON document.
  const queued = classifyTraeFailure({ code: 4001, message: JSON.stringify({ retryAfterSeconds: 45 }) })
  assert.equal(queued.status, 429, 'a queued Trae account is a rate limit, which rotates')
  assert.equal(queued.kind, 'soft_rate')
  assert.equal(queued.retryAfterSeconds, 45, 'and the wait the frame named must reach the client')
  // Trae's own codes are >= 4000 on the wire, so the leading digit is the class:
  // a 5xxx is upstream's fault and a 4xxx is the caller's, and the 429x band is
  // a limit rather than a malformed request.
  assert.deepEqual(classifyTraeFailure({ code: 5001, message: 'upstream is down' }),
    { status: 502, kind: 'server' }, 'a 5xxx code is an upstream outage, which a client retries')
  assert.deepEqual(classifyTraeFailure({ code: 4295, message: 'throttled' }),
    { status: 429, kind: 'client' }, 'the 429x band is a limit wearing a 4xx code')
  assert.deepEqual(classifyTraeFailure({ code: 4001, message: 'bad config' }),
    { status: 400, kind: 'client' }, 'a 4xxx code is the request the caller sent')
  // A frame with no code at all is upstream's fault too: there is no client
  // mistake the gateway could name.
  assert.deepEqual(classifyTraeFailure({ message: 'refused' }),
    { status: 502, kind: 'server' }, 'a refusal with no code cannot be blamed on the caller')

  // A spent allowance arrives with queue markers and a multi-hour wait, so the
  // daily check runs first: reading it as a queue turned it into a long sleep
  // instead of a failover.
  const spent = classifyQoderFailure({ code: '110', message: 'daily quota spent', retryAfterSeconds: 7200 })
  assert.equal(spent.status, 429)
  assert.equal(spent.kind, 'hard_credit', 'a spent daily allowance is not a queue to wait out')
  assert.ok(spent.error instanceof QoderDailyLimitRejection)
  assert.equal(spent.error.retryAfterSeconds, 7200,
    'the stated wait must ride along, or the client retries at once against the same exhausted quota')
  const qoderQueued = classifyQoderFailure({ code: '10605', message: 'queued', retryAfterSeconds: 30 })
  assert.equal(qoderQueued.status, 429)
  assert.equal(qoderQueued.kind, 'soft_rate')
  assert.ok(qoderQueued.error instanceof QoderQueueRejection)
  assert.equal(qoderQueued.error.retryAfterSeconds, 30)
  // The sign-in spellings are matched before the bare code, so a stray field
  // name never shadows an expired sign-in.
  assert.equal(classifyQoderFailure({ code: '105', message: 'Login expired' }).status, 401)
  assert.equal(classifyQoderFailure({ code: '999', message: 'token is not active' }).kind, 'authentication')
  assert.ok(classifyQoderFailure({ code: '999', message: 'TOKEN_EXPIRE' }).error instanceof QoderSignInExpiredError)
  // And the bare code on its own, for the answer that names no marker at all.
  assert.equal(classifyQoderFailure({ code: '105', message: 'sign-in is no longer valid' }).status, 401,
    'the code alone must read as an expired sign-in, not as an upstream fault')
  // Two co-occurring queue descriptors are a queue even with no code the
  // decoder names, and one marker on its own is not.
  assert.equal(classifyQoderFailure({ code: '9999', message: '{"queueType":"q","isQueued":true}' }).kind, 'soft_rate')
  assert.equal(classifyQoderFailure({ code: '9999', message: '{"queueType":"q"}' }).status, 502,
    'a lone queue marker is not a queue')
  // A fabricated thinking flag is the caller's own mistake, and a bare code the
  // gateway does not know is an upstream fault it cannot place.
  assert.equal(classifyQoderFailure({ code: '1210', message: 'reasoning_effort is not supported' }).status, 400,
    'a request the upstream refused for its own shape is the caller\'s mistake')
  assert.equal(classifyQoderFailure({ code: '1210', message: 'reasoning_effort is not supported' }).kind, 'client')
  assert.equal(classifyQoderFailure({ code: '9999', message: 'something went wrong' }).status, 502)
  assert.equal(classifyQoderFailure({ code: '429', message: 'slow down' }).kind, 'soft_rate')
  assert.equal(classifyQoderFailure({ code: '402', message: 'payment required' }).kind, 'hard_credit')
})

// ---------------------------------------------------------- third round

/**
 * A loopback server stops listening and aborts a turn that is still in flight.
 *
 * Teardown makes two calls and each buys a different thing, so dropping either
 * one is a hang the user sees as the plugin staying alive after they disabled
 * it:
 *
 * - no `server.close()`: the endpoint keeps listening, so the process never
 *   exits. Caught by `port()` still being non-zero afterwards.
 * - no `closeAllConnections()`, or it sequenced after the wait: `close()` waits
 *   for its connections to end and a chat mid-stream does not end until the
 *   upstream does, so teardown blocks on the upstream instead of on the user.
 *   Caught by the close itself not returning.
 *
 * An idle keep-alive socket is NOT what decides this: `close()` drops those on
 * its own, and all four orderings resolve with nothing in flight. A turn that
 * is still streaming is what makes the difference, so that is the fixture here.
 */
test('a loopback server stops listening and aborts a turn that is still in flight', async () => {
  const http = require('node:http')
  const { createLoopbackServer } = require('../lib/loopback')
  const server = createLoopbackServer({
    label: 'teardown probe',
    port: 0,
    // One route answers, one never does: a turn that is still streaming.
    handle: (req, res) => { if (req.url === '/hang') return; res.writeHead(200); res.end('ok') },
  })
  await server.ready
  let streaming
  const inFlight = new Promise((resolve) => {
    streaming = http.get(`http://127.0.0.1:${server.port()}/hang`, (response) => {
      response.resume()
      response.on('end', () => resolve('ended'))
    })
    streaming.on('error', (error) => resolve('errored:' + error.code))
  })
  // Give the request time to reach the handler, so it really is in flight
  // rather than not yet sent.
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    // The close itself is what has to return: it waits for its connections to
    // end, and this one does not end on its own. The timer is unref'd because a
    // lost race leaves it pending, and a pending timer holds the whole test
    // process open long after the case is over.
    const outcome = await Promise.race([
      server.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 10_000).unref()),
    ])
    assert.equal(outcome, 'closed',
      'teardown must not wait on a turn that is still streaming: a chat mid-stream does not end until the upstream does')
    assert.equal(server.port(), 0,
      'the endpoint must stop listening, or the plugin keeps accepting after the user disabled it')
  } finally {
    // Drop the client end first, so a teardown that is still waiting on this
    // connection can finish, then close through the public API. Only the public
    // API is used and a second close is safe - its callback resolves either way.
    streaming.destroy()
    await server.close()
  }
})

/**
 * The refresh path's own contracts, which nothing pinned.
 *
 * `ensureFresh`'s doc says a failed refresh keeps a token that has not yet
 * expired so an unreachable refresh endpoint never takes down a working session,
 * and that a desktop re-login during the refresh supersedes the response. Both
 * were untested: dropping the still-valid guard, removing the object-identity
 * check and removing the once-per-account warning each left the whole suite
 * green.
 */
const nearExpiryInfo = (name, extra = {}) => JSON.stringify({
  auth: { accessToken: 'token-' + name, refreshToken: 'refresh-' + name, expiresAt: Date.now() + 120_000, domain: 'www.workbuddy.cn', ...extra },
  account: { uin: 'uin-' + name, nickname: name },
})

test('a failed refresh keeps a token that has not yet expired', async () => {
  const dir = scratch('refresh-keeps-token')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), nearExpiryInfo('keeper'))
  const warnings = []
  const client = { refreshToken: async () => { throw new Error('the refresh endpoint is unreachable') } }
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir], client, cooldownMs: 60000,
    logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  })
  const account = await pool.acquire()
  assert.ok(account !== undefined, 'an account inside the refresh margin is still handed out')
  assert.equal(account.credential.accessToken, 'token-keeper',
    'a failed refresh must keep the token it had, so one bad round trip does not take the session down')
  assert.ok(warnings.some((args) => String(args[0]).includes('still valid')),
    'and it is reported as the recoverable failure it is, not as an expired token')
  assert.ok(!warnings.some((args) => String(args[0]).includes('token expired')),
    'a token with two minutes left is not an expired token')
})

test('a desktop re-login during the refresh is not overwritten by the stale response', async () => {
  const dir = scratch('refresh-relogin')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), nearExpiryInfo('relogin'))
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  let swapped = false
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir],
    // The refresh is in flight; the desktop app rewrites its file and a scan
    // lands the new credential while this response is still on the wire.
    client: {
      refreshToken: async () => {
        if (!swapped) {
          swapped = true
          pool.accounts[0].credential = { ...pool.accounts[0].credential, accessToken: 'from-the-new-login' }
        }
        return { accessToken: 'from-the-stale-refresh' }
      },
    },
    cooldownMs: 60000,
  })
  await pool.acquire()
  assert.equal(pool.accounts[0].credential.accessToken, 'from-the-new-login',
    'the response the refresh was answering must not replace the credential the re-login installed')
})

test('a region-scoped caller never picks an account from the other region', async () => {
  const dir = scratch('region-scope')
  fs.writeFileSync(path.join(dir, 'cn.info'), JSON.stringify({
    auth: { accessToken: 'cn-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'cn-uin', nickname: 'cn' },
  }))
  fs.writeFileSync(path.join(dir, 'global.info'), JSON.stringify({
    auth: { accessToken: 'global-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.ai' },
    account: { uin: 'global-uin', nickname: 'global' },
  }))
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60000 })
  const cn = await pool.acquire(undefined, 'cn')
  assert.equal(cn?.credential.accessToken, 'cn-token', 'a CN caller gets the CN sign-in')
  const global = await pool.acquire(undefined, 'global')
  assert.equal(global?.credential.accessToken, 'global-token', 'a global caller gets the global sign-in')
  // An account whose domain the other gateway cannot reach would answer every
  // request with a 403 or 404, which reads as an upstream outage.
  const scoped = await pool.acquire(undefined, 'cn')
  assert.notEqual(scoped?.credential.accessToken, 'global-token',
    'and it must keep doing so, not drift to whichever account is at the head')
})

test('a removed account stops being handed out without waiting for a rescan', async () => {
  const dir = scratch('removed-account')
  fs.writeFileSync(path.join(dir, 'a.info'), JSON.stringify({
    auth: { accessToken: 'a-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'a-uin', nickname: 'a' },
  }))
  fs.writeFileSync(path.join(dir, 'b.info'), JSON.stringify({
    auth: { accessToken: 'b-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'b-uin', nickname: 'b' },
  }))
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60000 })
  await pool.acquire()
  const first = pool.accounts[0].id
  pool.applyRemoved([first])
  const after = await pool.acquire()
  assert.notEqual(after?.id, first,
    'a removed account must not come back the next time the desktop app rewrites its sign-in file')
  pool.applyRemoved([])
  await pool.acquire()
  assert.ok(pool.accounts.some((account) => account.id === first),
    'and restoring it takes effect at once too, without waiting for the next scan')
})

test('the no-refresh-token warning fires once per account, not once per request', async () => {
  const dir = scratch('no-refresh-warning')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'token', refreshToken: '', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'uin', nickname: 'no-refresh' },
  }))
  const warnings = []
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir], cooldownMs: 60000,
    // A client has to be present for `ensureFresh` to run at all; this branch
    // returns before it is used, because there is no refresh token to spend.
    client: { refreshToken: async () => ({ accessToken: 'unused' }) },
    logger: { warn: (...args) => warnings.push(String(args[0])), error: () => {} },
  })
  for (let turn = 0; turn < 3; turn += 1) await pool.acquire()
  const hits = warnings.filter((line) => line.includes('no refresh token'))
  assert.equal(hits.length, 1,
    'this branch is reached on every turn, so a warning per request buries every real failure in the log')
})

test('a sticky conversation keeps the account it started on', async () => {
  const dir = scratch('sticky-distribution')
  for (const name of ['one', 'two', 'three']) {
    fs.writeFileSync(path.join(dir, name + '.info'), JSON.stringify({
      auth: { accessToken: 'token-' + name, refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
      account: { uin: 'uin-' + name, nickname: name },
    }))
  }
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60000, distribution: 'sticky' })
  const first = await pool.acquire(undefined, undefined, 'conversation-a')
  const again = await pool.acquire(undefined, undefined, 'conversation-a')
  const other = await pool.acquire(undefined, undefined, 'conversation-b')
  assert.equal(again?.id, first?.id,
    'the same conversation must keep its account, or the upstream prompt cache is discarded mid-conversation')
  assert.notEqual(other?.id, first?.id,
    'and a different conversation takes a different one, which is what spreads the spend')
})

/**
 * A 401 the upstream spells without a session marker still rotates.
 *
 * The loopback endpoint authenticates nothing, so the upstream is the only
 * party that could refuse the bearer, and a 401 is always about this account's
 * sign-in. Reading the unrecognised ones as `client` answered 400 and broke the
 * rotation on the first account: a stale sign-in then served every turn as a
 * hard failure while the refresh-and-retry path written for exactly this never
 * ran, and the healthy accounts behind it were never tried.
 */
test('a 401 without a session marker rotates and refreshes', async () => {
  const { WorkBuddyUpstreamClient, classifyUpstreamError } = require('../lib/upstream')
  assert.equal(classifyUpstreamError(401, ''), 'session_dead',
    'a bare 401 is about the sign-in, not about the request')
  assert.equal(classifyUpstreamError(401, '{"code":1001,"msg":"token expired"}'), 'session_dead',
    'and so is one the upstream answers with a business envelope')
  assert.equal(classifyUpstreamError(401, '<html><body>openresty</body></html>'), 'session_dead',
    'and so is the gateway page that refuses a credential it no longer honours')
  assert.equal(classifyUpstreamError(403, '{"code":7,"msg":"insufficient credit"}'), 'hard_credit',
    'a 403 the upstream judges on credits stays a credit verdict')

  // End to end through the shim: the refused account is refreshed, and when the
  // refresh cannot change the answer the next sign-in serves instead.
  const dir = scratch('rotate-401')
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url) => {
      calls.push(String(url))
      if (String(url).endsWith('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'refreshed' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('<html>openresty</html>', { status: 401 })
    },
  })
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  for (const name of ['first', 'second']) {
    const home = path.join(dir, name)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: name, refreshToken: 'r-' + name, expiresAt: 0, domain: 'www.workbuddy.cn' },
      account: { uin: 'u-' + name, nickname: name },
    }))
  }
  const pool = new WorkBuddyAccountPool({ authDirs: [path.join(dir, 'first'), path.join(dir, 'second')], client, cooldownMs: 60000 })
  const { createWorkBuddyShim } = require('../lib/shim')
  const { WorkBuddyCatalog } = require('../lib/catalog')
  const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 401,
      'every sign-in refused is a sign-in problem, not a 400 the client caused')
    assert.match(await answer.text(), /gateway rejected this credential/,
      'the answer names what to do about a stale sign-in instead of relaying the page')
    assert.ok(calls.some((url) => url.endsWith('/v2/plugin/auth/token/refresh')),
      'the refused sign-in must be refreshed, which is the one thing that can fix it')
    assert.ok(calls.filter((url) => url.endsWith('/v2/chat/completions')).length >= 2,
      'and the next sign-in must be tried, not only the one that failed')
  } finally {
    await shim.close()
  }
})

/**
 * A rate-limit reset that has already passed does not shadow a live header.
 *
 * The body parse is read first and returns a past timestamp unchanged, so a
 * stale or clock-skewed reset won the `??` and the header was never consulted.
 * `penalize` then took the "already past" branch and applied the 60 s default,
 * which returned a still-limited account to the head of the queue.
 */
test('a reset that has already passed does not shadow a live Retry-After', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('{"resetAt":1}', {
    status: 429, headers: { 'retry-after': '300' },
  }) })
  const limited = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', new AbortController().signal,
  )
  assert.equal(limited.retryAfter, 300, 'the header is what the shim has to honour')

  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const dir = scratch('past-reset')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60000 })
  await pool.scan()
  const id = pool.list()[0].id
  pool.penalize(id, 1, 'hy3')
  assert.equal(pool.list()[0].cooldownUntilMs, 0,
    'a reset in the past is not a cooldown; the caller has to fall back to the header')
  pool.penalize(id, Date.now() + 300000)
  assert.ok(pool.list()[0].cooldownUntilMs > Date.now() + 4 * 60 * 1000,
    'a live wait lands as the account-wide cooldown the shim sends')
})

/**
 * A stream that fails mid-turn ends in a shape the client can finish on.
 *
 * Destroying the socket left a 200 with a truncated body and no terminator,
 * which is a turn the caller can only end by timing out and cannot tell from a
 * cancel. The two sibling gateways already end theirs with an in-band error
 * frame, a finish chunk and `[DONE]`.
 */
test('a WorkBuddy stream that fails mid-flight ends with a terminator', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const dir = scratch('midflight')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir] })
  const failing = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      controller.error(new Error('Bearer eyJhbGciOi.real.token.value rejected'))
    },
  })
  const client = {
    prepareChatBody: (raw) => raw,
    chatStream: async () => ({ ok: true, response: new Response(failing, { status: 200 }) }),
  }
  const { createWorkBuddyShim } = require('../lib/shim')
  const { WorkBuddyCatalog } = require('../lib/catalog')
  const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.match(body, /"error"\s*:\s*\{/, 'the failure must reach the client in band')
    assert.match(body, /upstream_error/, 'and it must be named as the upstream\'s doing')
    assert.match(body, /data: \[DONE\]/, 'and the stream must still carry its terminator')
    assert.doesNotMatch(body, /eyJhbGciOi\.real\.token\.value/,
      'the relayed error text is redacted before it leaves the process')
  } finally {
    await shim.close()
  }
})

/**
 * A credential that has died with nothing to refresh it is not picked.
 *
 * `available()` filtered cooldowns and switches but not expiry, so an expired
 * sign-in with no refresh token led every request: each one paid a failed
 * refresh round trip and then a guaranteed 401 before the hold moved traffic
 * to the healthy account behind it.
 */
test('an expired sign-in with no refresh token leads no request', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const dir = scratch('expired-lead')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'dead', refreshToken: '', expiresAt: Date.now() - 60000, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-dead', nickname: 'Dead' },
  }))
  const live = path.join(dir, 'live')
  fs.mkdirSync(live, { recursive: true })
  fs.writeFileSync(path.join(live, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() + 3600000, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-live', nickname: 'Live' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir, live] })
  await pool.scan()
  const available = pool.available(Date.now())
  assert.equal(available.length, 1, 'only the sign-in that can serve a request is eligible')
  assert.equal(available[0].label, 'Live')
  assert.equal((await pool.acquire()).label, 'Live', 'and it is the one the pool hands out')
  // A sign-in that is merely near its expiry stays eligible: `ensureFresh`
  // renews it on the way through, which is the only thing that puts it back.
  fs.writeFileSync(path.join(live, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() - 60000, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-live', nickname: 'Live' },
  }))
  await pool.scan()
  assert.equal(pool.available(Date.now()).length, 1,
    'an expired token that still has a refresh token stays eligible')
})

/**
 * A balance read that finds credits again releases the pool's hold.
 *
 * The hold's own documentation names three release paths; a balance read was
 * not one of them. A user who topped up a 402'd account waited out the whole
 * hold, and the only way back was a manual cooldown reset.
 */
test('a balance read that finds credits releases the hold', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const dir = scratch('hold-release')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir] })
  await pool.scan()
  const id = pool.list()[0].id
  pool.penalize(id, Date.now() + 6 * 60 * 60 * 1000, undefined, true)
  assert.equal(pool.available(Date.now()).length, 0, 'the hold keeps the account out of rotation')
  pool.setCreditBalance(id, 500)
  assert.equal(pool.available(Date.now()).length, 1,
    'credits being there again is the signal that the condition behind the hold changed')
  // A rate limit is not released by a balance: it belongs to the upstream's own
  // window, which a balance says nothing about.
  pool.penalize(id, Date.now() + 60000)
  pool.setCreditBalance(id, 500)
  assert.equal(pool.available(Date.now()).length, 0,
    'a rate-limit cooldown is the upstream\'s to end, not the balance\'s')
  pool.resetCooldowns()
  assert.equal(pool.available(Date.now()).length, 1, 'and the manual reset still clears everything')
})

/**
 * A sign-in that leaves the pool takes its balance and expiry with it.
 *
 * Both maps are keyed by account id and were never pruned, so a signed-out and
 * re-signed-in account inherited its old figures: the reserve floor kept it
 * unpickable and `expiry` mode ranked it on a pack that no longer existed.
 */
test('a departing account leaves no balance or expiry behind', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const dir = scratch('departed')
  const gone = path.join(dir, 'gone')
  fs.mkdirSync(gone, { recursive: true })
  fs.writeFileSync(path.join(gone, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-gone', nickname: 'Gone' },
  }))
  // A reserve floor and an expiry ranking: the two settings that make the
  // balance and the pack expiry matter to the picker at all.
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir, gone],
    distribution: 'expiry',
    creditReserves: {},
  })
  await pool.scan()
  const id = pool.list()[0].id
  pool.setCreditBalance(id, 3, Date.now() + 3600000)
  pool.applyConfig({ creditReserves: { [id]: 5000 } })
  assert.equal(pool.available(Date.now()).length, 0,
    'the reserve floor holds the account back while its balance is below it')
  fs.rmSync(path.join(gone, 'workbuddy-desktop.info'))
  await pool.scan()
  assert.deepEqual(pool.list(), [], 'the deleted sign-in is dropped from the pool')
  // The same id signs back in: nothing it left behind may still apply to it.
  fs.writeFileSync(path.join(gone, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't2', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-gone', nickname: 'Gone' },
  }))
  await pool.scan()
  assert.equal(pool.list().length, 1, 'the re-signed-in account is back')
  assert.equal(pool.available(Date.now()).length, 1,
    'and it is pickable: no stale balance, reserve floor or pack expiry is inherited')
  // The expiry ranking too: a pack that expired with the old sign-in must not
  // still be what ranks the new one.
  assert.ok((await pool.acquire()).label === 'Gone',
    'the account is served, which only holds while no stale pack expiry ranks it out')
})

/**
 * The caller's abort listener is detached once the headers phase is over.
 *
 * One listener was added per `chatStream` call and never removed. A rotation
 * that exhausts its attempts adds one per account on the same caller signal,
 * which is how Node's listener warning used to fire on every exhausted turn.
 */
test('a headers deadline detaches the caller abort listener it added', () => {
  const { headersDeadline } = require('../lib/upstream')
  const caller = new AbortController()
  const { getEventListeners } = require('node:events')
  const before = getEventListeners(caller.signal, 'abort').length
  for (let round = 0; round < 9; round += 1) {
    headersDeadline(caller.signal, 50).arrived()
  }
  assert.equal(getEventListeners(caller.signal, 'abort').length, before,
    'every deadline that has arrived must take its listener with it, or the signal piles them up')
  // A deadline that has NOT arrived keeps forwarding the hang-up.
  const pending = headersDeadline(caller.signal, 50)
  assert.equal(getEventListeners(caller.signal, 'abort').length, before + 1,
    'the forwarding listener is still armed while the request is in flight')
  pending.arrived()
})

/**
 * The idle watchdog releases its timer when it fires.
 *
 * The watchdog cancels the reader, which resolves the pending read as an end,
 * so `pull` ran once more and re-armed. The timer that had just fired was
 * never cleared, so it outlived the stream it was watching and fired again
 * into a released reader on every watchdog-cancelled turn.
 */
test('an idle watchdog that fires releases its timer', async () => {
  const { withIdleWatchdog } = require('../lib/upstream')
  // The watchdog reads its timers from the globals, so they are counted by
  // standing in for them - the same way the clean-end case above does it. The
  // stub fires on the next turn, which is what reaches the fire branch.
  let armed = 0
  let cleared = 0
  let fired = 0
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (handler) => {
    armed += 1
    return realSetTimeout(() => { fired += 1; handler() }, 0)
  }
  globalThis.clearTimeout = (handle) => { cleared += 1; realClearTimeout(handle) }
  try {
    // A stream that never sends and never ends is the only way to reach the
    // fire branch at all.
    const relayed = withIdleWatchdog(new ReadableStream({ start() { /* never sends */ } }), 20)
    const reader = relayed.getReader()
    await assert.rejects(() => reader.read(), /went idle/,
      'the quiet stream fails instead of hanging')
    assert.equal(fired, 1, 'the watchdog fired exactly once')
    assert.equal(cleared, armed,
      'the timer that fired must be cleared, or it outlives the stream it watched')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

/**
 * A Trae refusal that carries no code still rotates.
 *
 * Trae answers a stale login inside the stream, on the same `event: error`
 * frame a bad request uses, and often with no code at all. Answering it as a
 * 502 server failure is the one class the gateway does not rotate on, so every
 * request paid one round trip and the healthy sign-ins beside it were never
 * tried. The Qoder path in this same plugin classifies the identical frame as
 * an authentication failure.
 */
test('a code-less Trae login refusal rotates', () => {
  const { classifyTraeFailure } = require('../lib/trae-shim')
  const expired = classifyTraeFailure({ message: 'Login expired' })
  assert.equal(expired.status, 401, 'the status must say the sign-in, not the server')
  assert.equal(expired.kind, 'authentication', 'and the kind must be one the gateway rotates on')
  const unnamed = classifyTraeFailure({ message: 'upstream had an issue' })
  assert.equal(unnamed.kind, 'server', 'a refusal that names nothing stays the upstream\'s fault')
  assert.equal(classifyTraeFailure({ code: 1005, message: '' }).kind, 'hard_credit',
    'the subscription gate keeps its own class')
  assert.equal(classifyTraeFailure({ code: 10605, message: '{"retryAfterSeconds":30}' }).kind, 'soft_rate',
    'and a queue frame keeps naming its own wait')
})

/**
 * A Trae refusal with neither a code nor words is not assembled with a leading
 * separator.
 *
 * `parts.join(' · ')` is empty in that case, so the text began with a stray
 * bullet that reached the client in the error frame and in the peeked 502 body.
 */
test('a Trae refusal with no code carries no leading separator', () => {
  const { describeTraeFailure } = require('../lib/trae-shim')
  assert.equal(describeTraeFailure({ message: 'Login expired' }), 'upstream: Login expired',
    'a code-less refusal reads as a sentence, not as a separator and then one')
  assert.equal(describeTraeFailure({ message: '' }), 'Trae SOLO refused the request',
    'a refusal with nothing at all still says something')
  assert.equal(describeTraeFailure({ code: 1005, message: 'gate' }), 'code 1005 · upstream: gate')
})

/**
 * The model directory is read with the next sign-in when the first is refused.
 *
 * The directory is a per-account read like any other: a revoked sign-in answers
 * 401 on every one of its five functions, and reading with the first one only
 * left the whole gateway answering 503 and publishing no provider row while a
 * healthy sign-in sat beside it unused.
 */
test('a Trae directory read falls back to the next sign-in', async () => {
  const { createTraeGateway } = require('../lib/trae-gateway')
  let refused = 0
  const gateway = createTraeGateway({
    credentials: async () => [
      { accessToken: 'dead', refreshToken: '', expiresAtMs: 0, userId: 'dead', edition: 'cn', source: 'desktop', sourcePath: '' },
      { accessToken: 'live', refreshToken: '', expiresAtMs: 0, userId: 'live', edition: 'cn', source: 'desktop', sourcePath: '' },
    ],
    identity: async () => ({ machineId: 'm', deviceId: 'd' }),
    fetchImpl: async (_url, init) => {
      if (init?.headers?.['x-uid'] === 'dead') {
        refused += 1
        return new Response('nope', { status: 401 })
      }
      return new Response(JSON.stringify({
        config_info_list: [{ config_name: 'solo-pro', display_config: { display_name: 'Solo Pro' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/models', { headers: { host: '127.0.0.1' } })
    assert.equal(answer.status, 200, 'the gateway answers instead of reporting itself unavailable')
    const body = await answer.json()
    assert.equal(body.data.length, 1, 'the second sign-in\'s roster is served')
    assert.equal(body.data[0].id, 'solo-pro')
    assert.equal(gateway.models().length, 1, 'and the roster is cached for the next read')
    assert.equal(refused, 5,
      'the refused sign-in is given up on after its five directory functions, not retried forever')
  } finally {
    await gateway.close()
  }
})

test('a Qoder directory read falls back to the next sign-in', async () => {
  const { createQoderGateway } = require('../lib/qoder-gateway')
  let served = 0
  const gateway = createQoderGateway({
    region: 'cn',
    credentials: async () => [
      { token: 'dead', userID: 'dead', name: 'dead' },
      { token: 'live', userID: 'live', name: 'live' },
    ],
    fetchImpl: async () => {
      served += 1
      if (served === 1) return new Response('nope', { status: 401 })
      return new Response(JSON.stringify({ chat: [{ key: 'qmodel', display_name: 'Q Model', enable: true }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/models', { headers: { host: '127.0.0.1' } })
    assert.equal(answer.status, 200, 'the gateway answers instead of reporting itself unavailable')
    const body = await answer.json()
    assert.equal(body.data.length, 1, 'the second sign-in\'s roster is served')
    assert.equal(body.data[0].id, 'qmodel')
    assert.equal(served, 2, 'and the refused sign-in is not retried forever')
  } finally {
    await gateway.close()
  }
})

/**
 * A nested acknowledgement does not erase the outer business code.
 *
 * The walk reassigned `codeFromPlainKey` at every level, so the
 * `{"code":0}`-is-an-ack guard fired on the nested value and blanked the
 * outer `errorCode`. A classifiable refusal then read as unnamed, which the
 * gateway answered 502 for instead of rotating.
 */
test('a nested acknowledgement does not erase the outer refusal code', () => {
  const { unwrapFailure } = require('../lib/qoder-sse')
  assert.equal(unwrapFailure({ errorCode: '110', details: { code: 0, reqId: 1 } }).code, '110',
    'a container the upstream acknowledged in its own terms says nothing about the refusal that carries it')
  assert.equal(unwrapFailure({ code: 0 }).code, '', 'a bare acknowledgement is still not a refusal')
  assert.equal(unwrapFailure({ code: '10605', message: '{"retryAfterSeconds":30}' }).code, '10605',
    'and a code the frame names itself still comes through')
})

/**
 * One event's accumulated data lines may not grow without bound.
 *
 * The line guard measures the unterminated tail, which stays small on a stream
 * that keeps ending its lines: every `data:` line lands in `data` and only a
 * blank line drains it, so a stream that framed events without ever separating
 * them grew the array with no ceiling touching it.
 */
test('an SSE event that never separates is bounded', () => {
  const { SseDecoder } = require('../lib/trae-sse')
  const decoder = new SseDecoder()
  assert.throws(() => {
    for (let round = 0; round < 60000; round += 1) decoder.push('data: {"x":1}\n'.repeat(20))
  }, /exceeded/, 'a stream that never separates its events is stopped, not buffered')
})


/**
 * Each Trae storage file is probed once, under the first edition that names it.
 *
 * Two editions spell the same path on a case-sensitive filesystem, and probing
 * it twice produced two credentials from one install. When the storage document
 * named neither a region nor a host, the candidate's edition decided, so one
 * install published two provider rows and one region's gateway routed a foreign
 * token to the wrong endpoint.
 */
test('a Trae storage file is probed under one edition only', () => {
  const { traeStorageCandidates } = require('../lib/trae-discovery')
  for (const [platform, home, env] of [
    ['linux', '/home/fixture', {}],
    ['win32', 'C:\\Users\\fixture', { APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' }],
    ['darwin', '/Users/fixture', {}],
  ]) {
    const paths = traeStorageCandidates(platform, home, env).map((candidate) => candidate.path)
    assert.equal(new Set(paths).size, paths.length,
      platform + ': no physical file may be probed twice')
  }
  const bare = traeStorageCandidates('linux', '/home/fixture', {})
    .filter((candidate) => candidate.path.split(path.sep).includes('trae'))
  assert.equal(bare.length, 1, 'the bare `trae` spelling belongs to the first edition that claims it')
  // An international install on Linux still has to be discoverable.
  assert.ok(traeStorageCandidates('linux', '/home/fixture', {}).some((candidate) => candidate.edition === 'sg'),
    'the international edition keeps its own candidates')
})

/**
 * A Qoder model publishes the window it can actually be handed.
 *
 * `context_config` lists the sizes Qoder's own client can select (1M / 400K /
 * 200K) and marks the one currently chosen. Publishing the chosen one capped a
 * model that offers a million tokens at a fifth of it, and the host compacts
 * against exactly this number, so every conversation was trimmed at 200K no
 * matter which model served it. Verified against the live directory: a prompt
 * of a million tokens was accepted by `qmodel`.
 */
test('a Qoder model publishes the largest window its catalog offers', () => {
  const { qoderModelOf } = require('../lib/qoder-client')
  const row = (key, maxInputTokens, config) => qoderModelOf({
    key,
    display_name: key,
    max_input_tokens: maxInputTokens,
    context_config: config,
  })
  const full = row('qmodel', 180000, {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  })
  assert.equal(full.contextWindow, 1000000,
    'the selected size is not the ceiling; the largest on offer is what the model takes')
  const only = row('mmodel', 180000, { '200K': { token_count: 200000, is_default: true } })
  assert.equal(only.contextWindow, 200000, 'a model with one size keeps that size')
  assert.equal(qoderModelOf({ key: 'bare', display_name: 'Bare', max_input_tokens: 300000 }).contextWindow,
    300000, 'no config at all falls back to the stated input budget')
  // The selected input budget must not be read as a smaller window either.
  const small = row('dmodel', 96000, {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
  })
  assert.equal(small.contextWindow, 1000000,
    'a small selected budget is the current selection, not the model\'s limit')
})

/**
 * A forced pass does not collapse onto a background read that skipped the roster.
 *
 * `connect` skips the fetch whenever the cached roster is still fresh, so a
 * forced click that returned the background pass's promise answered with the
 * figures it already had. The button exists precisely for the case where a
 * background read failed, and `catalogFetchedAtMs` is stamped even on failure,
 * which kept the roster stale for the whole TTL.
 */
test('a forced pass re-reads a roster the background pass skipped', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  // `connect` is the seam: it records the `force` flag it was handed, and the
  // first read stays in flight until the test releases it, which is what puts a
  // forced pass on top of a background one.
  const runs = []
  const events = []
  // One gate per read: the forced pass awaits the read in flight, so its own
  // read cannot be released from inside the call that started it.
  const gates = []
  const openNextGate = () => { const next = gates.shift(); if (next !== undefined) next() }
  const context = vm.createContext({
    console,
    connect: async (_runtime, force) => {
      const tag = force === true ? 'forced' : 'background'
      runs.push(force === true)
      events.push(tag + '-read')
      await new Promise((resolve) => { gates.push(resolve) })
      events.push(tag + '-done')
      return true
    },
  })
  vm.runInContext(entryFunctions(['refreshRuntime'], source), context)

  const runtime = { connecting: null }
  // The background pass starts and stays in flight.
  const background = context.refreshRuntime(runtime, 'panel', false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, 'the background pass has started its read')
  // The user clicks Refresh while it is still reading.
  const forced = context.refreshRuntime(runtime, 'click', true)
  await new Promise((resolve) => setImmediate(resolve))
  openNextGate()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(runs, [false, true],
    'the forced pass must run its own read, not await the one that skipped it')
  // And it waits for the read it found in flight before starting its own: a
  // second concurrent read answers the click with figures that are no fresher
  // than the ones the click was meant to replace.
  assert.deepEqual(events, ['background-read', 'background-done', 'forced-read'],
    'the forced read starts only once the background read has finished')
  openNextGate()
  const answer = await forced
  assert.equal(answer.ok, true)
  await background
})

/**
 * A repointed auth file schedules the scan that refills the pool.
 *
 * `applyConfig` empties the pool when the directory set changes, and nothing
 * downstream reads the disk on its own. Without this both WorkBuddy provider
 * rows dropped out of the picker and the panel reported "no sign-in found"
 * until a chat request happened to scan, or the user pressed the rescan button.
 */
test('a repointed auth file schedules the scan that refills the pool', async () => {
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const first = scratch('authfile-first')
  const second = scratch('authfile-second')
  fs.writeFileSync(path.join(first, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [first] })
  await pool.scan()
  assert.equal(pool.list().length, 1)
  assert.equal(pool.applyConfig({ authDirs: [second] }), true,
    'the pool must report that it was emptied')
  assert.deepEqual(pool.list(), [], 'and it is empty until something reads the new directory')
  await pool.scan()
  assert.deepEqual(pool.list(), [], 'the new directory holds no sign-in yet')
  fs.writeFileSync(path.join(second, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't2', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-2', nickname: 'Second' },
  }))
  await pool.scan()
  assert.equal(pool.list().length, 1, 'the scan the flag schedules is what brings it back')
  assert.equal(pool.applyConfig({ cooldownMs: 120000 }), false,
    'a change that empties nothing reports nothing')
})

/**
 * An error body is bounded in time as well as in size.
 *
 * The headers deadline is disarmed before the caller reaches a non-2xx answer,
 * so an upstream that answered 429 and then trickled its error page held the
 * attempt until undici's own body timeout, and a rotation pays that once per
 * account before it can answer at all.
 */
test('a failed response body is bounded in time', async () => {
  const { readErrorBody } = require('../lib/upstream')
  const stalled = new Response(new ReadableStream({ start() { /* never sends, never ends */ } }), { status: 429 })
  const started = Date.now()
  assert.equal(await readErrorBody(stalled, 4096), '',
    'a body that never completes is abandoned rather than awaited')
  // The plugin's own bound, not undici's 300 s body timeout: a rotation pays
  // this once per account, so it has to be short enough to answer inside.
  assert.ok(Date.now() - started < 20000, 'and it is abandoned inside the plugin\'s own bound')
  assert.ok(Date.now() - started >= 9000, 'and it is not abandoned before the body has had its chance')
  assert.equal(await readErrorBody(new Response('upstream said 429', { status: 429 }), 4096),
    'upstream said 429', 'a body that arrives is read')
  assert.equal((await readErrorBody(new Response('x'.repeat(20000), { status: 429 }), 100)).length, 100,
    'and the size bound holds too')
})

/**
 * A refusal that merely contains the word "already" is a failure, not a skip.
 *
 * The substring match counted any upstream text carrying "already" as the day
 * having been collected, which hid real breakages from the last-run line and
 * from the summary the user reads.
 */
test('a refusal that merely contains "already" is a failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const name = 'isAlreadyCheckin'
  const body = entryFunctions([name], source)
  const mod = { exports: {} }
  new Function('module', 'exports', 'require',
    'const safeMessage = (error) => String((error && error.message) || error);\n' + body
    + '\nmodule.exports = { isAlreadyCheckin };')(mod, mod.exports, require)
  assert.equal(mod.exports.isAlreadyCheckin(new Error('already')), false,
    'a bare word is not the sentence the upstream uses for a collected day')
  assert.equal(mod.exports.isAlreadyCheckin(new Error('the account already exists')), false,
    'and neither is a refusal about the account')
  assert.equal(mod.exports.isAlreadyCheckin(new Error('already checked in today')), true)
  assert.equal(mod.exports.isAlreadyCheckin(new Error('您今天已经签到')), true)
})

/**
 * The panel keeps polling while every account is cooling.
 *
 * `probesStale` skips cooling accounts by design, so an all-cooling pool read
 * as "nothing to refresh" and the panel stopped polling: the figures stayed
 * stale until the user clicked Refresh or the poll hit its attempt cap.
 */
test('the panel keeps polling while every account is cooling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const grab = (name) => {
    const start = source.indexOf('function ' + name + '(')
    assert.ok(start > 0, name + ' is where it is expected')
    return entryFunctions([name], source)
  }
  const mod = { exports: {} }
  const core = { pool: { list: () => accounts, isDisabled: () => false } }
  new Function('module', 'exports', 'require', 'core', 'regionEnabled', 'regionOf', 'probeCache', 'PROBE_TTL_MS',
    grab('cooldownPending') + '\n' + grab('probesStale') + '\nmodule.exports = { cooldownPending, probesStale };',
  )(mod, mod.exports, require, core, () => true, () => 'cn', new Map(), 60000)
  const accounts = [{ id: 'a', cooldownUntilMs: Date.now() + 60000 }]
  assert.equal(mod.exports.probesStale(accounts), false, 'a cooling account is never probed')
  assert.equal(mod.exports.cooldownPending(accounts), true,
    'but the cooldown is still something the panel is waiting for')
  accounts[0].cooldownUntilMs = 0
  assert.equal(mod.exports.cooldownPending(accounts), false,
    'and nothing at all when nothing is cooling')
})

/**
 * A chat request carries the conversation header family.
 *
 * The international gateway runs a channel check that refuses a request
 * carrying no conversation id at all: business code 11128,
 * `conversation id missing`, answered as a 400 whose tip says the call failed
 * channel verification. A request carrying the header family below is answered
 * instead of refused; one without a conversation id is refused every time.
 *
 * The shapes and the pairings follow the 5.8.4 client capture, and every id is
 * fresh per request: the upstream keeps no history by the conversation id, so
 * there is nothing to gain from deriving it and a stable value would be one
 * more thing for the check to notice.
 */
test('a chat request carries the conversation header family', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const international = {
    accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAtMs: 0,
    uid: 'fixture-uid', domain: 'www.workbuddy.ai', sourcePath: '',
  }
  let headers = {}
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      headers = { ...init?.headers }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await client.chatStream(international, JSON.stringify({
    model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }), undefined, { headersMs: 50 })

  const family = [
    'X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Root-Request-ID',
    'X-Conversation-Message-ID', 'X-Request-ID',
  ]
  for (const name of family) {
    assert.ok(headers[name], name + ' must be present: the channel check refuses without it')
  }
  assert.equal(headers['X-Root-Request-ID'], headers['X-Conversation-Request-ID'],
    'the root request id carries the value the conversation request id states')
  assert.equal(headers['X-Request-ID'], headers['X-Conversation-Message-ID'],
    'and the request id carries the message id')
  // The conversation id is a dashed UUID; the four request ids are 32 hex.
  assert.match(headers['X-Conversation-ID'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  for (const name of family.slice(1)) {
    assert.match(headers[name], /^[0-9a-f]{32}$/, name + ' is 32 hex characters')
  }
  // Fresh per request: nothing is derived, so two turns never share an id.
  let second = {}
  const again = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      second = { ...init?.headers }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await again.chatStream(international, JSON.stringify({
    model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }), undefined, { headersMs: 50 })
  assert.notEqual(second['X-Conversation-ID'], headers['X-Conversation-ID'],
    'a second turn gets its own conversation id')

  // The CN gateway accepts the family too, so it is sent there as well rather
  // than branched on region.
  let cnHeaders = {}
  const cn = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      cnHeaders = { ...init?.headers }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await cn.chatStream({
    accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAtMs: 0,
    uid: 'fixture-uid', domain: 'www.workbuddy.cn', sourcePath: '',
  }, JSON.stringify({ model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    undefined, { headersMs: 50 })
  assert.ok(cnHeaders['X-Conversation-ID'], 'the CN request carries the family too')
  // CN keeps the UA it has always been sent: the gateway reads its roster with
  // that spelling, and there is no capture to align it to.
  assert.equal(cnHeaders['User-Agent'], 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1')
  assert.equal(headers['User-Agent'], 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
    'the international request uses the captured desktop UA')
})

/**
 * An international turn opens with a system prompt even when the host did not.
 *
 * The international gateway refuses a request whose first message is not a
 * system prompt (code 11128, "first message is not system prompt"), and a host
 * that starts with the user's turn sends none. The injected prompt is empty on
 * purpose: it satisfies the check without adding an instruction the model would
 * follow, so the model still sees exactly what the host sent. The CN gateway
 * asks for neither, so the body it is sent is left alone.
 */
test('an international turn opens with a system prompt', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const sent = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      sent.push({ domain: 'x', body: String(init?.body ?? '') })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const raw = JSON.stringify({
    model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }],
  })
  const international = {
    accessToken: 't', refreshToken: 'r', expiresAtMs: 0,
    uid: 'u', domain: 'www.workbuddy.ai', sourcePath: '',
  }
  await client.chatStream(international, raw, undefined, { headersMs: 50 })
  const messages = JSON.parse(sent[0].body).messages
  assert.equal(messages[0].role, 'system', 'the first message is a system prompt')
  assert.equal(messages[0].content, '', 'and it says nothing, so the model sees only the host\'s turn')
  assert.equal(messages[1].role, 'user', 'the host\'s own turn follows it unchanged')
  assert.equal(messages.length, 2, 'and nothing else is added')

  // A host that already opens with a system prompt is left exactly as it is.
  const withSystem = JSON.stringify({
    model: 'hy3', stream: true,
    messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }],
  })
  await client.chatStream(international, withSystem, undefined, { headersMs: 50 })
  assert.deepEqual(JSON.parse(sent[1].body).messages, JSON.parse(withSystem).messages,
    'a system prompt the host sent is not replaced or duplicated')

  // The CN gateway does not ask for one, so its body is untouched.
  await client.chatStream({
    accessToken: 't', refreshToken: 'r', expiresAtMs: 0,
    uid: 'u', domain: 'www.workbuddy.cn', sourcePath: '',
  }, raw, undefined, { headersMs: 50 })
  assert.deepEqual(JSON.parse(sent[2].body).messages, JSON.parse(raw).messages,
    'the CN request carries the host\'s body exactly')
})

/**
 * A request that names no thinking effort is not refused for the omission.
 *
 * `glm-5.1` rejects the whole request with HTTP 400 / 11133 ("the request
 * parameters were rejected by the model provider") when `reasoning_effort` is
 * absent, while the same request carrying `off` or any rung of its ladder is
 * served. A client that expresses no preference - a plain OpenAI client, or the
 * host on a model whose off level is not a name its map carries - therefore got
 * a refusal where an answer was due. The gateway retries once with the model's
 * own declared default, and only for that refusal: a genuinely malformed request
 * keeps its 400 and is not spent upstream twice.
 */
test('a request that names no thinking effort gets the model default, once', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const { WorkBuddyCatalog } = require('../lib/catalog')
  const { createWorkBuddyShim } = require('../lib/shim')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-effort-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'effort-token', refreshToken: 'effort-refresh', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-effort', nickname: 'effort' },
  }))

  // The refusal the upstream really answers with, verbatim enough for the code.
  const refusal = JSON.stringify({
    code: 11133,
    msg: 'the request parameters were rejected by the model provider',
    extError: { code: '1210', type: 'invalid_request_error', StatusCode: 400 },
  })
  const bodies = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url, init) => {
      // Only the chat calls are counted: the pool also refreshes the token for a
      // sign-in whose expiry has passed, and that POST is not a model request.
      if (!String(url).endsWith('/v2/chat/completions')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'effort-token', expiresIn: 3600 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      // The upstream's rule, as measured: any named effort is served (glm-5.1
      // even takes names outside its own ladder), and the field merely being
      // absent - or present but empty, which is not a level either - is what it
      // rejects.
      if (typeof body.reasoning_effort !== 'string' || body.reasoning_effort === '') {
        return new Response(refusal, { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const catalog = new WorkBuddyCatalog()
  // The declared ladder comes from the upstream roster; the static fallback
  // states none, so the fixture states the row the live directory really carries.
  catalog.update([{
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000,
    supportedEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingLevel: 'medium',
  }])
  // The pool must read THIS file and nothing else. Without `authDirs` it falls
  // back to the real desktop profile directories, so the case would pass on a
  // machine with a live WorkBuddy sign-in and fail everywhere else - a test that
  // reads the developer's own tokens.
  const pool = new WorkBuddyAccountPool({ authDirs: [home], client, cooldownMs: 60000 })
  const shim = createWorkBuddyShim({ pool, client, catalog })
  const ask = async () => {
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    })
    return { status: answer.status, text: await answer.text() }
  }
  try {
    await shim.ready
    const served = await ask()
    assert.equal(served.status, 200, 'the turn is served instead of refused for the missing field')
    assert.match(served.text, /pong/, 'and the upstream answer reaches the caller')
    assert.equal(bodies.length, 2, 'exactly one retry: the refusal, then the same request with a default')
    assert.equal(bodies[0].reasoning_effort, undefined, 'the first attempt is the caller\'s body, unchanged')
    assert.equal(bodies[1].reasoning_effort, 'medium',
      'the retry carries the default the catalog declares for this model')
    assert.deepEqual(bodies[1].messages, bodies[0].messages, 'and nothing else about the request changes')

    // A caller that named an effort is served on the first attempt: nothing is
    // sent twice on behalf of a request that was already complete.
    bodies.length = 0
    const named = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, reasoning_effort: 'off',
      }),
    })
    assert.equal(named.status, 200, 'a request that names its effort is served as sent')
    assert.equal(bodies.length, 1, 'and is not spent upstream a second time')
    assert.equal(bodies[0].reasoning_effort, 'off', 'the caller\'s own choice is what reaches the upstream')

    // An empty string is "no preference" spelled differently, so it is filled in
    // rather than read as a named level.
    bodies.length = 0
    const blank = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, reasoning_effort: '',
      }),
    })
    assert.equal(blank.status, 200, 'an empty effort is filled in, not passed through as a refusal')
    assert.equal(bodies.length, 2, 'the empty string is retried, not accepted as a named level')
    assert.equal(bodies[1].reasoning_effort, 'medium', 'the declared default replaces the empty string')
  } finally {
    await shim.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A 400 that is not the parameter refusal is answered as it came.
 *
 * 11133 is a general invalid-parameter code, so the retry is gated on it being
 * that code *and* the request having named no effort. A different refusal - a
 * bad `temperature`, an unsupported field - must reach the caller after one
 * upstream call: retrying it would spend an account's request to produce the
 * same error, and would replace the first answer with the second.
 */
test('a refusal that is not the parameter rejection is not retried', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const { WorkBuddyCatalog } = require('../lib/catalog')
  const { createWorkBuddyShim } = require('../lib/shim')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-effort-skip-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'skip-token', refreshToken: 'skip-refresh', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-skip', nickname: 'skip' },
  }))

  let chatCalls = 0
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url) => {
      if (!String(url).endsWith('/v2/chat/completions')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'skip-token', expiresIn: 3600 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls += 1
      return new Response(JSON.stringify({ code: 11128, msg: 'the first message is not a system prompt' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    },
  })
  const catalog = new WorkBuddyCatalog()
  catalog.update([{
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000,
    supportedEfforts: ['off', 'low', 'medium', 'high'], defaultThinkingLevel: 'medium',
  }])
  const pool = new WorkBuddyAccountPool({ authDirs: [home], client, cooldownMs: 60000 })
  const shim = createWorkBuddyShim({ pool, client, catalog })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    })
    assert.equal(answer.status, 400, 'a different refusal keeps its own status')
    assert.equal(chatCalls, 1, 'and is spent upstream exactly once')
    assert.match(await answer.text(), /11128/, 'the caller sees the upstream\'s own reason, not a rewritten one')
  } finally {
    await shim.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A declared default the model does not accept is not sent.
 *
 * Answering the refusal with a level the upstream also refuses would spend a second
 * call to produce the same error. The catalog is the only source of the default, and
 * it can disagree with the ladder it states - a row written by hand, or an upstream
 * that lists a level its own default is not on.
 */
test('a default outside the model ladder is not retried with', async () => {
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const { WorkBuddyAccountPool } = require('../lib/accounts')
  const { WorkBuddyCatalog } = require('../lib/catalog')
  const { createWorkBuddyShim } = require('../lib/shim')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-effort-ladder-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'ladder-token', refreshToken: 'ladder-refresh', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-ladder', nickname: 'ladder' },
  }))

  let chatCalls = 0
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url) => {
      if (!String(url).endsWith('/v2/chat/completions')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'ladder-token', expiresIn: 3600 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls += 1
      return new Response(JSON.stringify({ code: 11133, msg: 'the request parameters were rejected by the model provider' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    },
  })
  const catalog = new WorkBuddyCatalog()
  catalog.update([{
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000,
    // The declared default is not on the ladder this row states.
    supportedEfforts: ['off', 'low', 'high'], defaultThinkingLevel: 'max',
  }])
  const pool = new WorkBuddyAccountPool({ authDirs: [home], client, cooldownMs: 60000 })
  const shim = createWorkBuddyShim({ pool, client, catalog })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    })
    assert.equal(answer.status, 400, 'the refusal is passed through')
    await answer.text()
    assert.equal(chatCalls, 1,
      'and not retried: a default the model states it does not accept would be refused again')
  } finally {
    await shim.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A sign-in that is gone takes its hold and pack expiry with it.
 *
 * A label is not unique to one sign-in: a departed account's hold was inherited
 * by the next one that happened to carry the same name, which demoted it for the
 * rest of the hold despite never having failed, and its pack expiry corrupted
 * expiry-mode ordering. The keys come from the engine's own `sourceRegionKey`, so
 * the fixture cannot drift from the format `pruneSourceState` builds.
 */
test('a departed sign-in leaves no hold or pack expiry behind', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const rows = {
    traeAccountRows: [{ label: 'kept', region: 'cn' }],
    qoderAccountRows: [{ label: 'kept', region: 'cn' }],
    sourceFailureHold: new Map(),
    sourceCreditExpiry: new Map(),
  }
  const context = vm.createContext({ console, ...rows })
  vm.runInContext(entryFunctions(['sourceRegionKey', 'pruneSourceState'], source), context)
  context.accountStateKey = (from, region, label) => context.sourceRegionKey(from, region) + '\n' + label
  const keptTrae = context.accountStateKey('trae', 'cn', 'kept')
  const goneTrae = context.accountStateKey('trae', 'cn', 'gone')
  const keptQoder = context.accountStateKey('qoder', 'cn', 'kept')
  const goneQoder = context.accountStateKey('qoder', 'cn', 'gone')
  const until = Date.now() + 60000
  rows.sourceFailureHold.set(keptTrae, until).set(goneTrae, until)
  rows.sourceCreditExpiry.set(keptQoder, until).set(goneQoder, until)
  context.pruneSourceState()
  assert.equal(context.sourceFailureHold.size, 1, 'the hold of the departed sign-in is dropped')
  assert.ok(context.sourceFailureHold.has(keptTrae), 'and the one that is still signed in keeps its hold')
  assert.equal(context.sourceCreditExpiry.size, 1, 'the same for the pack expiry')
  assert.ok(context.sourceCreditExpiry.has(keptQoder), 'the surviving sign-in keeps its expiry')
})

/**
 * A service stop releases the refresh slot.
 *
 * The pass that holds the slot releases it when its own work ends, but a pass
 * suspended in a network await keeps it for up to the remainder of its budget.
 * The freshly loaded plugin's first background pass was dropped for that whole
 * window while the panel polled for something that was never coming.
 */
test('a service stop releases the refresh slot', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const state = {
    serviceStopped: false,
    loadGeneration: 1,
    refreshTimer: null,
    refreshInflight: { held: true },
  }
  const stopped = []
  const context = vm.createContext({
    console,
    ...state,
    clearTimeout: () => { stopped.push('timer') },
    stopAutoCheckin: () => stopped.push('checkin'),
    stopAccountWatch: () => stopped.push('accountWatch'),
    abortWarmups: () => stopped.push('warmups'),
    clearModelRetries: () => stopped.push('modelRetries'),
    checkinAbort: { abort: () => stopped.push('checkinAbort') },
    runtimeStarts: new Map(),
    runtimes: new Map(),
    traeGateways: new Map(),
    qoderGateways: new Map(),
    gatewayStartFailures: new Map([['cn', 'boom']]),
    sourceStartFailures: new Map([['trae:cn', 'boom']]),
    pendingRuntimeStops: [{ then: () => {} }],
    stopRuntime: async () => {},
    log: () => {},
    safeMessage: (error) => String(error?.message ?? error),
  })
  vm.runInContext(entryFunctions(['onServiceStop'], source), context)
  await context.onServiceStop()
  assert.equal(context.refreshInflight, null,
    'the slot must be free for the freshly loaded plugin\'s first background pass')
  assert.equal(context.refreshTimer, null, 'and the deferred timer with it')
  assert.ok(stopped.includes('modelRetries'),
    'and the roster retries, which would otherwise fire into the next activation')
  assert.equal(context.gatewayStartFailures.size, 0,
    'a region whose failure belonged to this activation must not read as failed in the next')
  assert.equal(context.sourceStartFailures.size, 0, 'and the same for the two source regions')
  assert.equal(context.pendingRuntimeStops.length, 0,
    'a deferred stop waiting on a runtime this teardown closed has nothing left to wait for')
})

/**
 * The Max gate follows the manifest the HOST loaded, not the file on disk.
 *
 * This plugin rewrites `manifest.json` at the end of every load, so the file is one
 * generation ahead of what the host is actually sizing requests against. Reading it
 * back would open Max mode the moment a window was saved - billed on the larger
 * tier's terms for room this session never uses - and close it again whenever a
 * directory function failed. `getManifest()` is what the host holds.
 */
test('the published window is read from the manifest the host loaded', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const context = vm.createContext({
    pi: {
      plugin: {
        // The host's copy: the model is at its default tier.
        getManifest: () => ({
          contributes: {
            providers: [{
              id: 'plugin:test:trae-cn',
              models: [{ id: 'm-1', contextWindow: 200000 }, { id: 'm-2', contextWindow: 256000 }],
            }],
          },
        }),
      },
    },
    // Deliberately disagreeing with the host: the file has since been rewritten
    // with the Max tier, and reading it would report the wider window.
    readManifest: () => ({
      contributes: {
        providers: [{ id: 'plugin:test:trae-cn', models: [{ id: 'm-1', contextWindow: 1000000 }] }],
      },
    }),
    manifestProviders: () => [{ id: 'plugin:test:trae-cn', models: [{ id: 'm-1', contextWindow: 1000000 }] }],
    positiveInteger: (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback),
    hostPublishedWindows: null,
  })
  const capture = vm.runInContext(`(${entryFunctions(['captureHostWindows'], source).replace(/^function captureHostWindows/, 'function captureHostWindows')})`, context)
  capture()
  vm.runInContext('hostWindowOf = ' + entryFunctions(['hostWindowOf'], source).replace('function hostWindowOf', 'function hostWindowOf'), context)
  assert.equal(context.hostWindowOf('plugin:test:trae-cn', 'm-1'), 200000,
    'the host holds the default tier, so that is the window Max mode is measured against')
  assert.equal(context.hostWindowOf('plugin:test:trae-cn', 'm-2'), 256000)
  assert.equal(context.hostWindowOf('plugin:test:trae-cn', 'gone'), undefined,
    'a model the host does not hold has no published window')
  assert.equal(context.hostWindowOf('plugin:test:trae-ai', 'm-1'), undefined,
    'and neither does a provider it does not hold')
})
