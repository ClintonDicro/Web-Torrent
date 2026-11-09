// Maps the raw state of a task to the status shown in the UI. Pure function.

export const STATUS_LABELS = {
  preview: 'Waiting for confirmation',
  queued: 'Queued',
  checking_metadata: 'Fetching metadata',
  finding_peers: 'Finding peers',
  downloading: 'Downloading',
  paused: 'Paused',
  stalled: 'Stalled',
  completed: 'Completed',
  seeding: 'Seeding',
  error: 'Error'
}

/**
 * @param {object} s
 * @param {string|null} s.error        fatal error message
 * @param {boolean} s.confirmed        user clicked Download
 * @param {boolean} s.queued           waiting for a free slot
 * @param {boolean} s.hasMetadata      file list known
 * @param {boolean} s.paused           paused by the user
 * @param {boolean} s.complete         every selected file fully downloaded and verified
 * @param {boolean} s.uploading        still connected and sharing after completion
 * @param {number}  s.numPeers
 * @param {number}  s.secondsWithoutProgress
 * @param {number}  s.stallTimeout     seconds
 */
export function computeStatus (s) {
  if (s.error) return 'error'
  if (!s.confirmed) return s.hasMetadata ? 'preview' : 'checking_metadata'
  if (s.complete) return s.uploading ? 'seeding' : 'completed'
  if (s.queued) return 'queued'
  if (s.paused) return 'paused'
  if (!s.hasMetadata) return 'checking_metadata'
  if (s.secondsWithoutProgress > s.stallTimeout) return 'stalled'
  if (s.numPeers === 0) return 'finding_peers'
  return 'downloading'
}

/** Is this status counted against the "max active downloads" limit? */
export function isActive (status) {
  return ['checking_metadata', 'finding_peers', 'downloading', 'stalled'].includes(status)
}

const SEARCH_GRACE_SECONDS = 15

/**
 * Explain why a download is not progressing (shown under the progress bar). Pure function.
 * @param {object} s
 * @param {string} s.status
 * @param {number} s.numPeers
 * @param {number} s.secondsSearching    since the download (or metadata fetch) started
 * @param {number} s.ownWssTrackers      WebSocket trackers listed by the torrent itself
 * @param {number} s.legacyTrackers      UDP/HTTP trackers listed by the torrent (unusable in browsers)
 * @param {number} s.trackersTotal       WebSocket trackers in use (own + defaults + extra)
 * @param {number} s.trackersFailed      how many of those could not be reached
 */
export function peerHint (s) {
  if (!['finding_peers', 'stalled', 'checking_metadata'].includes(s.status)) return null
  if (s.trackersTotal > 0 && s.trackersFailed >= s.trackersTotal) {
    return 'Cannot reach any WebSocket tracker. Check your internet connection, firewall or VPN, or add other wss:// trackers in Settings.'
  }
  if (s.numPeers === 0 && s.secondsSearching >= SEARCH_GRACE_SECONDS) {
    if (s.ownWssTrackers === 0 && s.legacyTrackers > 0) {
      return 'No browser peers found. This torrent only lists UDP/HTTP trackers, so it is almost certainly shared only by desktop BitTorrent clients, which a browser cannot connect to. It can only download here if someone shares it over WebRTC.'
    }
    return 'No WebRTC peers found yet. Only WebTorrent (browser-compatible) peers can connect, and nobody may be sharing this torrent that way right now.'
  }
  if (s.status === 'stalled') return 'No data received recently. Peers may have left, or none are reachable over WebRTC.'
  return null
}
