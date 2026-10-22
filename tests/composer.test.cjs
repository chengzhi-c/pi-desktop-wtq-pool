'use strict'

/**
 * The composer readout, driven the way the renderer drives it.
 *
 * The host prints the selected model on its own chip and the extension hands
 * that text back, so this is the only handle the plugin gets on the current
 * selection: `onRendererCall` resolves it against the labels it published. A
 * break here is invisible to the chat itself and shows up only as a missing
 * balance beside the composer, which is why it is worth a case of its own.
 *
 * Two WorkBuddy regions publish the same catalog, so the fixture reproduces the
 * collision that once left every shared label unresolved - the readout stayed
 * silent for the models a user is most likely to pick.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.join(__dirname, '..')

/**
 * The part of the entry these cases drive, cut the way the suite does elsewhere.
 *
 * `manifestProviders` stands in for the declaration the host was handed, which
 * is what a chip text is resolved against.
 */
function loadComposer(providers) {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const named = /^function ([A-Za-z_$][\w$]*)\(/gm
  const names = []
  let match = named.exec(source)
  while (match !== null) {
    names.push(match[1])
    match = named.exec(source)
  }
  const wanted = ['composerModels', 'composerChipText', 'composerChipTextOf', 'composerChipTexts',
    'matchComposerModel', 'composerPointsEnabled', 'composerPoints', 'routeOfProviderId']
  const bodies = wanted.map((name) => {
    if (!names.includes(name)) throw new Error(`main.js no longer defines ${name}`)
    const start = source.search(new RegExp(`^function ${name}\\(`, 'm'))
    const rest = source.slice(start + 1)
    const end = rest.search(/^\}/m)
    return source.slice(start, start + 1 + end + 1)
  })
  const context = vm.createContext({
    manifestProviders: () => providers,
    PROVIDER_ID_BY_REGION: { cn: 'xdpool-cn', global: 'xdpool-global' },
    TRAE_PROVIDER_ID_BY_REGION: { cn: 'xdpool-trae-cn', ai: 'xdpool-trae-ai' },
    QODER_PROVIDER_ID_BY_REGION: { cn: 'xdpool-qoder-cn', global: 'xdpool-qoder-global' },
    REGIONS: ['cn', 'global'], TRAE_REGIONS: ['cn', 'ai'], QODER_REGIONS: ['cn', 'global'],
    settings: { showComposerPoints: true },
    workbuddyComposerAccounts: () => [],
    sourceComposerAccounts: () => [],
    probesStale: () => false,
    scheduleRefresh: () => {},
  })
  vm.runInContext(bodies.join('\n'), context)
  return context
}

/**
 * The matcher and the chip-text set on their own declaration.
 *
 * `loadEntry` serves both regions one offline catalog, so every id it publishes is
 * shared. This builds the shape the real declaration has - a model each pool serves
 * alone beside one they both serve - so the id rule can be checked at all.
 */
function loadMatcher(providers) {
  const context = loadComposer(providers)
  return {
    match: (chip) => context.matchComposerModel(chip),
    texts: (chip) => context.composerChipTexts().has(String(chip).trim().toLowerCase()),
  }
}

/**
 * A label two pools both publish answers nothing.
 *
 * The tags in the declaration keep this from happening, but a manifest written
 * before they existed, or one whose labels were edited by hand, still carries
 * the same name for two pools. Picking either one would put one account group's
 * balance beside the other's model, which is the failure this whole path is
 * shaped to avoid, so the row is dropped instead.
 */
test('a label two pools both publish resolves to neither of them', () => {
  const shared = {
    id: 'xdpool-cn', models: [{ id: 'step-5-preview', name: 'Step-5-Preview \u00b7 x0.00' }],
  }
  const same = {
    id: 'xdpool-global', models: [{ id: 'step-5-preview', name: 'Step-5-Preview \u00b7 x0.00' }],
  }
  const context = loadComposer([shared, same])
  assert.equal(context.matchComposerModel('Step-5-Preview \u00b7 x0.00'), undefined,
    'an ambiguous label resolves to no row, so no balance can be shown against the wrong pool')
  // Nothing can ever resolve this text, so the readout is told it is not ours and
  // stops asking rather than polling for a name that will always be ambiguous.
  assert.equal(context.composerChipTexts().has('step-5-preview \u00b7 x0.00'), false,
    'an ambiguous label is not offered as ours')
  // The control: one pool alone owns the name, and then it does resolve.
  const alone = loadComposer([shared])
  assert.equal(alone.matchComposerModel('Step-5-Preview \u00b7 x0.00')?.region, 'cn',
    'a label one pool publishes resolves to it')
})

