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
