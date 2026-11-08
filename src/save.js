// Saving finished files to the user's device without loading them into memory
// whenever the browser offers a streaming option.
//
// 1. showSaveFilePicker (Chrome/Edge desktop): stream straight into the chosen file.
// 2. Download service worker (Firefox, Chrome, Edge, Safari): stream through the
//    browser's download manager.
// 3. Blob fallback (e.g. private windows where service workers are disabled):
//    loads the file into memory, so it is limited to BLOB_LIMIT bytes.
import { sanitizeFileName, safePathParts } from './lib/validate.js'

export const BLOB_LIMIT = 512 * 1024 * 1024

let swReady = null

export function registerDownloadWorker () {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  swReady = navigator.serviceWorker.register('/download-sw.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null)
  return swReady
}

function workerAvailable () {
  return !!(navigator.serviceWorker && navigator.serviceWorker.controller)
}

export function saveCapabilities () {
  return {
    savePicker: typeof window.showSaveFilePicker === 'function',
    folderPicker: typeof window.showDirectoryPicker === 'function',
    streamWorker: workerAvailable()
  }
}

/** Pick the method that will be used for a file of this size (for UI hints). */
export function saveMethodFor (size) {
  const c = saveCapabilities()
  if (c.savePicker) return 'picker'
  if (c.streamWorker) return 'stream'
  if (size <= BLOB_LIMIT) return 'blob'
  return 'none'
}

/**
 * @param {object} file  WebTorrent File (has .name, .length, .stream(), .blob())
 * @returns {Promise<'picker'|'stream'|'blob'|'cancelled'>}
 */
export async function saveFile (file) {
  const name = sanitizeFileName(file.name)
  const method = saveMethodFor(file.length)
  if (method === 'picker') {
    let handle
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name })
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'
      throw err
    }
    const writable = await handle.createWritable()
    await file.stream().pipeTo(writable)
    return 'picker'
  }
  if (method === 'stream') {
    await streamViaWorker(file, name)
    return 'stream'
  }
  if (method === 'blob') {
    const blob = await file.blob()
    const url = URL.createObjectURL(blob)
    triggerDownload(url, name)
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return 'blob'
  }
  throw new Error(`This browser cannot save a file this large (${Math.round(file.length / 1048576)} MB) without streaming support. Use Chrome or Edge, or leave private browsing mode.`)
}

function triggerDownload (href, name) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
}

function randomToken () {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function streamViaWorker (file, name) {
  const controller = navigator.serviceWorker.controller
  if (!controller) throw new Error('Download helper is not ready. Reload the page and try again.')
  const token = randomToken()
  const channel = new MessageChannel()
  const reader = file.stream().getReader()
  let finished
  const done = new Promise((resolve, reject) => { finished = { resolve, reject } })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Download helper did not respond.')), 5000)
    channel.port1.onmessage = ev => {
      if (ev.data?.type !== 'registered') return
      clearTimeout(timer)
      channel.port1.onmessage = async msg => {
        const m = msg.data || {}
        if (m.type === 'cancel') { reader.cancel().catch(() => {}); finished.reject(new Error('Download cancelled')); return }
        if (m.type !== 'pull') return
        try {
          const { value, done: end } = await reader.read()
          if (end) { channel.port1.postMessage({ type: 'end' }); finished.resolve() } else {
            const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            channel.port1.postMessage({ type: 'chunk', chunk: buf }, [buf])
          }
        } catch (err) {
          channel.port1.postMessage({ type: 'error', message: String(err?.message || err) })
          finished.reject(err)
        }
      }
      resolve()
    }
    controller.postMessage({ type: 'register-download', token, name, size: file.length }, [channel.port2])
  })
  // A navigation (hidden same-origin iframe) is always routed through the service worker;
  // an <a download> click may be fetched by the download manager directly instead.
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.setAttribute('aria-hidden', 'true')
  frame.src = `/__download/${token}/${encodeURIComponent(name)}`
  document.body.append(frame)
  done.finally(() => setTimeout(() => frame.remove(), 30_000)).catch(() => {})
  return done
}

/**
 * Chrome/Edge: write several files into a folder the user picks, keeping the
 * torrent's folder structure. Never overwrites: an existing file gets " (1)".
 * @param {Array<{file:object, path:string}>} entries
 */
export async function saveAllToFolder (entries, onProgress = () => {}) {
  const root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'torrent-save' })
  let n = 0
  for (const { file, path } of entries) {
    const parts = safePathParts(path)
    let dir = root
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
    const name = await freeName(dir, parts[parts.length - 1])
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await file.stream().pipeTo(writable)
    onProgress(++n, entries.length)
  }
  return root.name
}

async function freeName (dir, name) {
  const exists = async n => { try { await dir.getFileHandle(n); return true } catch { return false } }
  if (!(await exists(name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('Too many files with the same name in that folder.')
}