/** A host just real enough for the entry to load, with one fixture sign-in. */
function loadEntry(settings) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-composer-'))
  const dataPath = path.join(temporary, 'data')
  const own = path.join(dataPath, 'signins')
  fs.mkdirSync(own, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.contributes) manifest.contributes.providers = []
  fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const authFile = path.join(own, 'workbuddy-desktop.info')
  const credential = (uin, domain) => JSON.stringify({
    auth: {
      accessToken: 'fixture-token', refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600_000, domain,
    },
    account: { uin, nickname: 'Fixture' },
  })
  fs.writeFileSync(authFile, credential('90000000031', 'www.codebuddy.cn'))
  // The second region is what makes the two published rosters overlap, which is
  // the shape the real declaration has.
  fs.writeFileSync(path.join(own, 'workbuddy-global.info'), credential('90000000032', 'www.codebuddy.ai'))

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
        getSettings: async () => ({ ...settings, authFile }),
        setSettings: async () => {},
        getDataPath: async () => dataPath,
        getManifest: async () => ({ contributes: { providers: [] } }),
      },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: () => {} },
      events: { on: () => {}, off: () => {} },
      ui: { showToast: async () => {} },
      clipboard: { writeText: async () => '' },
      shell: { openExternal: async () => {} },
    },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context)
  return { plugin: context.module.exports, manifestPath: path.join(temporary, 'manifest.json') }
}

/**
 * The labels the host will print on its chip, one per published model.
 *
 * `alias` first, exactly as the host reads it: it prints `alias || id`, so a
 * declaration that tags only `name` leaves the chip showing a bare model id and
 * the readout nothing to look up.
 */
function publishedLabels(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const labels = []
  for (const provider of manifest.contributes?.providers ?? []) {
    for (const model of provider.models ?? []) {
      const alias = typeof model.alias === 'string' ? model.alias.trim() : ''
      labels.push(alias !== '' ? alias : String(model.id))
    }
  }
  return labels
}

/** Models whose declaration has no alias for the chip to print. */
function modelsWithoutAlias(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const missing = []
  for (const provider of manifest.contributes?.providers ?? []) {
    for (const model of provider.models ?? []) {
      const alias = typeof model.alias === 'string' ? model.alias.trim() : ''
      if (alias === '') missing.push(`${provider.id}/${model.id}`)
    }
  }
  return missing
}

test('every published model label resolves to one pool, so the readout can answer', async () => {
  const { plugin, manifestPath } = loadEntry({
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    distribution: 'priority', cooldownSeconds: 60, authFile: '', showComposerPoints: true,
  })
  assert.equal(typeof plugin.onRendererCall, 'function',
    'the composer talks to this entry through onRendererCall; without it the chip can never appear')
  await plugin.onLoad()
  try {
    // The panel is what makes the entry publish a declaration, and it is the
    // declaration the host reads the chip text from.
    await plugin.onPanelInvoke('xd.state', {})
    const labels = publishedLabels(manifestPath)
    assert.ok(labels.length > 0, 'the fixture must publish at least one model')
    // The chip prints the alias, so a model published without one shows its bare
    // id and answers nothing.
    assert.deepEqual(modelsWithoutAlias(manifestPath), [],
      'every published model needs an alias for the chip to print')
    const folded = labels.map((label) => label.trim().toLowerCase())
    const repeated = folded.filter((label, index) => folded.indexOf(label) !== index)
    assert.deepEqual(repeated, [],
      'a label two providers both publish leaves the chip unable to name either of them')
    // Both regions publish one catalog, so the shared names carry their region.
    assert.ok(folded.some((label) => label.endsWith('(cn)')) && folded.some((label) => label.endsWith('(global)')),
      'the names both WorkBuddy regions serve name the region they came from')

    for (const label of labels) {
      const answer = await plugin.onRendererCall('xd.composerPoints', { chip: label })
      assert.equal(answer?.show, true,
        `${JSON.stringify(label)} is published, so the readout has to answer for it (got ${JSON.stringify(answer)})`)
      // Cache-first: the first poll answers with no number and starts the read
      // that later polls fill in, so `null` here is the answer, not a failure.
      assert.ok(answer.total === null || typeof answer.total === 'number',
        'a balance is a number once it has been read, and null until then')
      assert.ok(Array.isArray(answer.accounts) && answer.accounts.length > 0,
        'with the accounts behind it, for the popup')
      // The tag in the text is the only thing that says which pool the balance
      // belongs to, so it has to agree with the row the answer came from. This
      // is what would catch the two provider ids being swapped in the tables.
      if (label.endsWith('(Global)')) assert.equal(answer.region, 'global', `${label} names the international pool`)
      if (label.endsWith('(CN)')) assert.equal(answer.region, 'cn', `${label} names the domestic pool`)
    }

    const foreign = await plugin.onRendererCall('xd.composerPoints', { chip: 'not-a-model-of-ours' })
    assert.equal(foreign?.show, false, 'a model this pool does not publish shows nothing rather than a made-up figure')
    assert.equal(foreign?.ours, false, 'and says it is not this plugin\'s, so the readout stops asking')

    // The switch the panel writes is the one this path reads.
    await plugin.onPanelInvoke('xd.setComposerPoints', { enabled: false })
    const off = await plugin.onRendererCall('xd.composerPoints', { chip: labels[0] })
    assert.equal(off?.show, false, 'with the setting off the readout is hidden, not merely empty')
  } finally {
    await plugin.onUnload()
  }
})

