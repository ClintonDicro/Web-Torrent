/* Download service worker.
 *
 * Streams a finished file from the page to the browser's download manager, so large
 * files never have to be held in memory as one Blob. The page registers a one-time
 * token plus a MessagePort; a request to /__download/<token>/<name> then pulls the
 * file chunk by chunk through that port.
 *
 * Security: responses are always attachments (never rendered), with nosniff and a
 * sandboxing CSP, so content from an untrusted torrent can never run as this site.
 * Only /__download/ requests are intercepted; everything else goes to the network.
 */
'use strict'

const pending = new Map() // token -> { port, name, size, created }
const TOKEN_RE = /^[0-9a-f]{32}$/
const MAX_AGE_MS = 60 * 1000

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('message', event => {
  const data = event.data
  const port = event.ports && event.ports[0]
  if (!data || data.type !== 'register-download' || !port) return
  if (typeof data.token !== 'string' || !TOKEN_RE.test(data.token)) return
  const now = Date.now()
  for (const [k, v] of pending) if (now - v.created > MAX_AGE_MS) pending.delete(k)
  pending.set(data.token, {
    port,
    name: String(data.name || 'download').slice(0, 200),
    size: Number.isSafeInteger(data.size) && data.size >= 0 ? data.size : null,
    created: now
  })
  port.postMessage({ type: 'registered' })
})

function contentDisposition (name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

const SAFE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer'
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__download/')) return
  const token = url.pathname.split('/')[2] || ''
  const entry = TOKEN_RE.test(token) ? pending.get(token) : undefined
  if (!entry) {
    event.respondWith(new Response('This download link has expired. Use the Save button again.', {
      status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SAFE_HEADERS }
    }))
    return
  }
  pending.delete(token) // single use
  const { port } = entry
  const stream = new ReadableStream({
    pull (controller) {
      return new Promise(resolve => {
        port.onmessage = ev => {
          const m = ev.data || {}
          if (m.type === 'chunk') controller.enqueue(new Uint8Array(m.chunk))
          else if (m.type === 'end') controller.close()
          else controller.error(new Error(m.message || 'Download failed'))
          resolve()
        }
        port.postMessage({ type: 'pull' })
      })
    },
    cancel () { port.postMessage({ type: 'cancel' }) }
  })
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(entry.name),
    ...SAFE_HEADERS
  }
  if (entry.size !== null) headers['Content-Length'] = String(entry.size)
  event.respondWith(new Response(stream, { status: 200, headers }))
})
