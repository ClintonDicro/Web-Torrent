// TorrentEngine: the single owner of the WebTorrent client in this tab.
//
// Redesign notes (vs. the Python/libtorrent version):
// * No server: everything runs in the page. Peers are WebRTC only (see README).
// * Storage: WebTorrent writes into the Origin Private File System (OPFS, private to
//   this site in this browser) or, in Chrome/Edge, straight into a folder the user picks.
// * Nothing survives a reload: browser storage from earlier sessions is wiped at start.
// * Queue, stall detection, limits and completion are implemented here because
//   WebTorrent has no queue and its `done` event also fires when nothing is selected.

import { parseTorrentFile, stripWebSeeds, summarizeLiveTorrent } from './lib/torrent-file.js'
import { ValidationError, buildMagnet, cleanText, parseMagnet } from './lib/validate.js'
import { STATUS_LABELS, computeStatus, isActive } from './lib/status.js'
import { LimitError, checkNewDownload } from './lib/limits.js'
import { effectiveTrackers } from './lib/settings.js'

const PREVIEW_TTL_MS = 15 * 60 * 1000

export class EngineError extends Error {
  constructor (message, code = 'engine_error') {
    super(message)
    this.code = code
  }
}

export function friendlyError (err) {
  const name = err?.name || ''
  const msg = String(err?.message || err || 'Unknown error')
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return 'Browser storage is full. Free up disk space, remove finished downloads, or use "Folder on this device".'
  }
  if (name === 'NotAllowedError' || /permission/i.test(msg)) {
    return 'The browser no longer has permission to write to the chosen folder. Remove this download and add it again.'
  }
  if (/duplicate torrent/i.test(msg)) return 'This torrent has already been added.'
  if (/Name is not allowed|Invalid name|not a valid name/i.test(msg)) {
    return 'A file or folder name in this torrent cannot be created on this device.'
  }
  return cleanText(msg, 300)
}

const uuid = () => crypto.randomUUID()

export class TorrentEngine extends EventTarget {
  constructor ({ settings, log }) {
    super()
    this.settings = settings
    this.log = log || (() => {})
    this.tasks = new Map()
    this.sessionCount = 0
    this.sessionBytes = 0
    this.client = null
    this.WebTorrent = null
    this.downloadsDir = null
    this.capabilities = {}
    this._timer = null
  }

  // ------------------------------------------------------------------ setup
  async init () {
    const mod = await import('webtorrent/dist/webtorrent.min.js')
    this.WebTorrent = mod.default
    // Folder mode needs our own store factory (see _folderStore). Imported only now, after
    // the single-tab lock is held, because the module clears a shared OPFS cache on load.
    const { default: FSAChunkStore } = await import('fsa-chunk-store')
    this._FSAChunkStore = FSAChunkStore
    this.capabilities = {
      webrtc: !!this.WebTorrent.WEBRTC_SUPPORT,
      opfs: !!navigator.storage?.getDirectory,
      folderPicker: typeof window.showDirectoryPicker === 'function',
      savePicker: typeof window.showSaveFilePicker === 'function'
    }
    if (this.capabilities.opfs) {
      await this._purgeStorage()
      this.downloadsDir = true // browser storage available (WebTorrent's default OPFS store)
    }
    this.client = new this.WebTorrent({
      maxConns: 40,
      downloadLimit: this.settings.downloadLimitKBps > 0 ? this.settings.downloadLimitKBps * 1024 : -1,
      uploadLimit: this.settings.uploadLimitKBps > 0 ? this.settings.uploadLimitKBps * 1024 : -1,
      tracker: { announce: effectiveTrackers(this.settings) }
    })
    this.client.on('error', err => this.log('error', `Torrent client error: ${friendlyError(err)}`))
    this._timer = setInterval(() => this._tick(), 1000)
    this.log('info', `Engine ready (WebRTC ${this.capabilities.webrtc ? 'available' : 'NOT available'}, storage ${this.capabilities.opfs ? 'OPFS' : 'unavailable'})`)
  }

