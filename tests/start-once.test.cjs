'use strict'

/**
 * Two callers that reach one region at the same moment must share one bind.
 *
 * A rescan and the refresh pass can both find a region with no runtime. Before
 * the shared promise, each reserved the preferred port and bound its own shim:
 * the second lost the bind and recorded a start failure for a region that was
 * actually serving, and the panel then read address drift over a healthy
 * gateway.
 *
 * The repair has a second half that these cases pin: whichever caller resolves
 * second must not release the runtime the first one registered. "A runtime is
 * already in the map" was read as "mine is not wanted", which is also true of
 * the winner, so the gateway that had just started was closed and a stopped
 * object stayed in the map for every later pass to skip.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

/** One top-level function's body, cut at its own closing brace. */
function bodyOf(name) {
  const start = source.search(new RegExp('^(async )?function ' + name + '\\(', 'm'))
  assert.ok(start >= 0, `main.js no longer defines ${name}`)
  const rest = source.slice(start + 1)
  const end = rest.search(/^\}/m)
  return source.slice(start, start + 1 + end + 1)
}

/** A context holding just the pieces these two functions touch. */
function loadStarted(runtimes) {
  const stops = []
  const context = vm.createContext({
    runtimes,
    gatewayStartFailures: new Map(),
    stopRuntime: async (runtime) => {
      stops.push(runtime)
      runtime.stopped = true
    },
  })
  vm.runInContext([bodyOf('startRuntimeOnce'), bodyOf('settleStartedRuntime')].join('\n'), context)
  return { context, stops }
}

test('both callers of one region share one bind and one gateway', async () => {
  const sourceRuntimes = new Map()
  let binds = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const runtimeStarts = new Map()
  const { context, stops } = loadStarted(sourceRuntimes)
  const late = { region: 'cn' }
  context.runtimeStarts = runtimeStarts
  context.createRuntime = () => {
    binds += 1
    return gate.then(() => late)
  }

  const first = context.startRuntimeOnce('cn')
  const second = context.startRuntimeOnce('cn')
  assert.equal(first, second, 'both callers get one in-flight promise, not two binds')
  assert.equal(binds, 1, 'exactly one bind was started')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b, 'and both callers are handed the same runtime')

  // Whichever order the two callers resume in, the region keeps the gateway and
  // neither closes it.
  assert.equal(await context.settleStartedRuntime('cn', a, false), true)
  assert.equal(await context.settleStartedRuntime('cn', b, false), true)
  assert.equal(sourceRuntimes.get('cn'), a, 'the region keeps the runtime that was registered')
  assert.deepEqual(stops, [], 'nothing was released: the two callers shared one gateway')
  assert.equal(a.stopped, undefined, 'the gateway is still up')
  assert.equal(runtimeStarts.has('cn'), false, 'the in-flight entry is cleaned up')
})

test('a runtime one caller already released is never adopted back', async () => {
  // The other resolution order: one caller's activation ended, so it releases
  // the shared runtime; the second caller must not then put that closed gateway
  // in the map. `runtimes.has` is every pass's only re-entry test, so a stopped
  // entry would take the region out for the rest of the activation.
  const { context, stops } = loadStarted(new Map())
  const runtime = { region: 'cn' }
  assert.equal(await context.settleStartedRuntime('cn', runtime, true), false, 'the release is the answer')
  assert.deepEqual(stops, [runtime], 'and it is closed exactly once')
  assert.equal(await context.settleStartedRuntime('cn', runtime, false), false,
    'a later caller cannot adopt a runtime that is already down')
  assert.deepEqual(stops, [runtime], 'without closing it twice')
  assert.equal(context.runtimes.has('cn'), false, 'and the region is left empty for a rebuild')
})

test('a released runtime outranks a stale generation, so a reload keeps its gateway', async () => {
  // A teardown clears the map and bumps the generation; the gateways survive a
  // reload in this host, so a bind an older activation started can still be
  // adopted by the newer one. The older caller then arrives with a stale
  // generation - and must not close what is now serving.
  const runtimes = new Map()
  const { context, stops } = loadStarted(runtimes)
  const shared = { region: 'cn' }
  assert.equal(await context.settleStartedRuntime('cn', shared, false), true, 'the newer caller adopts it')
  assert.equal(runtimes.get('cn'), shared)
  assert.equal(await context.settleStartedRuntime('cn', shared, true), true,
    'the older caller, whose generation is now stale, still finds it wanted')
  assert.deepEqual(stops, [], 'and leaves the gateway running')
  assert.equal(runtimes.get('cn'), shared, 'the region keeps serving')
})

