// Post-build checks: is dist/ ready for Cloudflare Pages Direct Upload?
// Limits (Cloudflare Pages, free plan): max 20,000 files per deployment, max 25 MiB per file.
import fs from 'node:fs'
import path from 'node:path'
import { parseHeadersFile } from '../tests/support/static-server.mjs'

const dist = path.resolve('dist')
const errors = []
const files = []
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p); else files.push({ rel: path.relative(dist, p).replace(/\\/g, '/'), size: fs.statSync(p).size })
  }
}
if (!fs.existsSync(dist)) { console.error('dist/ does not exist'); process.exit(1) }
walk(dist)

const MAX_FILES = 20000
const MAX_FILE = 25 * 1024 * 1024
if (files.length > MAX_FILES) errors.push(`too many files: ${files.length} > ${MAX_FILES}`)
for (const f of files) if (f.size > MAX_FILE) errors.push(`file too large for Pages: ${f.rel} (${f.size} bytes)`)
for (const need of ['index.html', '_headers', 'download-sw.js', 'icon.svg']) {
  if (!files.some(f => f.rel === need)) errors.push(`missing ${need}`)
}
for (const f of files) {
  if (/\.map$|(^|\/)\.env|\.pem$|\.key$/.test(f.rel)) errors.push(`should not be deployed: ${f.rel}`)
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>/g)]
if (inlineScripts.length) errors.push('index.html contains inline <script> blocks (blocked by the CSP)')
if (/\son[a-z]+="/i.test(html)) errors.push('index.html contains inline event handlers (blocked by the CSP)')
if (/\sstyle="/i.test(html)) errors.push('index.html contains inline style attributes (blocked by the CSP)')

const rules = parseHeadersFile(fs.readFileSync(path.join(dist, '_headers'), 'utf8'))
const global = rules.find(r => r.pattern === '/*')
const csp = global?.headers.find(([k]) => k.toLowerCase() === 'content-security-policy')?.[1] || ''
for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
  if (!csp.includes(d)) errors.push(`CSP missing ${d}`)
}
if (/unsafe-inline|unsafe-eval/.test(csp)) errors.push('CSP must not allow unsafe-inline / unsafe-eval')

// Secrets: nothing that looks like a key or token in the shipped JS.
for (const f of files.filter(x => /\.(js|html|css)$/.test(x.rel))) {
  const text = fs.readFileSync(path.join(dist, f.rel), 'utf8')
  if (/(api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i.test(text)) errors.push(`possible secret in ${f.rel}`)
}

const total = files.reduce((a, f) => a + f.size, 0)
console.log(`dist: ${files.length} files, ${(total / 1024).toFixed(0)} KiB total, largest ${Math.max(...files.map(f => f.size))} bytes`)
for (const f of files.sort((a, b) => b.size - a.size)) console.log(`  ${String(f.size).padStart(9)}  ${f.rel}`)
if (errors.length) {
  console.error('\nDist check FAILED:\n - ' + errors.join('\n - '))
  process.exit(1)
}
console.log('\nDist check passed: ready for Cloudflare Pages Direct Upload.')
