// Serve this repository over http://127.0.0.1 so the preview page opens in a
// browser. The preview fetches the panel markup it mounts (browsers block that
// under file://) and the panel's own CSP admits scripts only from its own
// origin; an http origin satisfies both.
//
//   node docs/serve.cjs            # then open the printed URL
//   node docs/serve.cjs 8123       # pick the port
//
// Read-only, and bound to 127.0.0.1.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.argv[2] || 8123)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // The preview page lives in docs/, so '/' redirects into it: the page's
  // relative links (./preview-panel.html, ../renderer/panel.js) resolve against
  // the URL, and a rewritten body under the wrong path would 404 every one.
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/docs/index.html' }).end()
    return
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const file = path.resolve(ROOT, rel)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel)
      return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body)
  })
}).listen(PORT, '127.0.0.1', function () {
  console.log('preview: http://127.0.0.1:' + this.address().port + '/  (Ctrl+C to stop)')
})
