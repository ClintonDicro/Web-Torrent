// Settings: defaults, validation and persistence in localStorage (this device only).
import { parseTrackerList } from './validate.js'

// Public WebTorrent (WebSocket) trackers. Checked reachable on 2026-11-09.
export const DEFAULT_TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.novage.com.ua'
]

// Trackers that no longer exist. Removed from saved settings and never used.
export const DEAD_TRACKERS = ['tracker.btorrent.xyz', 'tracker.fastcast.nz']
const isDead = url => DEAD_TRACKERS.some(host => { try { return new URL(url).hostname === host } catch { return false } })
const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href } catch { return false } }

export const DEFAULTS = Object.freeze({
  maxActive: 2,                 // downloads running at once; others wait in the queue
  maxTorrentsPerSession: 20,    // torrents that may be added before the page is reloaded
  maxTorrentGB: 4,              // largest selected size for one torrent
  sessionLimitGB: 10,           // total selected bytes per session
  downloadLimitKBps: 0,         // 0 = unlimited
  uploadLimitKBps: 0,
  trackers: '',                 // extra wss:// trackers chosen by the user
  useDefaultTrackers: true,     // add the WebSocket trackers above to every public torrent
  allowWebSeeds: true,          // https web seeds (server must send CORS headers)
  seedAfterComplete: false,
  stallSeconds: 60,
  autoCleanupMinutes: 30,       // free browser storage of finished+saved torrents after N idle minutes (0 = never)
  theme: 'dark',
  notifications: false,
  keepHistory: true
})

const INT = (min, max) => v => {
  if (typeof v === 'boolean' || v === '' || v === null || v === undefined) throw new Error('must be a whole number')
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error('must be a whole number')
  if (n < min || n > max) throw new Error(`must be between ${min} and ${max}`)
  return n
}
const BOOL = v => {
  if (typeof v !== 'boolean') throw new Error('must be true or false')
  return v
}

const VALIDATORS = {
  maxActive: INT(1, 5),
  maxTorrentsPerSession: INT(1, 100),
  maxTorrentGB: INT(1, 100),
  sessionLimitGB: INT(1, 500),
  downloadLimitKBps: INT(0, 1_000_000),
  uploadLimitKBps: INT(0, 1_000_000),
  trackers: v => {
    const { good, bad } = parseTrackerList(v)
    if (bad.length) throw new Error(`only secure WebSocket trackers (wss://…) work in a browser: ${bad.slice(0, 3).join(', ')}`)
    return good.join('\n')
  },
  useDefaultTrackers: BOOL,
  allowWebSeeds: BOOL,
  seedAfterComplete: BOOL,
  stallSeconds: INT(10, 3600),
  autoCleanupMinutes: INT(0, 1440),
  theme: v => { if (!['dark', 'light', 'system'].includes(v)) throw new Error('must be dark, light or system'); return v },
  notifications: BOOL,
  keepHistory: BOOL
}

export class SettingsError extends Error {
  constructor (fields) {
    super('Some settings are invalid.')
    this.fields = fields
  }
}

/** Validate a partial update. Returns clean values or throws SettingsError. */
export function validateSettings (updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new SettingsError({ _: 'invalid settings' })
  const fields = {}
  const clean = {}
  for (const [k, v] of Object.entries(updates)) {
    if (!VALIDATORS[k]) { fields[k] = 'unknown setting'; continue }
    try { clean[k] = VALIDATORS[k](v) } catch (e) { fields[k] = e.message }
  }
  if (Object.keys(fields).length) throw new SettingsError(fields)
  return clean
}

const KEY = 'btd.settings.v1'

export function loadSettings (storage = globalThis.localStorage) {
  let stored = {}
  try { stored = JSON.parse(storage?.getItem(KEY) || '{}') } catch { stored = {} }
  const out = { ...DEFAULTS }
  for (const [k, v] of Object.entries(stored || {})) {
    if (!(k in DEFAULTS)) continue
    try { out[k] = validateSettings({ [k]: v })[k] } catch { /* ignore bad stored value */ }
  }
  // Older versions stored the default list in "trackers": drop defaults and dead trackers.
  out.trackers = String(out.trackers).split('\n')
    .filter(u => u && !isDead(u) && !DEFAULT_TRACKERS.some(d => sameUrl(d, u)))
    .join('\n')
  return out
}

export function saveSettings (values, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(values)) } catch { /* private mode / quota: keep in memory */ }
}

/** Tracker list actually used: user list (+ defaults when enabled), wss only. */
export function effectiveTrackers (settings) {
  const { good } = parseTrackerList(settings.trackers)
  const all = settings.useDefaultTrackers ? [...good, ...DEFAULT_TRACKERS] : good
  return [...new Set(all)].filter(u => !isDead(u))
}
