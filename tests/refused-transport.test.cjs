const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

require('./ts-loader.cjs')

const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
const { QoderUpstreamClient } = require('../src/qoder-client.ts')

const body = JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hi' }] })
const clients = {
  workbuddy(fetchImpl) {
    return new WorkBuddyUpstreamClient({ fetchImpl }).chatStream({
      accessToken: 'fixture', refreshToken: '', domain: 'www.codebuddy.cn', expiresAtMs: 0,
    }, body)
  },
  trae(fetchImpl) {
    return new TraeSoloUpstreamClient({
      fetchImpl,
      credential: async () => ({ accessToken: 'fixture', userId: 'fixture', edition: 'cn', source: 'desktop' }),
      identity: async () => ({ machineId: 'fixture', deviceId: 'fixture', platform: 'win32' }),
    }).chatStream(body)
  },
  qoder(fetchImpl) {
    return new QoderUpstreamClient({
      fetchImpl, region: 'cn', credential: async () => ({ userID: 'fixture', token: 'fixture' }),
    }).chatStream(body, 'fixture')
  },
}

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('refused transport remained open')), 1000) }),
    ])
  } finally { clearTimeout(timer) }
}

for (const [name, open] of Object.entries(clients)) {
  test(`${name} closes a refused HTTP transport while the host captures a clone`, async () => {
    let captured, onClose
    const closed = new Promise(resolve => { onClose = resolve })
    const server = createServer((_req, res) => {
      res.on('close', onClose)
      res.writeHead(429, { 'content-type': 'text/plain' })
      // Exceed every client's error-body bound, then keep the connection open.
      res.write('rate limited ' + 'x'.repeat(10_000))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const result = await open(async (_url, init) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, init)
        captured = response.clone().text().then(() => {}, () => {})
        return response
      })
      assert.equal(result.ok, false)
      assert.equal(result.status, 429)
      assert.match(result.message, /^rate limited /)
      await within(captured)
      await within(closed)
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await captured
    }
  })
}
