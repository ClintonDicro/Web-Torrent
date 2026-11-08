// Parsing and validating .torrent files locally (nothing is uploaded anywhere).
import parseTorrent, { toTorrentFile } from 'parse-torrent'
import {
  MAX_FILES, MAX_TORRENT_FILE_BYTES, ValidationError, assertSafeTorrentName, classifyTrackers, cleanText,
  safePathParts, safeWebSeedUrl
} from './validate.js'

/**
 * Return a copy of the torrent without web seeds (url-list / httpseeds).
 * The info dictionary is untouched, so the info hash stays the same.
 */
export async function stripWebSeeds (bytes) {
  const parsed = await parseTorrent(bytes)
  parsed.urlList = []
  return toTorrentFile(parsed)
}

/**
 * @param {Uint8Array} bytes   raw .torrent contents
 * @param {string} [fileName]  original file name (for the extension check)
 * @returns {Promise<object>}  summary used by the preview
 */
export async function parseTorrentFile (bytes, fileName) {
  if (fileName !== undefined && !/\.torrent$/i.test(String(fileName))) {
    throw new ValidationError('Only .torrent files are accepted.', 'invalid_extension')
  }
  if (!(bytes instanceof Uint8Array)) throw new ValidationError('Could not read the file.', 'unreadable')
  if (bytes.length === 0) throw new ValidationError('The file is empty.', 'empty_file')
  if (bytes.length > MAX_TORRENT_FILE_BYTES) {
    throw new ValidationError('Torrent file is too large (limit 10 MB).', 'file_too_large')
  }
  if (bytes[0] !== 0x64 /* 'd' */) throw new ValidationError('The file is not a valid torrent.', 'not_bencode')

  let parsed
  try {
    parsed = await parseTorrent(bytes)
  } catch (err) {
    throw new ValidationError(`The file is not a valid torrent (${cleanText(err?.message || err, 120)}).`, 'corrupt')
  }
  if (!parsed || !parsed.infoHash || !Array.isArray(parsed.files)) {
    throw new ValidationError('The file is not a valid torrent (missing info dictionary).', 'corrupt')
  }
  if (parsed.files.length === 0 || !(parsed.length > 0)) {
    throw new ValidationError('The torrent contains no files.', 'no_files')
  }
  if (parsed.files.length > MAX_FILES) {
    throw new ValidationError(`The torrent has too many files (limit ${MAX_FILES}).`, 'too_many_files')
  }

  assertSafeTorrentName(parsed.name)
  const files = parsed.files.map((f, index) => {
    const parts = safePathParts(f.path) // throws on traversal / absolute paths
    return {
      index,
      path: parts.join('/'),
      name: parts[parts.length - 1],
      length: f.length,
      offset: f.offset
    }
  })

  const trackers = classifyTrackers(parsed.announce)
  const webSeeds = (parsed.urlList || []).map(safeWebSeedUrl).filter(Boolean).slice(0, 10)

  return {
    infoHash: String(parsed.infoHash).toLowerCase(),
    name: cleanText(parsed.name || files[0].name, 300),
    length: parsed.length,
    pieceLength: parsed.pieceLength,
    pieceCount: parsed.pieces?.length || 0,
    private: !!parsed.private,
    comment: cleanText(parsed.comment || '', 500),
    createdBy: cleanText(parsed.createdBy || '', 200),
    files,
    trackers: trackers.usable,
    unusableTrackers: trackers.unusable,
    webSeeds
  }
}

/** Summarise a WebTorrent torrent object after its metadata arrived (magnet flow). */
export function summarizeLiveTorrent (torrent) {
  assertSafeTorrentName(torrent.name)
  const files = torrent.files.map((f, index) => {
    const parts = safePathParts(f.path)
    return { index, path: parts.join('/'), name: parts[parts.length - 1], length: f.length, offset: f.offset }
  })
  if (files.length > MAX_FILES) throw new ValidationError('The torrent has too many files.', 'too_many_files')
  const trackers = classifyTrackers(torrent.announce)
  return {
    infoHash: torrent.infoHash,
    name: cleanText(torrent.name, 300),
    length: torrent.length,
    pieceLength: torrent.pieceLength,
    pieceCount: torrent.pieces?.length || 0,
    private: !!torrent.private,
    comment: cleanText(torrent.comment || '', 500),
    createdBy: cleanText(torrent.createdBy || '', 200),
    files,
    trackers: trackers.usable,
    unusableTrackers: trackers.unusable,
    webSeeds: (torrent.urlList || []).map(safeWebSeedUrl).filter(Boolean)
  }
}
