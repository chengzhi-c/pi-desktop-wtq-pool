/**
 * Qoder sign-ins on macOS: the Keychain reader and the AES-128-CBC blob.
 *
 * macOS keeps no `os_crypt` wrapper in `Local State`, so the Windows DPAPI
 * chain answered every installed-and-signed-in app with
 * `unsupported-platform` and the Qoder sources never found an account. The
 * macOS reader instead pulls the OSCrypt password from the login Keychain
 * (`/usr/bin/security find-generic-password`) and decrypts the blob with the
 * Chromium-on-macOS scheme: PBKDF2-HMAC-SHA1(salt `saltysalt`, 1003
 * iterations) to a 16-byte key, then AES-128-CBC under a fixed IV.
 *
 * The Keychain read is the stubbed seam (the one that would need the installed
 * app and a logged-in user); the derivation, the CBC decrypt and the session
 * parse are the real code. `platform: 'darwin'` keeps the whole case runnable
 * on any machine.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createCipheriv, pbkdf2Sync } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readQoderCredential, resetQoderCredentialCache } = require('../lib/qoder-credentials')
const { decryptQoderOscryptMac, qoderStorageCandidates } = require('../lib/qoder-discovery')

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function sealMacBlob(plaintext, key) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

test('decryptQoderOscryptMac opens a macOS blob and rejects the rest', () => {
  const key = pbkdf2Sync('fixture-password', 'saltysalt', 1003, 16, 'sha1')
  const blob = sealMacBlob('x'.repeat(48), key)
  assert.equal(decryptQoderOscryptMac(blob, key), 'x'.repeat(48), 'the sealed payload round-trips')
  assert.equal(decryptQoderOscryptMac(blob, pbkdf2Sync('other', 'saltysalt', 1003, 16, 'sha1')), undefined,
    'a wrong key fails the padding check rather than returning noise')
  assert.equal(decryptQoderOscryptMac(Buffer.concat([Buffer.from('v11'), blob.subarray(3)]), key), undefined,
    'an unknown version prefix is refused')
})

test('a macOS sign-in is read through the pinned Keychain helper', async () => {
  const temporary = scratch('wtq-qoder-macos-')
  const childProcess = require('node:child_process')
  const realSpawn = childProcess.spawn
  const password = 'keychain-password-fixture'
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const blob = sealMacBlob(JSON.stringify({ token: 'qoder-mac-token', user: { id: 'mac-user-1' } }), key)
  let spawnFile
  let spawnArguments
  childProcess.spawn = (file, args) => {
    spawnFile = file
    spawnArguments = args
    const fake = new EventEmitter()
    fake.stdout = new EventEmitter()
    fake.stdout.setEncoding = () => {}
    fake.stderr = new EventEmitter()
    fake.stderr.setEncoding = () => {}
    fake.kill = () => {}
    fake.stdin = { on: () => {}, end: () => {} }
    // The reader attaches its stdout listener before this tick runs.
    process.nextTick(() => {
      fake.stdout.emit('data', `${password}\n`)
      fake.emit('close', 0)
    })
    return fake
  }
  try {
    // A named home keeps the case off the machine it runs on; `platform` is
    // injected so the macOS reader runs on any test host.
    const candidates = qoderStorageCandidates('darwin', temporary)
    const auth = candidates.find(candidate => candidate.kind === 'auth-v1' && candidate.region === 'cn')
    fs.mkdirSync(path.dirname(auth.path), { recursive: true })
    fs.writeFileSync(auth.path, blob)
    fs.writeFileSync(path.join(auth.appDir, 'auth.machine-id'), 'mac-machine-id\n')
    const group = candidates.filter(candidate => candidate.appDir === auth.appDir)
    resetQoderCredentialCache()
    const result = await readQoderCredential(group, { platform: 'darwin' })
    assert.equal(result.credential?.token, 'qoder-mac-token', 'the macOS reader must open the session')
    assert.equal(result.credential?.userID, 'mac-user-1')
    assert.equal(result.credential?.machineID, 'mac-machine-id')
    assert.equal(spawnFile, '/usr/bin/security', 'the Keychain helper must be pinned, not PATH-resolved')
    assert.equal(spawnArguments.includes('Qoder CN App Safe Storage'), true,
      'the CN service name is asked first')
    assert.equal(spawnArguments.includes('-w'), true, 'the password is requested, not the item metadata')
  } finally {
    childProcess.spawn = realSpawn
    resetQoderCredentialCache()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('a denied Keychain answers no-key instead of failing the scan', async () => {
  const temporary = scratch('wtq-qoder-macos-denied-')
  const childProcess = require('node:child_process')
  const realSpawn = childProcess.spawn
  childProcess.spawn = () => {
    const fake = new EventEmitter()
    fake.stdout = new EventEmitter()
    fake.stdout.setEncoding = () => {}
    fake.stderr = new EventEmitter()
    fake.stderr.setEncoding = () => {}
    fake.kill = () => {}
    fake.stdin = { on: () => {}, end: () => {} }
    // `security` exits non-zero when the user denies the prompt or the item is
    // missing; either way there is no password to derive from.
    process.nextTick(() => fake.emit('close', 51))
    return fake
  }
  try {
    const candidates = qoderStorageCandidates('darwin', temporary)
    const auth = candidates.find(candidate => candidate.kind === 'auth-v1' && candidate.region === 'cn')
    fs.mkdirSync(path.dirname(auth.path), { recursive: true })
    fs.writeFileSync(auth.path, Buffer.concat([Buffer.from('v10'), Buffer.alloc(64)]))
    const group = candidates.filter(candidate => candidate.appDir === auth.appDir)
    resetQoderCredentialCache()
    const result = await readQoderCredential(group, { platform: 'darwin' })
    assert.equal(result.failure?.reason, 'no-key', 'a denied Keychain is a reason, not an exception')
    assert.equal(result.failure?.message.includes('Keychain'), true,
      'the message points the user at the Keychain, not at a stack trace')
  } finally {
    childProcess.spawn = realSpawn
    resetQoderCredentialCache()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
