// Download history kept only in this browser (localStorage). Can be turned off or cleared.
import { cleanText } from './validate.js'

const KEY = 'btd.history.v1'
const MAX = 200

export function loadHistory (storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(KEY) || '[]')
    return Array.isArray(list) ? list.slice(0, MAX) : []
  } catch {
    return []
  }
}

export function recordHistory (entry, storage = globalThis.localStorage) {
  const list = loadHistory(storage).filter(e => !(e.infoHash === entry.infoHash && e.addedAt === entry.addedAt))
  list.unshift({
    infoHash: String(entry.infoHash || '').slice(0, 64),
    name: cleanText(entry.name, 300),
    size: Number(entry.size) || 0,
    addedAt: Number(entry.addedAt) || Date.now(),
    completedAt: entry.completedAt || null,
    outcome: cleanText(entry.outcome || '', 40)
  })
  try { storage?.setItem(KEY, JSON.stringify(list.slice(0, MAX))) } catch { /* quota / private mode */ }
  return list
}

export function clearHistory (storage = globalThis.localStorage) {
  try { storage?.removeItem(KEY) } catch { /* ignore */ }
}