  /** Remove browser storage left by earlier sessions (only one app tab can run at a time). */
  async _purgeStorage () {
    try {
      const root = await navigator.storage.getDirectory()
      const names = []
      for await (const name of root.keys()) names.push(name)
      for (const name of names) await root.removeEntry(name, { recursive: true }).catch(() => {})
      if (names.length) this.log('info', `Freed browser storage left by a previous session (${names.length} item(s)).`)
    } catch (err) {
      this.log('warn', `Could not clean browser storage: ${friendlyError(err)}`)
    }
  }

  applySettings (settings) {
    this.settings = settings
    if (!this.client) return
    this.client.throttleDownload(settings.downloadLimitKBps > 0 ? settings.downloadLimitKBps * 1024 : -1)
    this.client.throttleUpload(settings.uploadLimitKBps > 0 ? settings.uploadLimitKBps * 1024 : -1)
    // Mutate in place: WebTorrent reads this array whenever a torrent is added.
    const list = this.client.tracker?.announce
    if (Array.isArray(list)) list.splice(0, list.length, ...effectiveTrackers(settings))
    if (!settings.seedAfterComplete) {
      for (const t of this.tasks.values()) if (t.completedAt) this._stopSharing(t)
    }
    this._emit()
  }

  destroy () {
    clearInterval(this._timer)
    try { this.client?.destroy() } catch { /* already gone */ }
  }

  // ------------------------------------------------------------------ staging
  _newTask (kind, extra) {
    const task = {
      id: uuid(),
      kind,
      infoHash: null,
      name: '',
      meta: null,
      torrentBytes: null,
      magnetURI: null,
      torrent: null,
      confirmed: false,
      queued: false,
      paused: false,
      error: null,
      destination: 'browser',
      dirHandle: null,
      dirName: null,
      selected: new Set(),
      addedAt: Date.now(),
      completedAt: null,
      lastDone: 0,
      lastProgressAt: Date.now(),
      lastActivityAt: Date.now(),
      saved: new Set(),
      trackerWarnings: new Map(),
      hint: null,
      ...extra
    }
    this.tasks.set(task.id, task)
    return task
  }

  _assertNotDuplicate (infoHash) {
    for (const t of this.tasks.values()) {
      if (t.infoHash === infoHash) throw new EngineError('This torrent has already been added.', 'duplicate')
    }
  }

  /** Read and validate a .torrent file. Fully offline: nothing connects until confirm(). */
  async stageFile (file) {
    if (!file) throw new ValidationError('No file selected.', 'no_file')
    if (!/\.torrent$/i.test(file.name)) throw new ValidationError('Only .torrent files are accepted.', 'invalid_extension')
    if (file.size > 10 * 1024 * 1024) throw new ValidationError('Torrent file is too large (limit 10 MB).', 'file_too_large')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const meta = await parseTorrentFile(bytes, file.name)
    this._assertNotDuplicate(meta.infoHash)
    const task = this._newTask('file', { infoHash: meta.infoHash, name: meta.name, meta, torrentBytes: bytes })
    this.log('info', `Read torrent "${meta.name}" (${meta.files.length} file(s))`)
    this._emit()
    return task
  }

  /**
   * Validate a magnet link and start fetching its metadata (file list) from peers.
   * No file data is requested until the user confirms.
   */
  stageMagnet (text) {
    if (!this.capabilities.webrtc) throw new EngineError('This browser does not support WebRTC, so it cannot connect to any peers.', 'no_webrtc')
    const m = parseMagnet(text)
    this._assertNotDuplicate(m.infoHash)
    const magnetURI = this.settings.allowWebSeeds ? m.magnetURI : buildMagnet({ ...m, webSeeds: [] })
    const task = this._newTask('magnet', { infoHash: m.infoHash, name: m.name || m.infoHash, magnetURI })
    if (m.unusableTrackers.length) {
      this.log('warn', `Ignored ${m.unusableTrackers.length} tracker(s) a browser cannot use (only wss:// works).`)
    }
    this._addToClient(task, magnetURI, { rootDir: null })
    this._emit()
    return task
  }