test('a start that settles after a teardown cannot remove the newer start', async () => {
  // The identity check in `startRuntimeOnce`'s cleanup: a teardown clears the
  // whole map, so an older in-flight start settling afterwards must not delete
  // the entry a newer activation has already put there - deleting it would let a
  // third caller bind the same region a second time.
  const runtimeStarts = new Map()
  const { context } = loadStarted(new Map())
  const gates = []
  let binds = 0
  context.runtimeStarts = runtimeStarts
  context.createRuntime = () => {
    binds += 1
    return new Promise((resolve) => gates.push(() => resolve({ region: 'cn', bind: binds })))
  }

  const older = context.startRuntimeOnce('cn')
  runtimeStarts.clear()
  const newer = context.startRuntimeOnce('cn')
  assert.notEqual(older, newer, 'the clear means the newer activation binds on its own')
  assert.equal(binds, 2)

  gates[0]()
  await older
  assert.equal(runtimeStarts.get('cn'), newer,
    'the older start settling left the newer one in the map')
  gates[1]()
  await newer
  assert.equal(runtimeStarts.has('cn'), false, 'and the newer one cleans itself up')
})

test('a bind that fails is not cached, and both callers see one failure', async () => {
  // The port race the comment on `startRuntimeOnce` names: `createRuntime`
  // rejects. The in-flight entry still has to be dropped, or every later pass
  // would keep replaying the same rejection instead of retrying the bind.
  const runtimeStarts = new Map()
  const { context } = loadStarted(new Map())
  let binds = 0
  let fail
  context.runtimeStarts = runtimeStarts
  context.createRuntime = () => {
    binds += 1
    return new Promise((_resolve, reject) => { fail = () => reject(new Error('the preferred port is held')) })
  }

  const first = context.startRuntimeOnce('cn')
  const second = context.startRuntimeOnce('cn')
  assert.equal(first, second, 'one bind, so one failure')
  fail()
  await assert.rejects(first, /preferred port/)
  await assert.rejects(second, /preferred port/)
  assert.equal(binds, 1)
  assert.equal(runtimeStarts.has('cn'), false, 'the failed start is not left in the map')

  // And the next attempt really starts a new bind.
  context.createRuntime = () => {
    binds += 1
    return Promise.resolve({ region: 'cn' })
  }
  await context.startRuntimeOnce('cn')
  assert.equal(binds, 2, 'a retry binds again rather than replaying the rejection')
})

test('an unwanted binding is closed without touching the runtime that holds the region', async () => {
  // The two release reasons in one call: this caller's activation is gone, and the
  // region is already served by another runtime. The binding is closed so its port
  // comes back, and the map keeps the winner - a release must never clear an entry
  // somebody else registered.
  const winner = { region: 'cn' }
  const orphan = { region: 'cn' }
  const { context, stops } = loadStarted(new Map([['cn', winner]]))
  assert.equal(await context.settleStartedRuntime('cn', orphan, true), false)
  assert.deepEqual(stops, [orphan], 'the orphan is closed, not left bound')
  assert.equal(context.runtimes.get('cn'), winner, 'and the region still serves from the winner')
})

test('a runtime that lost the region is released, and one nobody wants too', async () => {
  // The control. The ownership check must not turn into "never release": a bind
  // that lost this region to a different runtime holds a port nobody will free,
  // and a bind whose activation is gone is in the same position.
  const winner = { region: 'cn' }
  const loser = { region: 'cn' }
  const { context, stops } = loadStarted(new Map([['cn', winner]]))
  assert.equal(await context.settleStartedRuntime('cn', loser, false), false, 'the loser is not adopted')
  assert.deepEqual(stops, [loser], 'and it is closed so its port comes back')
  assert.equal(loser.stopped, true)
  assert.equal(await context.settleStartedRuntime('cn', winner, false), true,
    'the winner stays, even though the map already held it')

  const { context: fresh, stops: freshStops } = loadStarted(new Map())
  const unwanted = { region: 'cn' }
  assert.equal(await fresh.settleStartedRuntime('cn', unwanted, true), false,
    'a runtime whose activation is gone is not adopted even into an empty map')
  assert.deepEqual(freshStops, [unwanted])
  assert.equal(fresh.runtimes.has('cn'), false, 'and it never enters the map')
})