/**
 * A name two pools both serve, with its tag removed.
 *
 * The host re-imports an alias when the declaration changes, but until it does
 * the chip can print a spelling the declaration no longer uses. That text names
 * no single pool, so the readout has to answer nothing rather than pick one: a
 * balance shown against the wrong account group is worse than no balance.
 */
test('a chip showing the model id still answers, unless two pools share that id', async () => {
  // The host prints `alias || id`, so a chip carries the id until the alias has
  // been imported. An id only one pool publishes is as good an answer as its
  // label; one both regions publish names neither, exactly like a shared name.
  const { plugin, manifestPath } = loadEntry({
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    distribution: 'priority', cooldownSeconds: 60, authFile: '', showComposerPoints: true,
  })
  await plugin.onLoad()
  try {
    await plugin.onPanelInvoke('xd.state', {})
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const published = (manifest.contributes?.providers ?? []).flatMap((provider) =>
      (provider.models ?? []).map((model) => ({ provider: provider.id, id: String(model.id) })))
    const sharedId = published.find((row, index) =>
      published.findIndex((other) => other.id === row.id) !== index)?.id
    assert.equal(typeof sharedId, 'string', 'the fixture must publish an id from both regions')
    const shared = await plugin.onRendererCall('xd.composerPoints', { chip: sharedId })
    assert.equal(shared?.show, false,
      `${JSON.stringify(sharedId)} belongs to two pools, so it must not answer with either balance`)
    assert.equal(shared?.ours, true, 'but it is still this plugin\'s model')

    // The offline fixture serves both regions the same catalog, so every id here is
    // shared. A unique one is the real world's common case and is covered directly
    // against the matcher, where a declaration can be built by hand.
    const resolver = loadMatcher([
      { id: 'xdpool-cn', models: [{ id: 'cn-only-model', name: 'CN only' }, { id: 'both-model', name: 'Both' }] },
      { id: 'xdpool-global', models: [{ id: 'global-only-model', name: 'Global only' }, { id: 'both-model', name: 'Both' }] },
    ])
    assert.equal(resolver.match('cn-only-model')?.region, 'cn',
      'the host prints the id until it has imported the alias, so a unique id has to answer')
    assert.equal(resolver.match('global-only-model')?.region, 'global', 'and it has to name the right pool')
    assert.equal(resolver.match('both-model'), undefined,
      'an id two pools publish names neither of them')
    assert.equal(resolver.texts('cn-only-model'), true, 'a unique id keeps the readout polling')
    assert.equal(resolver.texts('both-model'), false, 'a shared id does not')
  } finally {
    await plugin.onUnload()
  }
})

test('an untagged spelling of a shared name answers nothing', async () => {
  const { plugin, manifestPath } = loadEntry({
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    distribution: 'priority', cooldownSeconds: 60, authFile: '', showComposerPoints: true,
  })
  await plugin.onLoad()
  try {
    await plugin.onPanelInvoke('xd.state', {})
    const labels = publishedLabels(manifestPath)
    const tagged = labels.find((label) => label.endsWith('(CN)'))
    assert.equal(typeof tagged, 'string', 'the fixture must publish a tagged label')
    const bare = tagged.replace(/ \(CN\)$/, '')
    const answer = await plugin.onRendererCall('xd.composerPoints', { chip: bare })
    assert.equal(answer?.show, false,
      `${JSON.stringify(bare)} names both pools, so it must not answer with either balance`)
    // It is still this plugin's model, so the readout keeps its fast cadence
    // instead of stopping for good.
    assert.equal(answer?.ours, true, 'the readout is told the name is ours and still coming')
    assert.equal(answer?.enabled, true, 'and that the feature itself is on')
  } finally {
    await plugin.onUnload()
  }
})
