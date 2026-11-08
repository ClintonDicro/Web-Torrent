// Minimal static file server that applies a Cloudflare Pages `_headers` file, so
// the CSP and other headers are tested exactly as they will be deployed.
// Supports the subset of the _headers syntax this project uses: URL patterns with a
// trailing `*` splat, and `Name: value` lines.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
}

export function parseHeadersFile (text) {
  const rules = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] }
      rules.push(current)
    } else if (current) {
      const idx = raw.indexOf(':')
      if (idx > 0) current.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()])
    }
  }
  return rules
}

function matches (pattern, urlPath) {
  if (pattern.endsWith('*')) return urlPath.startsWith(pattern.slice(0, -1))
  return urlPath === pattern
}

export function startStaticServer (root, { port = 0, extraCsp = '' } = {}) {
  const headersPath = path.join(root, '_headers')
  const rules = fs.existsSync(headersPath) ? parseHeadersFile(fs.readFileSync(headersPath, 'utf8')) : []
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = path.normalize(path.join(root, urlPath))
    if (!file.startsWith(path.normalize(root))) { res.writeHead(403); return res.end() }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    const name = path.basename(file)
    if (!fs.existsSync(file) || name === '_headers' || name === '_redirects') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('Not found')
    }
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }
    for (const rule of rules) {
      if (!matches(rule.pattern, urlPath)) continue
      for (const [k, v] of rule.headers) {
        headers[k] = (k.toLowerCase() === 'content-security-policy' && extraCsp) ? `${v}; ${extraCsp}` : v
      }
    }
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })
  }))
}
