// Input validation and sanitising for untrusted torrent data.
// Pure functions (no DOM, no WebTorrent) so they can be unit-tested in Node.

export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_MAGNET_LENGTH = 8192
export const MAX_TRACKERS = 30
export const MAX_FILES = 10_000

export class ValidationError extends Error {
  constructor (message, code = 'invalid') {
    super(message)
    this.name = 'ValidationError'
    this.code = code
  }
}

// Control characters, DEL, and bidirectional overrides that can disguise names
// (e.g. "evil‮gpj.exe" displays as "evilexe.jpg").
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g

/** Strip invisible / direction-changing characters from untrusted display text. */
export function cleanText (value, limit = 1024) {
  return String(value ?? '').replace(UNSAFE_TEXT, '').slice(0, limit)
}

// --------------------------------------------------------------------------
// Tracker / web seed URLs
// --------------------------------------------------------------------------

/**
 * Browser WebTorrent can only use WebSocket trackers. Only secure wss:// URLs are
 * accepted: ws:// would be blocked as mixed content on an https site anyway.
 * Returns a normalised URL string, or null if unusable.
 */
export function safeTrackerUrl (raw) {
  let url
  try { url = new URL(String(raw).trim()) } catch { return null }
  if (url.protocol !== 'wss:') return null
  if (url.username || url.password) return null
  if (!url.hostname || url.hostname.length > 253) return null
  url.hash = ''
  const s = url.toString()
  return s.length <= 500 ? s : null
}

/** Web seeds (BEP 19) must be https:// and the server must allow CORS. */
export function safeWebSeedUrl (raw) {
  let url
  try { url = new URL(String(raw).trim()) } catch { return null }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || !url.hostname) return null
  url.hash = ''
  const s = url.toString()
  return s.length <= 1000 ? s : null
}

/** Split tracker URLs into ones a browser can use and ones it cannot. */
export function classifyTrackers (list) {
  const usable = []
  const unusable = []
  for (const raw of list || []) {
    const ok = safeTrackerUrl(raw)
    if (ok) { if (!usable.includes(ok) && usable.length < MAX_TRACKERS) usable.push(ok) } else unusable.push(cleanText(raw, 200))
  }
  return { usable, unusable }
}

// --------------------------------------------------------------------------
// Magnet links
// --------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32ToHex (s) {
  let bits = ''
  for (const ch of s.toUpperCase()) {
    const v = BASE32.indexOf(ch)
    if (v < 0) return null
    bits += v.toString(2).padStart(5, '0')
  }
  let hex = ''
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex.slice(0, 40)
}

/**
 * Parse and validate a magnet link. Never passes the user's string through:
 * returns a rebuilt, minimal magnet URI with only safe parameters.
 *
 * Kept: xt (info hash), dn (display name), tr (wss trackers only), ws (https web seeds).
 * Dropped: xs/as/kt/x.pe and anything else (would make the browser fetch arbitrary URLs).
 */
export function parseMagnet (input) {
  const text = String(input ?? '').trim()
  if (!text) throw new ValidationError('Paste a magnet link.', 'empty')
  if (text.length > MAX_MAGNET_LENGTH) throw new ValidationError('Magnet link is too long.', 'too_long')
  if (!/^magnet:\?/i.test(text)) throw new ValidationError('That is not a magnet link (it must start with "magnet:?").', 'not_magnet')

  let params
  try {
    params = new URLSearchParams(text.slice(text.indexOf('?') + 1))
  } catch {
    throw new ValidationError('The magnet link is malformed.', 'malformed')
  }

  let infoHash = null
  let infoHashV2 = null
  for (const xt of params.getAll('xt')) {
    const v1 = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(xt)
    if (v1 && !infoHash) {
      infoHash = v1[1].length === 40 ? v1[1].toLowerCase() : base32ToHex(v1[1])
      continue
    }
    const v2 = /^urn:btmh:1220([0-9a-fA-F]{64})$/.exec(xt)
    if (v2 && !infoHashV2) infoHashV2 = v2[1].toLowerCase()
  }
  if (!infoHash && !infoHashV2) {
    throw new ValidationError('The magnet link has no valid BitTorrent info hash (xt=urn:btih:…).', 'no_infohash')
  }
  if (!infoHash) {
    throw new ValidationError('BitTorrent v2-only magnet links (urn:btmh) are not supported by WebTorrent.', 'v2_only')
  }

  const name = cleanText(params.get('dn') || '', 300)
  const trackers = classifyTrackers(params.getAll('tr'))
  const webSeeds = []
  let droppedWebSeeds = 0
  for (const ws of params.getAll('ws')) {
    const ok = safeWebSeedUrl(ws)
    if (ok && webSeeds.length < 10) webSeeds.push(ok); else droppedWebSeeds++
  }

  return {
    infoHash,
    name,
    trackers: trackers.usable,
    unusableTrackers: trackers.unusable,
    webSeeds,
    droppedWebSeeds,
    magnetURI: buildMagnet({ infoHash, name, trackers: trackers.usable, webSeeds })
  }
}

