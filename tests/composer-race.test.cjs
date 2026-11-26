const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const file = ts.createSourceFile('composer.mjs', fs.readFileSync(path.join(__dirname, '../renderer/composer.mjs'), 'utf8'), ts.ScriptTarget.Latest, true)
const component = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'ComposerPoints').getText(file)

function fixture() {
  const latest = { show: true, source: 'workbuddy', region: 'cn', total: 1000, accounts: [] }
  const states = ['model-a', latest, true, {}, '', '', false]
  const refs = []
  const effects = []
  let stateIndex, refIndex, tree, picked
  const requests = []
  const context = vm.createContext({
    React: { createElement: (tag, props, ...children) => ({ tag, props, children }) },
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial } },
    useEffect(effect) { effects.push(effect) },
    currentLocale: () => 'en', words: () => ({ refused: 'refused', saved: 'saved', unavailable: 'unavailable' }),
    chipText: data => String(data.total), accountTable: (_h, _data, pick) => { picked = pick; return null },
    host: { dispatch: (_channel, request) => request.method === 'xd.composerPoints' ? Promise.resolve(latest)
      : new Promise((resolve, reject) => requests.push({ resolve, reject, request: JSON.parse(JSON.stringify(request)) })) },
    REFRESH_INTERVAL_MS: 300000, WARMUP_INTERVAL_MS: 5000, WARMUP_WINDOW_MS: 120000,
    setTimeout: () => 1, clearTimeout() {},
  })
  vm.runInContext(component, context)
  function render(chip = states[0]) {
    states[0] = chip
    stateIndex = 0
    refIndex = 0
    effects.length = 0
    tree = context.ComposerPoints()
  }
  render()
  return {
    states, latest, render, requests,
    resolve: (value, index = 0) => requests[index].resolve(value),
    reject: error => requests[0].reject(error),
    refresh: () => tree.children[1].children[0].children[1].props.onClick(),
    pick: () => picked({ id: 'other-account', label: 'Shared name' }),
    open() { render(); tree.children[0].props.onClick(); render() },
    changeModel(chip) { render(chip); effects[1]() },
  }
}

test('PI composer submits the selected account ID', async () => {
  const view = fixture()
  view.pick()
  assert.deepEqual(view.requests[0].request, {
    method: 'xd.composerPrefer',
    args: { chip: 'model-a', source: 'workbuddy', region: 'cn', accountId: 'other-account' },
  })
  view.resolve({ saved: true, show: true, total: 1000 })
  await new Promise(setImmediate)
})

for (const action of ['refresh', 'pick']) {
  for (const failed of [false, true]) {
    test(`PI composer ignores an old ${action} ${failed ? 'failure' : 'answer'} after switching away and back`, async () => {
      const view = fixture()
      view[action]()
      view.render('model-b')
      view.render('model-a')
      if (failed) view.reject(new Error('old failure'))
      else view.resolve({ show: true, saved: true, total: 1 })
      await new Promise(setImmediate)
      assert.equal(view.states[1], view.latest, 'the older action must not replace the current balance')
      assert.equal(view.states[4], '', 'the older failure must not appear on the new selection')
    })
  }
}

test('PI composer releases refresh state on a model change and ignores the old completion', async () => {
  const view = fixture()
  view.refresh()
  assert.equal(view.states[6], true)
  view.changeModel('model-b')
  assert.equal(view.states[6], false, 'the new selection can refresh without waiting for the old one')
  await new Promise(setImmediate)
  view.open()
  view.refresh()
  assert.equal(view.states[6], true)
  view.resolve({ show: true, total: 1 })
  await new Promise(setImmediate)
  assert.equal(view.states[6], true, 'the older completion must not clear the newer refresh state')
  view.resolve({ show: true, total: 2000 }, 1)
  await new Promise(setImmediate)
  assert.equal(view.states[6], false)
})
