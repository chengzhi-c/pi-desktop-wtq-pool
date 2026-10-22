'use strict'

/**
 * The contract between the panel page and this plugin's main process.
 *
 * A channel the page calls and the entry does not answer is a dead control: the
 * click does nothing and the panel says nothing, which is the hardest class of
 * bug to report. Nothing else in the suite compares the two sides, so this file
 * does, by dispatch rather than by reading the switch's labels.
 *
 * The page is also checked for the reverse: a `case` no page reaches is a
 * feature nobody can use.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.join(__dirname, '..')

/**
 * Every channel the panel page asks the host for.
 *
 * The plain form is `invoke("xd.name", …)`. Two calls pick the channel with a
 * ternary (`xd.distribution` for WorkBuddy, `xd.sourceDistribution` for the other
 * two sources), so each `invoke(` call is scanned through its first argument
 * rather than only the literal that follows the bracket.
 */
function pageChannels() {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const out = new Set()
  for (const match of source.matchAll(/\binvoke\(/g)) {
    const head = source.slice(match.index, Math.min(source.length, match.index + 240))
    for (const name of head.matchAll(/["']((?:xd\.[A-Za-z]+)|(?:app\.[A-Za-z]+)|(?:shell\.[A-Za-z]+))["']/g)) {
      out.add(name[1])
    }
  }
  return out
}

/** Every `case "…"` the entry answers. */
function entryCases() {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const out = new Set()
  for (const match of source.matchAll(/case\s+["']([^"']+)["']\s*:/g)) out.add(match[1])
  return out
}

/** The composer extension's channels, which go through the renderer relay. */
function composerChannels() {
  const source = fs.readFileSync(path.join(root, 'renderer', 'composer.mjs'), 'utf8')
  const out = new Set()
  for (const match of source.matchAll(/["'](xd\.[A-Za-z]+)["']/g)) out.add(match[1])
  return out
}

/** A host just real enough for the entry to load and answer. */
function loadEntry(settings) {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wtq-contract-'))
  const dataPath = path.join(temporary, 'data')
  fs.mkdirSync(dataPath, { recursive: true })
  // No providers declared, and no auth directory to walk: this case is about the
  // switch, not about discovery.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.contributes) manifest.contributes.providers = []
  fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  let service = null
  const handlers = new Map()
  const context = vm.createContext({
    require: createRequire(path.join(root, 'main.js')),
    module: { exports: {} },
    __dirname: temporary,
    console: { log() {}, warn() {}, error() {} },
    AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process,
    pi: {
      plugin: {
        getSettings: async () => ({ ...settings }),
        setSettings: async () => {},
        getDataPath: async () => dataPath,
        getManifest: async () => ({ contributes: { providers: [] } }),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: (entry) => { service = entry } },
      events: { on: (name, fn) => handlers.set(name, fn), off: (name) => handlers.delete(name) },
      ui: { showToast: async () => {} },
      clipboard: { writeText: async () => {} },
      shell: { openExternal: async () => {} },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  return { plugin: context.module.exports, service: () => service, temporary }
}

/** Channels the host answers itself, so the entry's switch never sees them. */
const HOST_CHANNELS = new Set(['app.getAppearance', 'shell.openExternal'])

test('every channel the panel calls is answered by the entry', async () => {
  const called = [...pageChannels()].sort()
  assert.ok(called.length > 0, 'the scan must find the panel\'s channels, or it proves nothing')
  const answered = entryCases()
  const missing = called.filter((channel) => !answered.has(channel) && !HOST_CHANNELS.has(channel))
  assert.deepEqual(missing, [],
    'a channel the page calls and the entry does not answer is a control that does nothing when clicked')
})

test('the composer extension only asks for channels the entry declares and answers', () => {
  const asked = [...composerChannels()].sort()
  assert.ok(asked.length > 0, 'the scan must find the composer\'s channels')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  const declared = new Set(manifest.rendererCallMethods ?? [])
  assert.deepEqual(asked.filter((channel) => !declared.has(channel)), [],
    'a method the renderer calls but the manifest does not declare is refused with PLUGIN_ACTION_UNDECLARED')
  // The relay reaches `onRendererCall`, not `onPanelInvoke`, so the entry's own
  // switch does not have to name them.
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  for (const channel of asked) {
    assert.ok(source.includes(`"${channel}"`) || source.includes(`'${channel}'`),
      `${channel} is declared to the host but nothing in the entry handles it`)
  }
})

test('the panel\'s check-in goes through the one pass, not a second copy of it', async () => {
  // The per-source "check in all" button used to run its own fan-out: no pause
  // between the check-in burst and the growth burst, and no record in
  // `autoCheckin.last`, so the panel's "last run" stayed on the previous pass
  // while the upstream saw two request clusters back to back.
  const host = loadEntry({
    enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false,
    distribution: 'priority', cooldownSeconds: 60, authFile: '', showComposerPoints: false,
  })
  await host.plugin.onLoad()
  try {
    const before = await host.plugin.onPanelInvoke('xd.state', {})
    assert.equal(before.autoCheckin.last, undefined, 'no pass has run yet')
    const answer = await host.plugin.onPanelInvoke('xd.checkinAll', { source: 'workbuddy' })
    assert.equal(typeof answer.claimed, 'number', 'the answer still carries the counts the panel reads')
    assert.equal(answer.state.autoCheckin.last.manual, true,
      'a check-in started from the panel has to record itself, or "last run" names an older pass')
    assert.equal(typeof answer.state.autoCheckin.last.at, 'string', 'and it has to carry the time it ran')
    const after = await host.plugin.onPanelInvoke('xd.state', {})
    assert.equal(after.autoCheckin.last.manual, true, 'the record has to survive the next document read too')
  } finally {
    await host.plugin.onUnload()
  }
})

test('no channel is answered that the panel never calls', () => {
  const called = new Set([...pageChannels(), ...composerChannels()])
  // These are reached by the composer relay and by the host, not by the panel's
  // own invoke path.
  const fromHost = new Set(['xd.composerPoints', 'xd.composerPrefer', 'xd.composerRefresh'])
  const orphans = [...entryCases()]
    .filter((channel) => channel.startsWith('xd.') && !called.has(channel) && !fromHost.has(channel))
    .sort()
  assert.deepEqual(orphans, [],
    'a channel nothing calls is a feature with no way to reach it, or a rename that missed one side')
})

test('every channel the page calls answers as the switch, not as its default', async () => {
  const host = loadEntry({
    enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false,
    distribution: 'priority', cooldownSeconds: 60, authFile: '', showComposerPoints: false,
  })
  await host.plugin.onLoad()
  try {
    for (const channel of [...pageChannels()].sort()) {
      if (HOST_CHANNELS.has(channel)) continue
      const answered = host.plugin.onPanelInvoke(channel, {})
        .then((value) => ({ reached: true, value }), (error) => ({ reached: true, error }))
      // The switch's default refuses synchronously, so a body still running
      // after a short window has already proven dispatch. Waiting for the slow
      // ones would run a real check-in pass and its pacing for no extra proof.
      const stillRunning = new Promise((resolve) => setTimeout(() => resolve({ reached: false }), 250))
      const outcome = await Promise.race([answered, stillRunning])
      if (!outcome.reached) continue
      if (outcome.error === undefined) {
        assert.notEqual(outcome.value, undefined,
          `${channel} answered with nothing, so its case body did not do its work`)
        continue
      }
      assert.doesNotMatch(String(outcome.error.message), /unsupported panel channel|unknown channel/i,
        `${channel} is called by the panel but reached the switch's default instead of its own case`)
      assert.equal(typeof outcome.error.code, 'string',
        `${channel} refused with an unstructured error, so its case body did not run`)
    }
  } finally {
    await host.plugin.onUnload()
  }
})
/**
 * Every string the panel asks for is in both languages, and every string it
 * defines is asked for.
 *
 * A missing entry is not a visible error: `t()` falls back to the key, so the
 * user reads `pool.noAccounts` in the middle of a Chinese sentence. The reverse
 * is just as invisible: an entry nothing asks for is dead weight that no case can
 * fail on, so it survives every release.
 *
 * A key counts as asked for when it appears in the panel outside the two tables,
 * or when something outside the panel drives it: the four view tabs and the four
 * footer links come from `data-` attributes in the page, and the two pack names
 * come from the host. Those three sources are read here rather than exempted by
 * hand, so the link itself is what the check verifies.
 */
test('every string the panel asks for exists in both languages', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  const tables = ['EN', 'ZH'].map((dictionary) => {
    const from = source.indexOf(`var ${dictionary} = {`)
    assert.notEqual(from, -1, `the ${dictionary} table has to be in the panel`)
    return { dictionary, body: source.slice(from, source.indexOf('\n}', from)) }
  })
  const definedIn = (body) => [...body.matchAll(/^\s*"([a-zA-Z]+\.[a-zA-Z0-9]+)":/gm)].map((match) => match[1])
  const defined = [...new Set(tables.flatMap((table) => definedIn(table.body)))]
  assert.ok(defined.length >= 150, `the panel has its tables (found ${defined.length} keys)`)

  // The keys the page drives, and the two the host names.
  const fromPage = [
    ...[...page.matchAll(/data-tab="([\w-]+)"/g)].map((match) => 'tab.' + match[1]),
    ...[...page.matchAll(/data-foot-label="([\w-]+)"/g)].map((match) => 'foot.' + match[1]),
  ]
  const fromHost = ['credits.planQuota', 'credits.addOnQuota']

  const outside = source.replace(tables[0].body, '').replace(tables[1].body, '')
  const asked = new Set([
    ...defined.filter((key) => outside.includes('"' + key + '"')),
    ...fromPage,
    ...fromHost,
  ])
  assert.ok(asked.size >= 150, `the panel asks for its strings (found ${asked.size})`)

  for (const { dictionary, body } of tables) {
    const missing = [...asked].filter((key) => !body.includes('"' + key + '"'))
    assert.deepEqual(missing, [], `${dictionary} is missing ${missing.join(', ')}`)
    const orphaned = definedIn(body).filter((key) => !asked.has(key))
    assert.deepEqual(orphaned, [], `${dictionary} defines ${orphaned.join(', ')}, which nothing asks for`)
  }
})

/**
 * The four view tabs and the four panels they switch between are wired to each
 * other, in both directions.
 *
 * A tab that names nothing, or a panel nothing names, is not visible as a break:
 * the panel still switches on click, because the switching is done in JavaScript
 * by `data-tab`. What breaks is the accessibility tree, where the four views read
 * as four unrelated regions and a screen reader cannot say which tab is showing.
 */
test('every view tab names the panel it controls, and that panel names it back', () => {
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  // The source tabs carry data-source; the four view tabs carry data-tab and
  // switch between the sections below them.
  const tabs = [...page.matchAll(/<button[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('role="tab"') && tag.includes('data-tab='))
  assert.equal(tabs.length, 4, 'the page has four view tabs')
  for (const tab of tabs) {
    const id = /id="([^"]+)"/.exec(tab)?.[1]
    const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1]
    assert.ok(id !== undefined, `a view tab needs an id so its panel can name it: ${tab}`)
    assert.ok(controls !== undefined, `a view tab has to name the panel it switches to: ${tab}`)
    const panel = new RegExp(`<section[^>]*id="${controls}"[^>]*>`).exec(page)?.[0]
    assert.ok(panel !== undefined, `aria-controls="${controls}" names no section`)
    assert.ok(panel.includes('role="tabpanel"'), `${controls} has to be a tabpanel`)
    assert.ok(panel.includes(`aria-labelledby="${id}"`), `${controls} has to name ${id} back`)
  }
})

/**
 * The connection report counts the accounts without naming them.
 *
 * `doctor.txt` is the file a user pastes into a bug report, and the panel's check
 * view shows the same text. It listed every sign-in by its display name, which is
 * a nickname and can be an email address, so the one artifact meant to leave the
 * machine carried the user's identities.
 *
 * The claim under test: the accounts row reports how many sign-ins the pool holds,
 * and neither the finding nor the report text carries a display name.
 */
test('the connection report counts the accounts without naming them', async () => {
  const accountName = 'fixture.user@example.com'
  const auth = path.join(fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || require('node:os').tmpdir(), 'wtq-doctor-')), 'auth')
  fs.mkdirSync(auth, { recursive: true })
  fs.writeFileSync(path.join(auth, 'login.info'), JSON.stringify({
    auth: { accessToken: 'test', refreshToken: '', expiresAt: Date.now() + 3600000 },
    account: { uin: 'test-user', nickname: accountName },
  }))
  const host = loadEntry({
    enabled: true,
    sourceWorkbuddy: true,
    sourceTrae: false,
    sourceQoder: false,
    disabledRegions: ['workbuddy:global'],
    authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  })
  const { WorkBuddyUpstreamClient } = require('../lib/upstream')
  const original = {
    models: WorkBuddyUpstreamClient.prototype.fetchModels,
    credits: WorkBuddyUpstreamClient.prototype.fetchCredits,
    checkin: WorkBuddyUpstreamClient.prototype.fetchCheckinStatus,
  }
  WorkBuddyUpstreamClient.prototype.fetchModels = async () => []
  WorkBuddyUpstreamClient.prototype.fetchCredits = async () => ({ total: 0, packages: [] })
  WorkBuddyUpstreamClient.prototype.fetchCheckinStatus = async () => ({ active: false })
  try {
    await host.plugin.onLoad()
    const report = await host.plugin.onPanelInvoke('xd.doctor')
    const accounts = report.findings.find((finding) => finding.id === 'accounts')
    assert.equal(accounts.detail, '1 account(s)', 'the row reports the count')
    assert.equal(report.report.includes(accountName), false,
      'and the report text, which is what doctor.txt holds, carries no display name')
  } finally {
    Object.assign(WorkBuddyUpstreamClient.prototype, {
      fetchModels: original.models, fetchCredits: original.credits, fetchCheckinStatus: original.checkin,
    })
    await host.plugin.onUnload()
    fs.rmSync(path.dirname(auth), { recursive: true, force: true })
  }
})

/**
 * The ban-risk note sits on the source tabs' line, and follows the locale.
 *
 * It warns about using any of the three sources, so it belongs beside the tab row
 * rather than anywhere the user has to scroll to find it. The markup is static,
 * so its label is written by `labelTabs` beside the footer links: markup left in
 * the page without that write ships as an empty paragraph, and a key removed from
 * a table ships as the raw key name.
 *
 * The expected text is read back out of the panel's own tables and the note is
 * driven through the panel's own `t`, so a copy here cannot drift from the ship.
 */
test('the ban-risk note reaches the panel line and both READMEs', () => {
  const panel = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')

  // The markup: one row holds the three source tabs and the note after them.
  const row = /<div class="tabs-row">([\s\S]*?)\n    <\/div>/.exec(page)?.[1]
  assert.ok(row !== undefined, 'index.html needs a row that holds the source tabs and the note')
  const tabsAt = row.indexOf('id="sourceTabs"')
  const noteAt = row.indexOf('id="riskNote"')
  assert.ok(tabsAt !== -1, 'the source tabs belong in that row')
  assert.ok(noteAt !== -1, 'and so does the risk note')
  assert.ok(noteAt > tabsAt, 'the note reads after the tabs, i.e. to their right')

  const lift = (source, name) => {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} has to be in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    return source.slice(from, index + 1)
  }
  const tableOf = (name) => {
    const head = panel.indexOf(`var ${name} = {`)
    assert.notEqual(head, -1, `the ${name} table has to be in the panel`)
    return new Function(panel.slice(head, panel.indexOf('\n}', head) + 3) + ` return ${name}`)()
  }
  const EN = tableOf('EN')
  const ZH = tableOf('ZH')
  const note = lift(panel, 'labelTabs')
  assert.ok(note.includes('$("riskNote")'), 'labelTabs has to write the note')

  for (const [name, table] of [['EN', EN], ['ZH', ZH]]) {
    const expected = table['risk.note']
    assert.equal(typeof expected, 'string', `${name} has to define risk.note`)
    assert.ok(expected.trim() !== '', `${name} risk.note must say something`)
    assert.ok(/封号|ban/i.test(expected), `${name} risk.note has to name the risk it warns about`)

    const node = { textContent: '' }
    const context = vm.createContext({
      document: { querySelectorAll: () => [], documentElement: { lang: name === 'ZH' ? 'zh-CN' : 'en' } },
      $: (id) => { assert.equal(id, 'riskNote'); return node },
      TABLE: table,
      EN,
      activeSource: 'workbuddy',
    })
    vm.runInContext(lift(panel, 't'), context)
    vm.runInContext(note, context)
    vm.runInContext('labelTabs()', context)
    assert.equal(node.textContent, expected, `${name} note has to reach the page verbatim`)
  }
  // The docs state the same risk, in the same two languages. A README that drops
  // it while the panel keeps it is a warning users only meet after installing.
  for (const [file, pattern] of [['README.md', /封号风险/], ['README.en.md', /A ban is possible/]]) {
    const readme = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(readme, pattern, `${file} has to carry the ban-risk warning`)
    // Near the top, above the first section heading: a warning below the install
    // steps is one the user reads after deciding to install.
    const firstSection = readme.search(/^## /m)
    const at = readme.search(pattern)
    assert.ok(at !== -1 && at < firstSection, `${file} has to warn before its first section`)
  }
})

/**
 * The README screenshots show the panel the repository ships now.
 *
 * `docs/preview-panel.html` mounts `renderer/index.html`, `panel.js` and
 * `panel.css` at runtime, so a capture taken from it cannot disagree with what
 * ships. What it can do is go stale: the pictures in docs/ are committed files,
 * and the panel changed under them while the README kept showing the old one.
 *
 * "Newer than" is a content question, not a file-system one: git does not carry
 * modification times, so a stamp compared against them passes on the machine that
 * took the picture and fails on a fresh clone, in either direction. The capture
 * writes the hashes of the three files it mounted into `docs/preview-capture.json`,
 * and this compares against those.
 */
test('the README screenshots show the panel the repository ships', () => {
  const shots = ['preview-pool.png', 'preview-dark.png', 'preview-models.png', 'preview-growth.png', 'preview-page.png']
  const stampAt = path.join(root, 'docs', 'preview-capture.json')
  assert.ok(fs.existsSync(stampAt), 'docs/preview-capture.json has to exist: the capture writes it')
  const stamp = JSON.parse(fs.readFileSync(stampAt, 'utf8'))
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')

  for (const file of ['renderer/index.html', 'renderer/panel.js', 'renderer/panel.css']) {
    assert.equal(stamp.rendered[file], digest(file),
      `${file} changed since the screenshots were taken: re-capture, then run node docs/stamp.cjs`)
  }
  assert.deepEqual(Object.keys(stamp.shots).sort(), [...shots].sort(),
    'the capture has to list the shots the README embeds')

  // The preview page mounts the real files rather than a copy of them, which is
  // what makes a capture trustworthy in the first place.
  const preview = fs.readFileSync(path.join(root, 'docs', 'preview-panel.html'), 'utf8')
  assert.ok(preview.includes('../renderer/index.html'), 'the preview has to mount the shipped markup')
  assert.ok(preview.includes('../renderer/panel.js'), 'and load the shipped script')
  assert.ok(preview.includes('../renderer/panel.css'), 'and the shipped stylesheet')

  for (const shot of shots) {
    const at = path.join(root, 'docs', shot)
    assert.ok(fs.existsSync(at), `docs/${shot} has to exist: the README embeds it`)
    assert.equal(stamp.shots[shot], digest('docs/' + shot),
      `docs/${shot} changed without the stamp that records what it was captured against: run node docs/stamp.cjs after re-capturing`)
  }
})