  cancelPreview (id) {
    const task = this.tasks.get(id)
    if (!task || task.confirmed) return
    this._destroyTorrent(task, true)
    this.tasks.delete(id)
    this._emit()
  }

  // ------------------------------------------------------------------ confirm / start
  /**
   * @param {string} id
   * @param {{selected:number[], destination:'browser'|'folder', dirHandle?:FileSystemDirectoryHandle}} opts
   */
  async confirm (id, { selected, destination = 'browser', dirHandle = null }) {
    const task = this.tasks.get(id)
    if (!task || task.confirmed) throw new EngineError('This preview has expired. Add the torrent again.', 'not_found')
    if (!task.meta) throw new EngineError('The file list is not available yet. Wait for the metadata.', 'no_metadata')
    if (!this.capabilities.webrtc) throw new EngineError('This browser does not support WebRTC, so it cannot download torrents.', 'no_webrtc')
    const valid = new Set(task.meta.files.map(f => f.index))
    const chosen = new Set((selected || []).filter(i => Number.isInteger(i) && valid.has(i)))
    if (!chosen.size || chosen.size !== (selected || []).length) throw new LimitError('Select at least one valid file.', 'empty_selection')
    const selectedBytes = task.meta.files.filter(f => chosen.has(f.index)).reduce((a, f) => a + f.length, 0)

    if (destination === 'folder') {
      if (!dirHandle || dirHandle.kind !== 'directory') throw new EngineError('Choose a folder first.', 'no_folder')
      const perm = await dirHandle.queryPermission?.({ mode: 'readwrite' })
      if (perm && perm !== 'granted') {
        const req = await dirHandle.requestPermission?.({ mode: 'readwrite' })
        if (req !== 'granted') throw new EngineError('Permission to write to that folder was not granted.', 'permission')
      }
    } else if (!this.downloadsDir) {
      throw new EngineError('This browser has no file storage for downloads (private window?). Use "Folder on this device" in Chrome/Edge.', 'no_storage')
    }

    let storageFree = null
    if (destination === 'browser') {
      try {
        const est = await navigator.storage.estimate()
        storageFree = Math.max(0, (est.quota || 0) - (est.usage || 0))
      } catch { storageFree = null }
    }
    checkNewDownload({ settings: this.settings, selectedBytes, sessionCount: this.sessionCount, sessionBytes: this.sessionBytes, storageFree })

    task.confirmed = true
    task.selected = chosen
    task.selectedBytes = selectedBytes
    task.destination = destination
    task.dirHandle = destination === 'folder' ? dirHandle : null
    task.dirName = destination === 'folder' ? cleanText(dirHandle.name, 200) : null
    task.lastProgressAt = Date.now()
    this.sessionCount++
    this.sessionBytes += selectedBytes

    if (this._activeCount() >= this.settings.maxActive) {
      task.queued = true
      this._pauseTorrent(task)
      this.log('info', `Queued "${task.name}" (max ${this.settings.maxActive} active downloads)`)
    } else {
      this._start(task)
    }
    this._emit()
    return task
  }

  _start (task) {
    this._startAsync(task).catch(err => this._fail(task, friendlyError(err)))
  }

  async _startAsync (task) {
    task.queued = false
    task.paused = false
    task.lastProgressAt = Date.now()
    const needsReAdd = !task.torrent || task.destination === 'folder'
    if (needsReAdd) {
      // Re-create the torrent with its final storage location. For magnet links the
      // metadata fetched during preview is reused, so peers aren't asked again.
      const bytes = task.torrentBytes || task.torrent?.torrentFile
      if (task.torrent) this._destroyTorrent(task, true)
      if (!bytes) { this._fail(task, 'Torrent metadata is missing. Add the torrent again.'); return }
      task.torrentBytes = bytes
      const input = this.settings.allowWebSeeds ? bytes : await stripWebSeeds(bytes)
      if (task.torrent || !this.tasks.has(task.id)) return // superseded while awaiting
      this._addToClient(task, input, {
        rootDir: task.destination === 'folder' ? task.dirHandle : null
      })
    } else {
      task.torrent.resume()
      this._applySelection(task)
    }
    this.log('info', `Started "${task.name}"`)
  }

