// Per-session limits. A "session" is one page load: nothing persists after reload.

const GB = 1024 ** 3

export class LimitError extends Error {
  constructor (message, code) {
    super(message)
    this.code = code
  }
}

/**
 * Check whether a new download may start.
 * @param {object} p
 * @param {object} p.settings
 * @param {number} p.selectedBytes      bytes the user selected in this torrent
 * @param {number} p.sessionCount       torrents already confirmed this session
 * @param {number} p.sessionBytes       bytes already selected this session
 * @param {number|null} p.storageFree   free browser storage (null = unknown / not used)
 */
export function checkNewDownload ({ settings, selectedBytes, sessionCount, sessionBytes, storageFree }) {
  if (!(selectedBytes > 0)) throw new LimitError('Select at least one file.', 'empty_selection')
  if (sessionCount >= settings.maxTorrentsPerSession) {
    throw new LimitError(`Session limit reached: at most ${settings.maxTorrentsPerSession} torrents per session. Reload the page to start a new session.`, 'session_count')
  }
  if (selectedBytes > settings.maxTorrentGB * GB) {
    throw new LimitError(`This selection is larger than the ${settings.maxTorrentGB} GB per-torrent limit (see Settings).`, 'torrent_size')
  }
  if (sessionBytes + selectedBytes > settings.sessionLimitGB * GB) {
    throw new LimitError(`Session limit reached: at most ${settings.sessionLimitGB} GB per session (see Settings).`, 'session_bytes')
  }
  if (storageFree !== null && storageFree !== undefined && selectedBytes > storageFree) {
    throw new LimitError('Not enough browser storage for this download. Choose "Folder on this device" (Chrome/Edge), select fewer files, or free up disk space.', 'storage')
  }
}
