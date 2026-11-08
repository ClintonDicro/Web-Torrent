import { describe, expect, it } from 'vitest'
import createTorrent from 'create-torrent'
import bencode from 'bencode'
import parseTorrent from 'parse-torrent'
import { parseTorrentFile, stripWebSeeds } from '../../src/lib/torrent-file.js'
import { ValidationError } from '../../src/lib/validate.js'

function makeTorrent (input, opts = {}) {
  return new Promise((resolve, reject) => {
    createTorrent(input, { announceList: [['wss://tracker.example'], ['udp://legacy.example:6969']], ...opts }, (err, buf) => err ? reject(err) : resolve(new Uint8Array(buf)))
  })
}

const bytes = n => new Uint8Array(n).map((_, i) => (i * 31) & 255)

describe('torrent file upload parsing', () => {
  it('extracts metadata from a single-file torrent', async () => {
    const t = await makeTorrent(Object.assign(Buffer.from(bytes(70_000)), { name: 'movie.bin' }), { name: 'movie.bin', urlList: ['https://cdn.example/movie.bin'] })
    const meta = await parseTorrentFile(t, 'movie.torrent')
    expect(meta.name).toBe('movie.bin')
    expect(meta.length).toBe(70_000)
    expect(meta.files).toHaveLength(1)
    expect(meta.infoHash).toMatch(/^[0-9a-f]{40}$/)
    expect(meta.trackers).toEqual(['wss://tracker.example/'])
    expect(meta.unusableTrackers).toEqual(['udp://legacy.example:6969'])
    expect(meta.webSeeds).toEqual(['https://cdn.example/movie.bin'])
  })

  it('extracts a multi-file structure', async () => {
    const files = [
      Object.assign(Buffer.from(bytes(1000)), { name: 'a.txt', fullPath: '/Album/a.txt' }),
      Object.assign(Buffer.from(bytes(2000)), { name: 'b.bin', fullPath: '/Album/sub/b.bin' })
    ]
    const meta = await parseTorrentFile(await makeTorrent(files, { name: 'Album' }), 'album.torrent')
    expect(meta.name).toBe('Album')
    expect(meta.files.map(f => f.path).sort()).toEqual(['Album/a.txt', 'Album/sub/b.bin'])
    expect(meta.length).toBe(3000)
  })

  it.each([
    [new Uint8Array(), 'x.torrent', 'empty_file'],
    [new TextEncoder().encode('hello world'), 'x.torrent', 'not_bencode'],
    [new TextEncoder().encode('d4:spam4:eggse'), 'x.torrent', 'corrupt'],
    [new TextEncoder().encode('d8:announce3:ab'), 'x.torrent', 'corrupt'],
    [new TextEncoder().encode('d4:infod4:name1:xee'), 'x.txt', 'invalid_extension'],
    [new Uint8Array(11 * 1024 * 1024).fill(100), 'big.torrent', 'file_too_large']
  ])('rejects invalid upload #%#', async (data, name, code) => {
    await expect(parseTorrentFile(data, name)).rejects.toBeInstanceOf(ValidationError)
    await parseTorrentFile(data, name).catch(e => expect(e.code).toBe(code))
  })

  it('rejects torrents with path traversal', async () => {
    const pieces = new Uint8Array(20)
    const evil = bencode.encode({
      announce: 'wss://t.example',
      info: { name: 'evil', 'piece length': 16384, pieces, files: [{ length: 10, path: ['..', '..', 'escape.txt'] }] }
    })
    // parse-torrent itself may reject or sanitise; either way nothing unsafe gets through.
    const result = await parseTorrentFile(new Uint8Array(evil), 'evil.torrent').then(m => m, e => e)
    if (result instanceof Error) {
      expect(result).toBeInstanceOf(ValidationError)
    } else {
      for (const f of result.files) expect(f.path.split('/')).not.toContain('..')
    }
  })

  it('strips web seeds without changing the info hash', async () => {
    const t = await makeTorrent(Object.assign(Buffer.from(bytes(5000)), { name: 'x.bin' }), { name: 'x.bin', urlList: ['https://cdn.example/x.bin'] })
    const before = await parseTorrent(t)
    const stripped = await parseTorrent(await stripWebSeeds(t))
    expect(stripped.infoHash).toBe(before.infoHash)
    expect(before.urlList).toHaveLength(1)
    expect(stripped.urlList).toHaveLength(0)
  })
})