  _addToClient (task, torrentId, { rootDir }) {
    const opts = { deselect: true, strategy: 'rarest', noPeersIntervalTime: 20, maxWebConns: 4 }
    if (rootDir) {
      opts.rootDir = rootDir
      opts.store = this._folderStore()
    }
    let torrent
    try {
      torrent = this.client.add(torrentId, opts)
    } catch (err) {
      this._fail(task, friendlyError(err))
      return
    }
    task.torrent = torrent
    torrent._btdInUserFolder = !!rootDir // decides whether removal may wipe its store

    torrent.on('metadata', () => {
      if (task.torrent !== torrent) return
      task.storeName = `${torrent.name} - ${torrent.infoHash.slice(0, 8)}`
      try {
        const meta = summarizeLiveTorrent(torrent)
        if (task.meta && meta.infoHash !== task.meta.infoHash) throw new Error('info hash mismatch')
        if (!task.meta) {
          task.meta = meta
          task.name = meta.name
          this.log('info', `Received file list for "${meta.name}" (${meta.files.length} file(s))`)
        }
      } catch (err) {
        this._fail(task, err instanceof ValidationError ? err.message : friendlyError(err))
        this._destroyTorrent(task, true)
        return
      }
      this._emit()
    })
    torrent.on('ready', () => {
      if (task.torrent !== torrent) return
      if (task.confirmed && !task.paused && !task.queued) this._applySelection(task)
      this._emit()
    })
    torrent.on('warning', err => {
      if (task.torrent !== torrent) return
      const msg = friendlyError(err)
      const m = /(wss?:\/\/[^\s"']+)/.exec(msg)
      if (m) task.trackerWarnings.set(m[1], msg)
      this.log('warn', `"${task.name}": ${msg}`)
    })
    torrent.on('error', err => {
      if (task.torrent !== torrent) return
      this._fail(task, friendlyError(err))
    })
    torrent.on('noPeers', source => {
      if (task.torrent !== torrent || task.error) return
      if (torrent.numPeers === 0) {
        task.hint = 'No WebRTC peers found yet. Only browser-based peers (WebTorrent) can connect. Torrents shared only by desktop clients are unreachable here.'
      }
      this.log('info', `"${task.name}": no peers from ${cleanText(source, 30)}`)
    })
    torrent.on('wire', () => { task.hint = null })
  }

  /**
   * Store for "Folder on this device". WebTorrent 3.0.21 passes its own File objects to
   * fsa-chunk-store, which then overwrites their stream()/blob() methods with its own
   * state, so writing fails ("….write is not a function"). Giving the store plain
   * {path, length, offset} copies avoids that.
   */
  _folderStore () {
    const FSAChunkStore = this._FSAChunkStore
    return function FolderStore (chunkLength, opts) {
      const files = (opts.files || []).map(f => ({ path: f.path, length: f.length, offset: f.offset }))
      return new FSAChunkStore(chunkLength, { ...opts, files })
    }
  }

  _applySelection (task) {
    const t = task.torrent
    if (!t || !t.ready || !t.pieces?.length) return
    try {
      t.deselect(0, t.pieces.length - 1)
      t.files.forEach((f, i) => { if (task.selected.has(i)) f.select() })
    } catch (err) {
      this._fail(task, friendlyError(err))
    }
  }

  _pauseTorrent (task) {
    const t = task.torrent
    if (!t || t.destroyed) return
    try {
      if (t.ready && t.pieces?.length) t.deselect(0, t.pieces.length - 1)
      t.pause()
    } catch { /* torrent going away */ }
  }

  _stopSharing (task) {
    const t = task.torrent
    if (!t || t.destroyed) return
    t.pause()
    for (const w of [...(t.wires || [])]) { try { w.destroy() } catch { /* ignore */ } }
  }

  _fail (task, message) {
    task.error = message
    this.log('error', `"${task.name || task.infoHash}": ${message}`)
    this._emit()
  }

  _destroyTorrent (task, destroyStore) {
    const t = task.torrent
    task.torrent = null
    if (!t || t.destroyed) return
    // Never ask WebTorrent to delete store data inside a user-chosen folder. Decided per
    // torrent: a magnet's preview copy lives in browser storage even if the final
    // destination is a folder, and that copy should be wiped.
    const wipe = destroyStore && !t._btdInUserFolder
    try {
      t.destroy({ destroyStore: wipe }, err => { if (err) this.log('warn', `Cleanup: ${friendlyError(err)}`) })
    } catch { /* already destroyed */ }
  }

  // ------------------------------------------------------------------ controls
  _get (id) {
    const t = this.tasks.get(id)
    if (!t) throw new EngineError('Download not found.', 'not_found')
    return t
  }

  pause (id) {
    const task = this._get(id)
    if (task.completedAt) return
    task.paused = true
    task.queued = false
    this._pauseTorrent(task)
    this.log('info', `Paused "${task.name}"`)
    this._emit()
  }

  resume (id) {
    const task = this._get(id)
    if (task.completedAt) {
      if (!this.settings.seedAfterComplete) throw new EngineError('Already complete. Enable "Seed after completion" in Settings to share it.', 'complete')
      task.torrent?.resume()
      this._emit()
      return
    }
    task.paused = false
    if (this._activeCount() >= this.settings.maxActive) {
      task.queued = true
    } else {
      this._start(task)
    }
    this._emit()
  }

  startNow (id) {
    const task = this._get(id)
    if (!task.confirmed || task.completedAt) return
    this._start(task)
    this._emit()
  }

  retry (id) {
    const task = this._get(id)
    if (!task.confirmed) throw new EngineError('Confirm the download first.', 'not_confirmed')
    const bytes = task.torrentBytes || task.torrent?.torrentFile
    task.error = null
    task.hint = null
    task.trackerWarnings.clear()
    task.lastProgressAt = Date.now()
    if (!bytes && task.kind === 'magnet') {
      this._destroyTorrent(task, true)
      this._addToClient(task, task.magnetURI, { rootDir: null })
    } else {
      // Re-adding re-verifies data already stored, then continues where it left off.
      if (task.torrent) this._destroyTorrent(task, false)
      task.torrentBytes = bytes
      this._start(task)
    }
    this.log('info', `Retrying "${task.name}"`)
    this._emit()
  }

  pauseAll () {
    let n = 0
    for (const t of this.tasks.values()) if (t.confirmed && !t.completedAt && !t.paused) { this.pause(t.id); n++ }
    return n
  }

  resumeAll () {
    let n = 0
    for (const t of [...this.tasks.values()].sort((a, b) => a.addedAt - b.addedAt)) {
      if (t.paused) { this.resume(t.id); n++ }
    }
    return n
  }

  setSelection (id, selected) {
    const task = this._get(id)
    if (!task.meta) throw new EngineError('File list not available yet.', 'no_metadata')
    const valid = new Set(task.meta.files.map(f => f.index))
    const chosen = new Set(selected.filter(i => valid.has(i)))
    if (!chosen.size) throw new LimitError('Select at least one file.', 'empty_selection')
    const bytes = task.meta.files.filter(f => chosen.has(f.index)).reduce((a, f) => a + f.length, 0)
    const added = Math.max(0, bytes - (task.selectedBytes || 0))
    if (added > 0) checkNewDownload({ settings: this.settings, selectedBytes: bytes, sessionCount: 0, sessionBytes: this.sessionBytes - (task.selectedBytes || 0), storageFree: null })
    this.sessionBytes += bytes - (task.selectedBytes || 0)
    task.selected = chosen
    task.selectedBytes = bytes
    if (task.completedAt) {
      task.completedAt = null
      task.torrent?.resume()
    }
    if (!task.paused && !task.queued) this._applySelection(task)
    this._emit()
  }

  remove (id) {
    const task = this._get(id)
    this._destroyTorrent(task, true)
    this.tasks.delete(id)
    if (task.destination === 'folder') this._removeChunkCache(task)
    this.log('info', task.destination === 'folder'
      ? `Removed "${task.name}" (files in your folder were kept)`
      : `Removed "${task.name}" and freed its browser storage`)
    this.dispatchEvent(new CustomEvent('removed', { detail: task }))
    this._emit()
  }

  async _removeChunkCache (task) {
    // Folder mode keeps a small write cache in OPFS under chunks/<name - hash>.
    try {
      const root = await navigator.storage.getDirectory()
      const chunks = await root.getDirectoryHandle('chunks')
      await chunks.removeEntry(task.storeName || `${task.name} - ${task.infoHash.slice(0, 8)}`, { recursive: true })
    } catch { /* nothing to clean */ }
  }

  // ------------------------------------------------------------------ periodic
  _activeCount () {
    let n = 0
    for (const t of this.tasks.values()) {
      if (t.confirmed && !t.queued && !t.paused && !t.completedAt && !t.error) n++
    }
    return n
  }

  _tick () {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (!task.confirmed && now - task.addedAt > PREVIEW_TTL_MS) {
        this.cancelPreview(task.id)
        continue
      }
      const t = task.torrent
      if (!task.confirmed || !t || t.destroyed || task.error) continue
      const done = this._selectedDownloaded(task)
      if (done > task.lastDone) { task.lastDone = done; task.lastProgressAt = now; task.lastActivityAt = now }
      if (task.paused || task.queued) task.lastProgressAt = now
      if (!task.completedAt && t.ready && this._selectedComplete(task)) this._onComplete(task)
      if ((t.uploadSpeed || 0) > 0) task.lastActivityAt = now
      this._autoCleanup(task, now)
    }
    // Start queued downloads as slots free up (oldest first).
    const queued = [...this.tasks.values()].filter(t => t.queued && !t.paused).sort((a, b) => a.addedAt - b.addedAt)
    for (const t of queued) {
      if (this._activeCount() >= this.settings.maxActive) break
      this._start(t)
    }
    this._emit()
  }

  _selectedDownloaded (task) {
    const t = task.torrent
    if (!t?.files?.length) return 0
    let sum = 0
    for (const i of task.selected) sum += Math.min(t.files[i]?.downloaded || 0, t.files[i]?.length || 0)
    return sum
  }

  _selectedComplete (task) {
    const t = task.torrent
    if (!t?.files?.length || !task.selected.size) return false
    for (const i of task.selected) {
      const f = t.files[i]
      if (!f || !(f.done || f.progress === 1)) return false
    }
    return true
  }

  _onComplete (task) {
    task.completedAt = Date.now()
    task.lastActivityAt = Date.now()
    if (!this.settings.seedAfterComplete) this._stopSharing(task)
    this.log('info', `Completed "${task.name}"`)
    this.dispatchEvent(new CustomEvent('completed', { detail: task }))
  }

  _autoCleanup (task, now) {
    const minutes = this.settings.autoCleanupMinutes
    if (!minutes || !task.completedAt || task.destination !== 'browser') return
    const allSaved = [...task.selected].every(i => task.saved.has(i))
    if (allSaved && now - task.lastActivityAt > minutes * 60_000) {
      this.log('info', `Auto-cleanup: freed browser storage of "${task.name}" (saved and idle for ${minutes} min)`)
      this.remove(task.id)
    }
  }

  markSaved (task, index) {
    task.saved.add(index)
    task.lastActivityAt = Date.now()
    this._emit()
  }

  // ------------------------------------------------------------------ snapshot
  snapshot () {
    const now = Date.now()
    const items = []
    let down = 0
    let up = 0
    let peers = 0
    for (const task of this.tasks.values()) {
      const t = task.torrent
      const alive = t && !t.destroyed
      const selectedBytes = task.selectedBytes || (task.meta ? task.meta.length : 0)
      const downloaded = task.confirmed ? this._selectedDownloaded(task) : 0
      const numPeers = alive ? t.numPeers : 0
      const uploading = !!(task.completedAt && alive && !t.paused && this.settings.seedAfterComplete)
      const status = computeStatus({
        error: task.error,
        confirmed: task.confirmed,
        queued: task.queued,
        hasMetadata: !!task.meta,
        paused: task.paused,
        complete: !!task.completedAt,
        uploading,
        numPeers,
        secondsWithoutProgress: (now - task.lastProgressAt) / 1000,
        stallTimeout: this.settings.stallSeconds
      })
      const transferring = ['downloading', 'finding_peers', 'stalled', 'checking_metadata', 'seeding'].includes(status)
      const dRate = transferring && alive ? Math.round(t.downloadSpeed || 0) : 0
      const uRate = transferring && alive ? Math.round(t.uploadSpeed || 0) : 0
      const remaining = Math.max(0, selectedBytes - downloaded)
      down += dRate
      up += uRate
      peers += numPeers
      let webSeeds = 0
      if (alive) for (const w of t.wires || []) if (w.type === 'webSeed') webSeeds++
      items.push({
        id: task.id,
        kind: task.kind,
        infoHash: task.infoHash,
        name: task.name || task.infoHash,
        status,
        statusLabel: STATUS_LABELS[status],
        error: task.error,
        hint: status === 'stalled' && !task.hint
          ? 'No data received recently. Peers may have left, or none are reachable over WebRTC.'
          : (['finding_peers', 'stalled', 'checking_metadata'].includes(status) ? task.hint : null),
        trackerProblems: task.trackerWarnings.size,
        totalSize: task.meta?.length || 0,
        selectedBytes,
        downloaded,
        remaining,
        progress: selectedBytes ? Math.min(100, (100 * downloaded) / selectedBytes) : 0,
        downloadRate: dRate,
        uploadRate: uRate,
        uploaded: alive ? t.uploaded : 0,
        eta: dRate > 0 && remaining > 0 ? remaining / dRate : null,
        numPeers: Math.max(0, numPeers - webSeeds),
        webSeeds,
        destination: task.destination,
        dirName: task.dirName,
        addedAt: task.addedAt,
        completedAt: task.completedAt,
        numFiles: task.meta?.files.length || 0,
        savedCount: task.saved.size,
        selectedCount: task.selected.size
      })
    }
    items.sort((a, b) => a.addedAt - b.addedAt)
    const confirmed = items.filter(i => i.status !== 'preview' && !(i.status === 'checking_metadata' && !this.tasks.get(i.id)?.confirmed))
    return {
      torrents: confirmed,
      totals: {
        downloadRate: down,
        uploadRate: up,
        peers,
        active: confirmed.filter(i => isActive(i.status)).length,
        queued: confirmed.filter(i => i.status === 'queued').length,
        completed: confirmed.filter(i => ['completed', 'seeding'].includes(i.status)).length,
        downloaded: confirmed.reduce((a, i) => a + i.downloaded, 0),
        uploaded: confirmed.reduce((a, i) => a + i.uploaded, 0),
        count: confirmed.length,
        sessionCount: this.sessionCount,
        sessionBytes: this.sessionBytes
      }
    }
  }

  files (id) {
    const task = this._get(id)
    const t = task.torrent
    if (!task.meta) return []
    return task.meta.files.map(f => {
      const live = t && !t.destroyed ? t.files?.[f.index] : null
      const downloaded = live ? Math.min(live.downloaded, f.length) : 0
      return {
        index: f.index,
        path: f.path,
        name: f.name,
        length: f.length,
        selected: task.selected.has(f.index),
        downloaded,
        progress: f.length ? (100 * downloaded) / f.length : 100,
        done: !!(live && (live.done || live.progress === 1)),
        saved: task.saved.has(f.index)
      }
    })
  }

  /** The live WebTorrent File object (for saving). */
  liveFile (id, index) {
    const task = this._get(id)
    const f = task.torrent?.files?.[index]
    if (!f || task.torrent.destroyed) throw new EngineError('This file is no longer available.', 'gone')
    if (!(f.done || f.progress === 1)) throw new EngineError('This file has not finished downloading yet.', 'not_done')
    return f
  }

  _emit () {
    this.dispatchEvent(new CustomEvent('update'))
  }
}
