import { describe, expect, it } from 'vitest'
import magnetDecode from 'magnet-uri'
import {
  ValidationError, assertSafeTorrentName, cleanText, classifyTrackers, parseMagnet, parseTrackerList, safePathParts,
  safeTrackerUrl, safeWebSeedUrl, sanitizeFileName
} from '../../src/lib/validate.js'

const HASH = 'c9e15763f722f23e98a29decdfae341b98d53056'

describe('magnet validation', () => {
  it('accepts a normal magnet and rebuilds it with only safe parameters', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Cosmos+Laundromat&tr=wss%3A%2F%2Ftracker.webtorrent.dev&tr=udp%3A%2F%2Ftracker.example.org%3A1337&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=http%3A%2F%2Fevil.example%2Fx.torrent&as=http%3A%2F%2Fevil.example%2F`)
    expect(m.infoHash).toBe(HASH)
    expect(m.name).toBe('Cosmos Laundromat')
    expect(m.trackers).toEqual(['wss://tracker.webtorrent.dev/'])
    expect(m.unusableTrackers).toEqual(['udp://tracker.example.org:1337'])
    expect(m.webSeeds).toEqual(['https://webtorrent.io/torrents/'])
    expect(m.magnetURI).not.toMatch(/xs=|as=|evil|udp/)
    expect(m.magnetURI.startsWith(`magnet:?xt=urn:btih:${HASH}&dn=Cosmos%20Laundromat`)).toBe(true)
  })

  it('produces magnets that the WebTorrent magnet parser (magnet-uri) reads back identically', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent('Name & "quotes" ü')}&tr=wss%3A%2F%2Ft.example%2Fa%3Fb%3D1&ws=https%3A%2F%2Fcdn.example%2Ff%20g`)
    const d = magnetDecode(m.magnetURI)
    expect(d.infoHash).toBe(HASH)
    expect(d.name).toBe('Name & "quotes" ü')
    expect(d.announce).toEqual(['wss://t.example/a?b=1'])
    expect(d.urlList).toEqual(['https://cdn.example/f%20g'])
  })

  it('accepts base32 info hashes', () => {
    // base32 of the same 20 bytes
    const b32 = 'ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW' // cross-checked with magnet-uri
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32}`).infoHash).toBe(HASH)
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://example.com/file.torrent', 'not_magnet'],
    ['javascript:alert(1)', 'not_magnet'],
    ['magnet:?dn=no-hash', 'no_infohash'],
    ['magnet:?xt=urn:btih:1234', 'no_infohash'],
    ['magnet:?xt=urn:btih:' + 'g'.repeat(40), 'no_infohash'],
    ['magnet:?xt=urn:btmh:1220' + 'a'.repeat(64), 'v2_only'],
    ['magnet:?xt=urn:btih:' + HASH + '&dn=' + 'x'.repeat(9000), 'too_long']
  ])('rejects %j (%s)', (input, code) => {
    expect(() => parseMagnet(input)).toThrow(ValidationError)
    try { parseMagnet(input) } catch (e) { expect(e.code).toBe(code) }
  })

  it('strips control and bidi characters from the display name', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${HASH}&dn=` + encodeURIComponent('evil\u202Egpj.exe\u0007<img src=x>'))
    expect(m.name).toBe('evilgpj.exe<img src=x>')
  })

  it('never keeps more than the tracker limit and drops duplicates', () => {
    const tr = Array.from({ length: 40 }, (_, i) => `&tr=wss://t${i}.example`).join('') + '&tr=wss://t0.example'
    expect(parseMagnet(`magnet:?xt=urn:btih:${HASH}${tr}`).trackers.length).toBe(30)
  })
})

describe('tracker and web seed URLs', () => {
  it('only allows wss:// trackers without credentials', () => {
    expect(safeTrackerUrl('wss://tracker.example:8443/announce')).toBe('wss://tracker.example:8443/announce')
    for (const bad of ['ws://tracker.example', 'udp://t:1', 'http://t/announce', 'https://t', 'wss://user:pw@t.example', 'javascript:alert(1)', 'not a url']) {
      expect(safeTrackerUrl(bad)).toBeNull()
    }
  })
  it('only allows https web seeds', () => {
    expect(safeWebSeedUrl('https://cdn.example/files/')).toBe('https://cdn.example/files/')
    expect(safeWebSeedUrl('http://cdn.example/')).toBeNull()
    expect(safeWebSeedUrl('file:///C:/x')).toBeNull()
  })
  it('classifies tracker lists and parses the settings textarea', () => {
    expect(classifyTrackers(['wss://a.example', 'udp://b:1']).unusable).toEqual(['udp://b:1'])
    const r = parseTrackerList('wss://a.example\n  wss://a.example , http://bad\n')
    expect(r.good).toEqual(['wss://a.example/'])
    expect(r.bad).toEqual(['http://bad'])
  })
})

describe('file names and paths', () => {
  it.each([
    ['normal.mkv', 'normal.mkv'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['C:\\Windows\\evil.dll', 'C__Windows_evil.dll'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['trailing dots...  ', 'trailing dots'],
    ['.hidden', 'hidden'],
    ['..', 'download'],
    ['', 'download'],
    ['evil\u202Egpj.exe', 'evilgpj.exe'],
    ['tab\tname\n.txt', 'tabname.txt']
  ])('sanitizeFileName(%j) -> %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected)
  })

  it('keeps the extension when trimming long names', () => {
    const out = sanitizeFileName('a'.repeat(300) + '.mp4')
    expect(out.length).toBe(180)
    expect(out.endsWith('.mp4')).toBe(true)
  })

  it('accepts safe torrent paths and rejects traversal/absolute ones', () => {
    expect(safePathParts('Album/disc1/01 Song.mp3')).toEqual(['Album', 'disc1', '01 Song.mp3'])
    expect(safePathParts('Album\\cover.jpg')).toEqual(['Album', 'cover.jpg'])
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '\\\\server\\share', 'a//b', './x', '']) {
      expect(() => safePathParts(bad)).toThrow(ValidationError)
    }
  })

  it('rejects torrent names that cannot be a folder name', () => {
    expect(assertSafeTorrentName('Album 2024')).toBe('Album 2024')
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '</b>', 'x\u0000y']) expect(() => assertSafeTorrentName(bad)).toThrow(ValidationError)
  })

  it('cleanText limits length', () => {
    expect(cleanText('x'.repeat(2000), 10)).toHaveLength(10)
    expect(cleanText(null)).toBe('')
  })
})
