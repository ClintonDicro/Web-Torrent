import { describe, expect, it } from 'vitest'
import { computeStatus, isActive, STATUS_LABELS } from '../../src/lib/status.js'
import { LimitError, checkNewDownload } from '../../src/lib/limits.js'
import { DEFAULTS, DEFAULT_TRACKERS, SettingsError, effectiveTrackers, loadSettings, saveSettings, validateSettings } from '../../src/lib/settings.js'
import { clearHistory, loadHistory, recordHistory } from '../../src/lib/history.js'
import { formatBytes, formatEta, formatRate } from '../../src/lib/format.js'

const base = {
  error: null, confirmed: true, queued: false, hasMetadata: true, paused: false, complete: false,
  uploading: false, numPeers: 2, secondsWithoutProgress: 0, stallTimeout: 60
}

describe('status (progress updates)', () => {
  it.each([
    [{}, 'downloading'],
    [{ numPeers: 0 }, 'finding_peers'],
    [{ secondsWithoutProgress: 61 }, 'stalled'],
    [{ hasMetadata: false }, 'checking_metadata'],
    [{ confirmed: false, hasMetadata: false }, 'checking_metadata'],
    [{ confirmed: false }, 'preview'],
    [{ queued: true }, 'queued'],
    [{ paused: true }, 'paused'],
    [{ complete: true }, 'completed'],
    [{ complete: true, uploading: true }, 'seeding'],
    [{ error: 'boom', complete: true }, 'error']
  ])('%j -> %s', (patch, expected) => {
    expect(computeStatus({ ...base, ...patch })).toBe(expected)
    expect(STATUS_LABELS[expected]).toBeTruthy()
  })

  it('never reports completed for an incomplete or failed torrent', () => {
    expect(computeStatus({ ...base, complete: false, numPeers: 0, secondsWithoutProgress: 9999 })).toBe('stalled')
    expect(computeStatus({ ...base, complete: true, error: 'x' })).toBe('error')
  })

  it('counts only transferring states as active', () => {
    expect(isActive('downloading')).toBe(true)
    expect(isActive('queued')).toBe(false)
    expect(isActive('completed')).toBe(false)
  })
})

describe('per-session limits', () => {
  const s = { ...DEFAULTS }
  const GB = 1024 ** 3
  it('allows a normal download', () => {
    expect(() => checkNewDownload({ settings: s, selectedBytes: GB, sessionCount: 0, sessionBytes: 0, storageFree: 5 * GB })).not.toThrow()
  })
  it.each([
    [{ selectedBytes: 0 }, 'empty_selection'],
    [{ sessionCount: 20 }, 'session_count'],
    [{ selectedBytes: 5 * GB }, 'torrent_size'],
    [{ selectedBytes: 2 * GB, sessionBytes: 9 * GB }, 'session_bytes'],
    [{ selectedBytes: 2 * GB, storageFree: GB }, 'storage']
  ])('blocks %j (%s)', (patch, code) => {
    const args = { settings: s, selectedBytes: GB, sessionCount: 0, sessionBytes: 0, storageFree: null, ...patch }
    expect(() => checkNewDownload(args)).toThrow(LimitError)
    try { checkNewDownload(args) } catch (e) { expect(e.code).toBe(code) }
  })
})

describe('settings', () => {
  it('validates values and reports every bad field', () => {
    expect(validateSettings({ maxActive: 3, theme: 'light', seedAfterComplete: true })).toEqual({ maxActive: 3, theme: 'light', seedAfterComplete: true })
    try {
      validateSettings({ maxActive: 0, theme: 'pink', trackers: 'udp://x:1', bogus: 1, seedAfterComplete: 'yes' })
      throw new Error('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError)
      expect(Object.keys(e.fields).sort()).toEqual(['bogus', 'maxActive', 'seedAfterComplete', 'theme', 'trackers'])
    }
  })

  it('persists to storage and ignores tampered values', () => {
    const mem = new Map()
    const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) }
    saveSettings({ ...DEFAULTS, maxActive: 4 }, storage)
    expect(loadSettings(storage).maxActive).toBe(4)
    mem.set('btd.settings.v1', JSON.stringify({ maxActive: 999, theme: '<script>', __proto__: { polluted: 1 } }))
    const loaded = loadSettings(storage)
    expect(loaded.maxActive).toBe(DEFAULTS.maxActive)
    expect(loaded.theme).toBe(DEFAULTS.theme)
    expect({}.polluted).toBeUndefined()
    mem.set('btd.settings.v1', '{not json')
    expect(loadSettings(storage)).toEqual({ ...DEFAULTS })
  })

  it('builds the tracker list from user + default WebSocket trackers', () => {
    expect(effectiveTrackers({ trackers: 'wss://mine.example', useDefaultTrackers: false })).toEqual(['wss://mine.example/'])
    expect(effectiveTrackers({ trackers: '', useDefaultTrackers: true })).toEqual(DEFAULT_TRACKERS)
  })
})

describe('history and formatting', () => {
  it('records, caps and clears history', () => {
    const mem = new Map()
    const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) }
    for (let i = 0; i < 210; i++) recordHistory({ infoHash: String(i), name: `n${i}‮`, size: i, addedAt: i }, storage)
    const h = loadHistory(storage)
    expect(h).toHaveLength(200)
    expect(h[0].name).toBe('n209')
    clearHistory(storage)
    expect(loadHistory(storage)).toEqual([])
  })

  it('formats sizes, rates and ETAs', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatRate(2048)).toBe('2.0 KB/s')
    expect(formatEta(null)).toBe('∞')
    expect(formatEta(59)).toBe('59s')
    expect(formatEta(3725)).toBe('1h 2m')
  })
})