/**
 * Build a magnet URI. `xt` must stay literal ("urn:btih:<hash>"): WebTorrent's parser
 * does not percent-decode it. Other values are percent-encoded.
 */
export function buildMagnet ({ infoHash, name = '', trackers = [], webSeeds = [] }) {
  if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new ValidationError('Invalid info hash.', 'no_infohash')
  const parts = [`xt=urn:btih:${infoHash}`]
  if (name) parts.push(`dn=${encodeURIComponent(name)}`)
  for (const tr of trackers) parts.push(`tr=${encodeURIComponent(tr)}`)
  for (const ws of webSeeds) parts.push(`ws=${encodeURIComponent(ws)}`)
  return `magnet:?${parts.join('&')}`
}

// --------------------------------------------------------------------------
// File names and paths
// --------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
// eslint-disable-next-line no-control-regex
const RESERVED_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Make a single file name safe to save on Windows, macOS, Linux, Android, iOS.
 * Removes path separators, reserved characters, invisible/bidi characters,
 * trailing dots/spaces and reserved device names. Keeps the extension when trimming.
 */
export function sanitizeFileName (raw, fallback = 'download') {
  let name = cleanText(raw, 1000).replace(RESERVED_CHARS, '_').replace(/[. ]+$/g, '').trim()
  name = name.replace(/^\.+/, '') // no hidden / relative names like "..", ".bashrc"
  if (!name) name = fallback
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  if (name.length > 180) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
    name = name.slice(0, 180 - ext.length) + ext
  }
  return name
}

/**
 * Validate a torrent-relative path ("Album/disc1/a.mp3"). Rejects absolute paths,
 * drive letters, "." / ".." components and empty components.
 * Returns the cleaned component list.
 */
export function safePathParts (path) {
  const text = String(path ?? '')
  if (!text || text.includes('\u0000')) throw new ValidationError('Empty or invalid file path in torrent.', 'unsafe_path')
  if (/^([a-zA-Z]:|[\\/])/.test(text)) throw new ValidationError('Torrent contains an absolute file path.', 'unsafe_path')
  const parts = text.split(/[\\/]/)
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new ValidationError('Torrent contains an unsafe file path.', 'unsafe_path')
  }
  return parts.map(p => sanitizeFileName(p, '_'))
}

/**
 * The torrent name becomes a folder name in browser storage ("<name> - <hash>"), so it
 * must be a single, valid path component.
 */
export function assertSafeTorrentName (name) {
  const n = String(name ?? '')
  if (!n || n === '.' || n === '..' || /[/\\\u0000]/.test(n)) {
    throw new ValidationError('The torrent name contains characters that cannot be used as a folder name.', 'unsafe_name')
  }
  return n
}

// --------------------------------------------------------------------------
// Settings-style helpers
// --------------------------------------------------------------------------

export function parseTrackerList (text) {
  const lines = String(text ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  const good = []
  const bad = []
  for (const l of lines) {
    const ok = safeTrackerUrl(l)
    if (ok) { if (!good.includes(ok)) good.push(ok) } else bad.push(cleanText(l, 200))
  }
  return { good: good.slice(0, MAX_TRACKERS), bad }
}
