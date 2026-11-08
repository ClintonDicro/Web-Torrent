// Browser Torrent Downloader: UI controller.
// Untrusted text (torrent names, file paths, tracker URLs, error messages) is only ever
// inserted with textContent / attributes, never as HTML.
import './styles/app.css'
import {
  createElement, Activity, AppWindow, ArrowDown, ArrowDownToLine, ArrowDownUp, ArrowUp, Clock, CircleAlert, CircleCheck,
  CirclePause, CirclePlay, Download, Eraser, FileSearch, FileUp, FolderDown, FolderOpen, Gauge, History, Hourglass, Inbox,
  Info, LayoutDashboard, LoaderCircle, Menu, PanelRight, Pause, Play, Plus, Radar, Radio, RotateCw, Save, ScrollText, Search,
  Settings, SlidersHorizontal, SunMoon, Timer, Trash2, TriangleAlert, Users, WifiOff, X
} from 'lucide'
import { TorrentEngine, friendlyError } from './engine.js'
import { BLOB_LIMIT, registerDownloadWorker, saveAllToFolder, saveCapabilities, saveFile, saveMethodFor } from './save.js'
import { DEFAULTS, SettingsError, loadSettings, saveSettings, validateSettings } from './lib/settings.js'
import { clearHistory, loadHistory, recordHistory } from './lib/history.js'
import { formatBytes, formatDate, formatEta, formatRate } from './lib/format.js'

const ICONS = {
  Activity, AppWindow, ArrowDown, ArrowDownToLine, ArrowDownUp, ArrowUp, Clock, CircleAlert, CircleCheck, CirclePause, CirclePlay,
  Download, Eraser, FileSearch, FileUp, FolderDown, FolderOpen, Gauge, History, Hourglass, Inbox, Info, LayoutDashboard,
  LoaderCircle, Menu, PanelRight, Pause, Play, Plus, Radar, Radio, RotateCw, Save, ScrollText, Search, Settings,
  SlidersHorizontal, SunMoon, Timer, Trash2, TriangleAlert, Users, WifiOff, X
}

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

function icon (name, cls = '') {
  const svg = createElement(ICONS[name] || Info)
  svg.setAttribute('class', `lucide ${cls}`.trim())
  svg.setAttribute('aria-hidden', 'true')
  return svg
}
function hydrateIcons (root = document) {
  $$('i[data-icon]', root).forEach(el => el.replaceWith(icon(el.dataset.icon, el.className)))
}
function h (tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

function toast (message, level = 'info', timeout = 5000) {
  const tone = { info: ['border-sky-500/40', 'text-sky-500', 'Info'], success: ['border-emerald-500/50', 'text-emerald-500', 'CircleCheck'], warning: ['border-amber-500/50', 'text-amber-500', 'TriangleAlert'], error: ['border-rose-500/60', 'text-rose-500', 'CircleAlert'] }[level] || ['border-sky-500/40', 'text-sky-500', 'Info']
  const el = h('div', { class: `card animate-fade-in flex items-start gap-2 border-l-4 ${tone[0]} p-3 text-sm`, role: 'status', 'data-level': level },
    icon(tone[2], `mt-0.5 ${tone[1]}`), h('div', { class: 'flex-1 break-words', text: message }))
  $('#toasts').append(el)
  setTimeout(() => el.remove(), timeout)
}

// ---------------------------------------------------------------- state
const state = {
  view: 'dashboard',
  settings: loadSettings(),
  engine: null,
  snapshot: { torrents: [], totals: {} },
  previewId: null,
  previewSelected: new Set(),
  folderHandle: null,
  detailId: null,
  drawerDirty: false,
  removeId: null,
  logs: []
}

function log (level, message) {
  const line = `${new Date().toLocaleTimeString()} ${level.toUpperCase().padEnd(5)} ${message}`
  state.logs.push(line)
  if (state.logs.length > 500) state.logs.shift()
  if (state.view === 'logs') renderLogs()
}

const STATUS_STYLE = {
  preview: ['bg-slate-500/15 text-slate-500', 'bg-slate-400', 'Clock'],
  queued: ['bg-slate-500/15 text-slate-500 dark:text-slate-400', 'bg-slate-400', 'Clock'],
  checking_metadata: ['bg-indigo-500/15 text-indigo-600 dark:text-indigo-300', 'bg-indigo-500', 'FileSearch'],
  finding_peers: ['bg-amber-500/15 text-amber-600 dark:text-amber-300', 'bg-amber-500', 'Radar'],
  downloading: ['bg-sky-500/15 text-sky-600 dark:text-sky-300', 'bg-sky-500', 'ArrowDown'],
  paused: ['bg-slate-500/15 text-slate-600 dark:text-slate-300', 'bg-slate-400', 'Pause'],
  stalled: ['bg-orange-500/15 text-orange-600 dark:text-orange-300', 'bg-orange-500', 'Hourglass'],
  completed: ['bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', 'bg-emerald-500', 'CircleCheck'],
  error: ['bg-rose-500/15 text-rose-600 dark:text-rose-300', 'bg-rose-500', 'CircleAlert'],
  seeding: ['bg-violet-500/15 text-violet-600 dark:text-violet-300', 'bg-violet-500', 'ArrowUp']
}
const LIVE = new Set(['downloading', 'finding_peers', 'checking_metadata', 'stalled'])

function badge (t) {
  const [cls, , ic] = STATUS_STYLE[t.status] || STATUS_STYLE.queued
  return h('span', { class: `badge ${cls}`, 'data-role': 'badge' }, icon(ic, '!h-3 !w-3'), t.statusLabel)
}

// ---------------------------------------------------------------- theme
function applyTheme (theme) {
  const root = document.documentElement
  root.dataset.theme = theme
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings.theme))

// ---------------------------------------------------------------- views
const TITLES = { dashboard: 'Dashboard', active: 'Active Downloads', completed: 'Completed Downloads', history: 'Download History', settings: 'Settings', logs: 'Activity Log', about: 'How it works & limits' }
function setView (view) {
  if (!TITLES[view]) view = 'dashboard'
  state.view = view
  $$('.nav-item').forEach(b => (b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')))
  $('#view-title').textContent = TITLES[view]
  const isList = ['dashboard', 'active', 'completed'].includes(view)
  $('#view-list').hidden = !isList
  $('#dash-tiles').hidden = view !== 'dashboard'
  for (const v of ['history', 'settings', 'logs', 'about']) $(`#view-${v}`).hidden = view !== v
  if (isList) renderList()
  if (view === 'history') renderHistory()
  if (view === 'settings') fillSettings()
  if (view === 'logs') renderLogs()
  closeSidebar()
  try { localStorage.setItem('btd.view', view) } catch { /* ignore */ }
}
function closeSidebar () { $('#sidebar').classList.add('-translate-x-full'); $('#sidebar-backdrop').hidden = true }

// ---------------------------------------------------------------- live data
let renderQueued = false
function scheduleRender () {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => { renderQueued = false; onSnapshot(state.engine.snapshot()) })
}

function onSnapshot (snap) {
  state.snapshot = snap
  const t = snap.totals
  $('#top-active').textContent = t.active
  $('#top-completed').textContent = t.completed
  $('#top-down').textContent = $('#bar-down').textContent = formatRate(t.downloadRate)
  $('#top-up').textContent = $('#bar-up').textContent = formatRate(t.uploadRate)
  $('#bar-total').textContent = `${formatBytes(t.downloaded)} ↓ / ${formatBytes(t.uploaded)} ↑`
  $('#tile-active').textContent = t.active
  $('#tile-queued').textContent = t.queued
  $('#tile-completed').textContent = t.completed
  $('#tile-speed').textContent = `${formatRate(t.downloadRate)} / ${formatRate(t.uploadRate)}`
  $('#nav-active').textContent = (t.count - t.completed) || ''
  $('#nav-completed').textContent = t.completed || ''
  $('#session-usage').textContent = `${t.sessionCount}/${state.settings.maxTorrentsPerSession} · ${formatBytes(t.sessionBytes)}`
  const online = navigator.onLine
  const caps = state.engine.capabilities
  $('#conn-dot').className = `h-2 w-2 rounded-full ${!online || !caps.webrtc ? 'bg-rose-500' : t.peers > 0 ? 'bg-emerald-500' : 'bg-amber-500'}`
  $('#conn-text').textContent = !caps.webrtc ? 'WebRTC unavailable' : !online ? 'Offline' : `WebRTC · ${t.peers} peer${t.peers === 1 ? '' : 's'}`
  if (['dashboard', 'active', 'completed'].includes(state.view)) renderList()
  if (state.detailId) renderDrawer(false)
  if (state.previewId) renderPreviewState()
}

// ---------------------------------------------------------------- torrent cards
const cards = new Map()
function visibleTorrents () {
  const all = state.snapshot.torrents || []
  if (state.view === 'active') return all.filter(t => !['completed', 'seeding'].includes(t.status))
  if (state.view === 'completed') return all.filter(t => ['completed', 'seeding'].includes(t.status))
  return all
}
function renderList () {
  const list = $('#torrent-list')
  const items = visibleTorrents()
  const ids = new Set(items.map(t => t.id))
  for (const [id, el] of cards) if (!ids.has(id)) { el.remove(); cards.delete(id) }
  items.forEach((t, i) => {
    let el = cards.get(t.id)
    if (!el) { el = buildCard(t); cards.set(t.id, el) }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null)
    updateCard(el, t)
  })
  $('#empty-state').hidden = items.length > 0
  if (!items.length) $('#empty-title').textContent = state.view === 'completed' ? 'Nothing completed yet' : state.view === 'active' ? 'No active downloads' : 'No downloads yet'
}

const actionBtn = (action, label, ic, extra = '') => h('button', { class: `icon-btn ${extra}`, 'data-act': action, title: label, 'aria-label': label }, icon(ic))

function buildCard (t) {
  const el = h('article', { class: 'card animate-fade-in p-4', 'data-id': t.id, 'data-testid': 'torrent-card' },
    h('div', { class: 'flex items-start gap-3' },
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex flex-wrap items-center gap-2' },
          h('button', { class: 'min-w-0 max-w-full truncate text-left font-medium text-slate-900 hover:text-sky-600 dark:text-white dark:hover:text-sky-300', 'data-act': 'details', 'data-role': 'name' }),
          h('span', { 'data-role': 'badge-slot' })),
        h('div', { class: 'mt-0.5 truncate text-[11px] text-slate-400', 'data-role': 'where' })),
      h('div', { class: 'flex shrink-0 flex-wrap items-center justify-end', 'data-role': 'actions' },
        actionBtn('start', 'Start now', 'Play'),
        actionBtn('pause', 'Pause', 'Pause'),
        actionBtn('resume', 'Resume', 'Play'),
        actionBtn('retry', 'Retry', 'RotateCw'),
        actionBtn('save', 'Save files', 'Save', 'text-emerald-600 dark:text-emerald-400'),
        actionBtn('details', 'Details', 'PanelRight'),
        actionBtn('remove', 'Remove', 'Trash2', 'hover:!text-rose-500'))),
    h('div', { class: 'bar mt-3', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'data-role': 'bar' },
      h('div', { class: 'bar-fill', 'data-role': 'fill' })),
    h('div', { class: 'mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500' },
      h('span', { class: 'font-semibold tabular-nums text-slate-700 dark:text-slate-200', 'data-role': 'pct' }),
      h('span', { class: 'tabular-nums', 'data-role': 'sizes' }),
      h('span', { class: 'flex items-center gap-1 tabular-nums', title: 'Download speed' }, icon('ArrowDown', '!h-3 !w-3 text-sky-500'), h('span', { 'data-role': 'down' })),
      h('span', { class: 'flex items-center gap-1 tabular-nums', title: 'Upload speed' }, icon('ArrowUp', '!h-3 !w-3 text-violet-500'), h('span', { 'data-role': 'up' })),
      h('span', { class: 'flex items-center gap-1 tabular-nums', title: 'Estimated time remaining' }, icon('Timer', '!h-3 !w-3'), h('span', { 'data-role': 'eta' })),
      h('span', { class: 'flex items-center gap-1 tabular-nums', title: 'Connected WebRTC peers' }, icon('Users', '!h-3 !w-3'), h('span', { 'data-role': 'peers' }))),
    h('p', { class: 'mt-2 text-xs', 'data-role': 'msg', hidden: true }))
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]')
    if (b) onCardAction(t.id, b.dataset.act, b)
  })
  return el
}

const SHOW = {
  start: t => t.status === 'queued',
  pause: t => ['queued', 'downloading', 'finding_peers', 'stalled', 'checking_metadata'].includes(t.status),
  resume: t => t.status === 'paused',
  retry: t => ['error', 'stalled'].includes(t.status),
  save: t => ['completed', 'seeding'].includes(t.status) && t.destination === 'browser'
}

function updateCard (el, t) {
  const q = r => el.querySelector(`[data-role="${r}"]`)
  if (q('name').textContent !== t.name) { q('name').textContent = t.name; q('name').title = t.name }
  q('where').textContent = t.destination === 'folder' ? `Saving to folder: ${t.dirName}` : (t.completedAt ? `In browser storage · ${t.savedCount}/${t.selectedCount} file(s) saved to device` : 'Browser storage')
  if (el.dataset.status !== t.status) {
    el.dataset.status = t.status
    q('badge-slot').replaceChildren(badge(t))
    const [, fill] = STATUS_STYLE[t.status] || STATUS_STYLE.queued
    q('fill').className = `bar-fill ${fill} ${t.status === 'downloading' ? 'bar-live' : ''}`
  }
  for (const [act, show] of Object.entries(SHOW)) {
    const b = el.querySelector(`[data-act="${act}"]`)
    if (b) b.hidden = !show(t)
  }
  const pct = Math.min(100, Math.max(0, t.progress))
  q('fill').style.width = `${pct}%`
  q('bar').setAttribute('aria-valuenow', pct.toFixed(1))
  q('pct').textContent = `${pct.toFixed(1)}%`
  q('sizes').textContent = `${formatBytes(t.downloaded)} of ${formatBytes(t.selectedBytes)} · ${formatBytes(t.remaining)} left`
  q('down').textContent = formatRate(t.downloadRate)
  q('up').textContent = formatRate(t.uploadRate)
  q('eta').textContent = LIVE.has(t.status) ? formatEta(t.eta) : '–'
  q('peers').textContent = `${t.numPeers} peer${t.numPeers === 1 ? '' : 's'}${t.webSeeds ? ` + ${t.webSeeds} web seed${t.webSeeds === 1 ? '' : 's'}` : ''}`
  const msg = q('msg')
  const text = t.error ? `Error: ${t.error}` : (t.hint || (t.trackerProblems && ['finding_peers', 'stalled'].includes(t.status) ? `${t.trackerProblems} tracker(s) unreachable. See Activity Log.` : ''))
  msg.hidden = !text
  msg.textContent = text
  msg.className = `mt-2 text-xs ${t.error ? 'text-rose-500' : 'text-amber-600 dark:text-amber-400'}`
}

async function onCardAction (id, act, btn) {
  if (act === 'details') return openDrawer(id)
  if (act === 'remove') return openRemove(id)
  if (act === 'save') {
    const files = state.engine.files(id).filter(f => f.selected && f.done)
    if (files.length === 1) return saveOne(id, files[0].index)
    return openDrawer(id)
  }
  btn.disabled = true
  try {
    if (act === 'start') state.engine.startNow(id)
    if (act === 'pause') state.engine.pause(id)
    if (act === 'resume') state.engine.resume(id)
    if (act === 'retry') state.engine.retry(id)
  } catch (e) { toast(friendlyError(e), 'error') } finally { btn.disabled = false }
}

// ---------------------------------------------------------------- saving
async function saveOne (id, index) {
  let file
  try { file = state.engine.liveFile(id, index) } catch (e) { toast(e.message, 'error'); return }
  const method = saveMethodFor(file.length)
  if (method === 'none') { toast(`This browser can't save a ${formatBytes(file.length)} file without streaming support. Use Chrome or Edge, or leave private browsing.`, 'error', 9000); return }
  if (method === 'blob') toast('This browser saves files through memory; large files may take a moment.', 'info', 4000)
  try {
    const result = await saveFile(file)
    if (result === 'cancelled') return
    const task = state.engine.tasks.get(id)
    if (task) state.engine.markSaved(task, index)
    toast(result === 'picker' ? `Saved ${file.name}` : `Saving ${file.name}. Check your browser's downloads.`, 'success', 4000)
  } catch (e) {
    toast(`Could not save: ${friendlyError(e)}`, 'error', 8000)
  }
}

async function saveAll (id) {
  const files = state.engine.files(id).filter(f => f.selected && f.done)
  if (!files.length) return
  try {
    const entries = files.map(f => ({ file: state.engine.liveFile(id, f.index), path: f.path }))
    const folder = await saveAllToFolder(entries)
    const task = state.engine.tasks.get(id)
    if (task) files.forEach(f => state.engine.markSaved(task, f.index))
    toast(`Saved ${files.length} file(s) to "${folder}"`, 'success')
  } catch (e) {
    if (e?.name !== 'AbortError') toast(`Could not save: ${friendlyError(e)}`, 'error', 8000)
  }
}

// ---------------------------------------------------------------- drawer
async function openDrawer (id) {
  state.detailId = id
  state.drawerDirty = false
  $('#drawer').classList.remove('translate-x-full')
  $('#drawer-backdrop').hidden = false
  renderDrawer(true)
  $('#drawer-close').focus()
}
function closeDrawer () {
  state.detailId = null
  $('#drawer').classList.add('translate-x-full')
  $('#drawer-backdrop').hidden = true
}
function renderDrawer (full) {
  const t = state.snapshot.torrents.find(x => x.id === state.detailId)
  if (!t) { closeDrawer(); return }
  $('#drawer-title').textContent = t.name
  $('#drawer-status').replaceChildren(badge(t))
  const task = state.engine.tasks.get(t.id)
  const meta = task?.meta
  const info = [
    ['Progress', `${t.progress.toFixed(1)}%`], ['Status', t.statusLabel],
    ['Selected size', formatBytes(t.selectedBytes)], ['Total size', formatBytes(t.totalSize)],
    ['Downloaded', formatBytes(t.downloaded)], ['Remaining', formatBytes(t.remaining)],
    ['Uploaded', formatBytes(t.uploaded)], ['Peers', `${t.numPeers}${t.webSeeds ? ` (+${t.webSeeds} web seeds)` : ''}`],
    ['Added', formatDate(t.addedAt)], ['Completed', formatDate(t.completedAt)],
    ['Saved to', t.destination === 'folder' ? `Folder "${t.dirName}" (in a sub-folder named after the torrent)` : 'Browser storage', true],
    ['Info hash', t.infoHash, true]
  ]
  if (meta?.trackers?.length) info.push(['Trackers', meta.trackers.join('\n'), true])
  if (t.error) info.push(['Error', t.error, true])
  $('#drawer-info').replaceChildren(...info.map(([k, v, wide]) => h('div', { class: wide ? 'col-span-2' : '' },
    h('dt', { class: 'stat-k', text: k }), h('dd', { class: `stat-v whitespace-pre-line break-all ${wide ? 'font-mono text-xs' : ''}`, text: String(v) }))))
  const files = state.engine.files(t.id)
  const canSave = t.destination === 'browser'
  $('#drawer-save-all').hidden = !canSave || !saveCapabilities().folderPicker
  $('#drawer-save-all').disabled = !files.some(f => f.selected && f.done)
  $('#drawer-save-hint').textContent = t.destination === 'folder'
    ? 'Files are being written directly into the folder you chose.'
    : 'Save finished files to your device. Data stays in browser storage until you remove the download.'
  if (full || !state.drawerDirty) {
    state.drawerDirty = false
    $('#drawer-apply-files').disabled = true
    $('#drawer-files').replaceChildren(...files.map(f => {
      const fill = h('div', { class: `bar-fill ${f.done ? 'bg-emerald-500' : 'bg-sky-500'}` })
      fill.style.width = `${f.progress}%`
      return h('li', { class: 'flex items-center gap-3 px-3 py-2', 'data-index': f.index },
        h('input', { type: 'checkbox', class: 'accent-sky-600', 'data-index': f.index, checked: f.selected, 'aria-label': `Download ${f.path}` }),
        h('div', { class: 'min-w-0 flex-1' },
          h('div', { class: 'truncate', title: f.path, text: f.path }),
          h('div', { class: 'bar mt-1 !h-1' }, fill)),
        h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500', text: `${f.progress.toFixed(0)}% · ${formatBytes(f.length)}` }),
        canSave ? h('button', { class: `icon-btn ${f.saved ? 'text-emerald-500' : ''}`, 'data-save': f.index, title: f.saved ? 'Saved (save again)' : 'Save to device', 'aria-label': `Save ${f.name}`, disabled: !f.done }, icon(f.saved ? 'CircleCheck' : 'Save')) : null)
    }))
  }
}

// ---------------------------------------------------------------- add flow
function openAdd () {
  if (!state.engine) return
  resetAdd()
  $('#add-modal').hidden = false
  setTab('file')
}
function resetAdd (keepInput = false) {
  state.previewId = null
  state.previewSelected = new Set()
  state.folderHandle = null
  for (const id of ['add-step-wait', 'add-step-preview', 'upload-error', 'upload-loading', 'confirm-error']) $(`#${id}`).hidden = true
  $('#add-step-pick').hidden = false
  $('#file-input').value = ''
  if (!keepInput) $('#magnet-input').value = ''
  $('#pv-folder-name').textContent = 'No folder chosen'
  $('input[name="pv-dest"][value="browser"]').checked = true
  $('#pv-folder-row').hidden = true
}
function closeAdd () {
  if (state.previewId) state.engine.cancelPreview(state.previewId)
  state.previewId = null
  $('#add-modal').hidden = true
}
function setTab (tab) {
  $$('[role="tab"]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
  $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab })
  $('#upload-error').hidden = true
  if (tab === 'magnet') $('#magnet-input').focus()
}
function showAddError (msg) {
  const el = $('#upload-error')
  el.replaceChildren(icon('CircleAlert', 'mt-0.5'), h('span', { text: msg }))
  el.hidden = false
}

async function handleFile (file) {
  if (!file) return
  if ($('#add-modal').hidden) openAdd()
  setTab('file')
  $('#upload-error').hidden = true
  $('#upload-loading').hidden = false
  try {
    const task = await state.engine.stageFile(file)
    state.previewId = task.id
    showPreview()
  } catch (e) {
    showAddError(friendlyError(e))
  } finally {
    $('#upload-loading').hidden = true
    $('#file-input').value = ''
  }
}

function handleMagnet (ev) {
  ev.preventDefault()
  $('#upload-error').hidden = true
  try {
    const task = state.engine.stageMagnet($('#magnet-input').value)
    state.previewId = task.id
    $('#add-step-pick').hidden = true
    $('#add-step-wait').hidden = false
    $('#wait-hash').textContent = `Info hash ${task.infoHash}`
    $('#wait-hint').textContent = ''
    renderPreviewState()
  } catch (e) {
    showAddError(friendlyError(e))
  }
}

function renderPreviewState () {
  const task = state.engine.tasks.get(state.previewId)
  if (!task) {
    if (!$('#add-modal').hidden && !$('#add-step-wait').hidden) {
      resetAdd(true); setTab('magnet'); showAddError('The preview was cancelled or expired.')
    }
    return
  }
  if (task.confirmed) return
  if (task.error) {
    const tab = task.kind === 'magnet' ? 'magnet' : 'file'
    resetAdd(true)
    setTab(tab)
    showAddError(task.error)
    state.engine.cancelPreview(task.id)
    return
  }
  if (!task.meta) {
    const waited = (Date.now() - task.addedAt) / 1000
    $('#wait-hint').textContent = waited > 15
      ? `Still waiting after ${Math.round(waited)} s. ${task.hint || 'No WebRTC peers have answered yet. If this torrent is only shared by desktop clients, a browser cannot reach it.'}`
      : ''
    return
  }
  if ($('#add-step-preview').hidden) showPreview()
}

function showPreview () {
  const task = state.engine.tasks.get(state.previewId)
  if (!task?.meta) return
  const m = task.meta
  state.previewSelected = new Set(m.files.map(f => f.index))
  $('#add-step-pick').hidden = true
  $('#add-step-wait').hidden = true
  $('#add-step-preview').hidden = false
  $('#pv-name').textContent = m.name
  $('#pv-size').textContent = formatBytes(m.length)
  $('#pv-files').textContent = String(m.files.length)
  $('#pv-pieces').textContent = `${m.pieceCount} × ${formatBytes(m.pieceLength)}`
  $('#pv-private').textContent = m.private ? 'Yes' : 'No'
  $('#pv-hash').textContent = m.infoHash
  const trackerLines = [...m.trackers]
  if (!m.private && state.settings.useDefaultTrackers) trackerLines.push('+ public WebTorrent trackers (see Settings)')
  $('#pv-trackers').textContent = trackerLines.length ? trackerLines.join('\n') : 'No WebSocket trackers'
  const warnings = []
  if (m.unusableTrackers.length) warnings.push(`${m.unusableTrackers.length} tracker(s) use UDP/HTTP, which browsers cannot use. Peers are only found through WebSocket trackers.`)
  if (m.private) warnings.push('Private torrent: no extra trackers are added, and its own trackers are usually unreachable from a browser.')
  if (m.webSeeds.length) warnings.push(state.settings.allowWebSeeds ? `${m.webSeeds.length} HTTPS web seed(s) will be used if their servers allow cross-origin requests.` : 'Web seeds are turned off in Settings.')
  $('#pv-warnings').replaceChildren(...warnings.map(w => h('p', { class: 'flex items-start gap-1.5' }, icon('TriangleAlert', '!h-3.5 !w-3.5 mt-0.5 shrink-0'), h('span', { text: w }))))
  const caps = saveCapabilities()
  $('#pv-dest-folder').disabled = !caps.folderPicker
  $('#pv-folder-text').textContent = caps.folderPicker ? 'Writes straight to disk in a folder you choose.' : 'Not supported in this browser (Chrome/Edge desktop only).'
  $('#pv-folder-option').classList.toggle('opacity-50', !caps.folderPicker)
  navigator.storage?.estimate?.().then(e => {
    $('#pv-storage').textContent = `${formatBytes(Math.max(0, (e.quota || 0) - (e.usage || 0)))} available.`
  }).catch(() => {})
  $('#pv-file-list').replaceChildren(...m.files.map(f => h('li', { class: 'flex items-center gap-3 px-3 py-2' },
    h('input', { type: 'checkbox', class: 'accent-sky-600', 'data-index': f.index, checked: true, id: `pvf-${f.index}` }),
    h('label', { for: `pvf-${f.index}`, class: 'min-w-0 flex-1 truncate', title: f.path, text: f.path }),
    h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500', text: formatBytes(f.length) }))))
  updatePreviewSelection()
  $('#pv-confirm').focus()
}
function updatePreviewSelection () {
  const task = state.engine.tasks.get(state.previewId)
  if (!task?.meta) return
  const size = task.meta.files.filter(f => state.previewSelected.has(f.index)).reduce((a, f) => a + f.length, 0)
  $('#pv-selected').textContent = `· ${state.previewSelected.size} of ${task.meta.files.length} selected · ${formatBytes(size)}`
  $('#pv-confirm').disabled = state.previewSelected.size === 0
}
async function pickFolder () {
  try {
    state.folderHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'torrent-dest' })
    $('#pv-folder-name').textContent = state.folderHandle.name
  } catch (e) {
    if (e?.name !== 'AbortError') toast(friendlyError(e), 'error')
  }
}
async function confirmAdd () {
  const btn = $('#pv-confirm')
  btn.disabled = true
  $('#confirm-error').hidden = true
  const destination = $('input[name="pv-dest"]:checked')?.value || 'browser'
  try {
    if (destination === 'folder' && !state.folderHandle) await pickFolder()
    if (destination === 'folder' && !state.folderHandle) throw new Error('Choose a folder first.')
    const task = await state.engine.confirm(state.previewId, { selected: [...state.previewSelected], destination, dirHandle: state.folderHandle })
    state.previewId = null
    $('#add-modal').hidden = true
    toast(`${task.queued ? 'Queued' : 'Started'}: ${task.name}`, 'success')
    if (!['dashboard', 'active'].includes(state.view)) setView('dashboard')
    scheduleRender()
  } catch (e) {
    const el = $('#confirm-error')
    el.replaceChildren(icon('CircleAlert', 'mt-0.5'), h('span', { text: friendlyError(e) }))
    el.hidden = false
  } finally { btn.disabled = state.previewSelected.size === 0 }
}

// ---------------------------------------------------------------- remove
function openRemove (id) {
  const t = state.snapshot.torrents.find(x => x.id === id)
  if (!t) return
  state.removeId = id
  $('#remove-name').textContent = t.name
  const unsaved = t.destination === 'browser' ? Math.max(0, t.selectedCount - t.savedCount) : 0
  $('#remove-explain').textContent = t.destination === 'folder'
    ? 'Stops the download and removes it from the list. Files already written to your folder are kept.'
    : 'Stops the download and deletes its data from browser storage.'
  const needConfirm = t.destination === 'browser' && unsaved > 0 && t.downloaded > 0
  $('#remove-confirm-row').hidden = !needConfirm
  $('#remove-confirm-text').textContent = `${unsaved} file(s) have not been saved to your device and will be lost.`
  $('#remove-confirm-check').checked = false
  $('#remove-ok').disabled = needConfirm
  $('#remove-modal').hidden = false
  $('#remove-cancel').focus()
}
function closeRemove () { state.removeId = null; $('#remove-modal').hidden = true }

// ---------------------------------------------------------------- settings
function fillSettings () {
  const f = $('#settings-form')
  for (const [k, v] of Object.entries(state.settings)) {
    const el = f.elements[k]
    if (!el) continue
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v
  }
  $$('.field-error').forEach(e => { e.textContent = '' })
  $('#settings-status').textContent = ''
}
function readSettingsForm () {
  const body = {}
  for (const el of $('#settings-form').elements) {
    if (!el.name) continue
    body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value
  }
  return body
}
function commitSettings (values) {
  state.settings = values
  saveSettings(values)
  applyTheme(values.theme)
  state.engine?.applySettings(values)
}
function onSaveSettings (ev) {
  ev.preventDefault()
  $$('.field-error').forEach(e => { e.textContent = '' })
  try {
    const clean = validateSettings(readSettingsForm())
    commitSettings({ ...state.settings, ...clean })
    if (clean.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission()
    $('#settings-status').textContent = 'Saved'
    toast('Settings saved', 'success', 2500)
    fillSettings()
    $('#settings-status').textContent = 'Saved'
  } catch (e) {
    if (e instanceof SettingsError) {
      for (const [k, msg] of Object.entries(e.fields)) { const el = $(`.field-error[data-for="${k}"]`); if (el) el.textContent = msg }
      toast('Some settings are invalid.', 'error')
    } else toast(friendlyError(e), 'error')
  }
}

// ---------------------------------------------------------------- history & logs
function renderHistory () {
  const list = loadHistory()
  const body = $('#history-body')
  if (!list.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'px-4 py-8 text-center text-slate-500', text: state.settings.keepHistory ? 'No history yet' : 'History is turned off in Settings' })))
    return
  }
  body.replaceChildren(...list.map(r => h('tr', {},
    h('td', { class: 'max-w-xs truncate px-4 py-2.5', title: r.name, text: r.name }),
    h('td', { class: 'px-4 py-2.5 tabular-nums', text: formatBytes(r.size) }),
    h('td', { class: 'px-4 py-2.5', text: formatDate(r.addedAt) }),
    h('td', { class: 'px-4 py-2.5', text: formatDate(r.completedAt) }),
    h('td', { class: 'px-4 py-2.5', text: r.outcome }))))
}
function renderLogs () {
  const pre = $('#logs-pre')
  pre.textContent = state.logs.join('\n') || 'Nothing logged yet.'
  pre.scrollTop = pre.scrollHeight
}
function remember (task, outcome) {
  if (!state.settings.keepHistory || !task.confirmed) return
  recordHistory({ infoHash: task.infoHash, name: task.name, size: task.selectedBytes, addedAt: task.addedAt, completedAt: task.completedAt, outcome })
}

// ---------------------------------------------------------------- environment
async function acquireInstanceLock () {
  if (!navigator.locks?.request) return true
  return new Promise(resolve => {
    navigator.locks.request('btd-app-instance', { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return undefined }
      resolve(true)
      return new Promise(() => {}) // held for the lifetime of the page
    }).catch(() => resolve(true))
  })
}

function refreshStorage () {
  navigator.storage?.estimate?.().then(e => {
    $('#storage-free').textContent = formatBytes(Math.max(0, (e.quota || 0) - (e.usage || 0)))
  }).catch(() => { $('#storage-free').textContent = 'unknown' })
}

function checkSupport (caps) {
  const problems = []
  if (!caps.webrtc) problems.push('WebRTC is not available (disabled by the browser, an extension or a policy), so no peers can be reached.')
  if (!caps.opfs) problems.push('Browser file storage (OPFS) is unavailable, e.g. in some private windows. Use "Folder on this device" in Chrome/Edge.')
  if (problems.length) {
    $('#banner-unsupported-text').textContent = problems.join(' ')
    $('#banner-unsupported').hidden = false
  }
}

// ---------------------------------------------------------------- wiring
function wire () {
  hydrateIcons()
  $$('.nav-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)))
  $('#menu-btn').addEventListener('click', () => { $('#sidebar').classList.remove('-translate-x-full'); $('#sidebar-backdrop').hidden = false })
  $('#sidebar-backdrop').addEventListener('click', closeSidebar)
  $('#add-btn').addEventListener('click', openAdd)
  document.addEventListener('click', e => { if (e.target.closest('[data-action="open-add"]')) openAdd() })
  $('#add-close').addEventListener('click', closeAdd)
  $('#pv-cancel').addEventListener('click', closeAdd)
  $('#wait-cancel').addEventListener('click', closeAdd)
  $('#pv-confirm').addEventListener('click', confirmAdd)
  $('#pv-pick-folder').addEventListener('click', pickFolder)
  $$('input[name="pv-dest"]').forEach(r => r.addEventListener('change', () => { $('#pv-folder-row').hidden = $('input[name="pv-dest"]:checked').value !== 'folder' }))
  $$('[role="tab"]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('#magnet-form').addEventListener('submit', handleMagnet)
  $('#file-input').addEventListener('change', e => handleFile(e.target.files[0]))
  $('#pv-all').addEventListener('click', () => { $$('#pv-file-list input').forEach(c => { c.checked = true; state.previewSelected.add(+c.dataset.index) }); updatePreviewSelection() })
  $('#pv-none').addEventListener('click', () => { $$('#pv-file-list input').forEach(c => { c.checked = false }); state.previewSelected.clear(); updatePreviewSelection() })
  $('#pv-file-list').addEventListener('change', e => {
    const c = e.target
    if (!c.dataset.index) return
    if (c.checked) state.previewSelected.add(+c.dataset.index); else state.previewSelected.delete(+c.dataset.index)
    updatePreviewSelection()
  })

  let dragDepth = 0
  window.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#drag-overlay').hidden = false } })
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drag-overlay').hidden = true })
  window.addEventListener('dragover', e => e.preventDefault())
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('#drag-overlay').hidden = true
    const f = e.dataTransfer?.files?.[0]
    if (f && state.engine) handleFile(f)
  })

  $('#drawer-close').addEventListener('click', closeDrawer)
  $('#drawer-backdrop').addEventListener('click', closeDrawer)
  $('#drawer-files').addEventListener('change', () => { state.drawerDirty = true; $('#drawer-apply-files').disabled = false })
  $('#drawer-files').addEventListener('click', e => { const b = e.target.closest('[data-save]'); if (b) saveOne(state.detailId, +b.dataset.save) })
  $('#drawer-select-all').addEventListener('click', () => { $$('#drawer-files input').forEach(c => { c.checked = true }); state.drawerDirty = true; $('#drawer-apply-files').disabled = false })
  $('#drawer-select-none').addEventListener('click', () => { $$('#drawer-files input').forEach(c => { c.checked = false }); state.drawerDirty = true; $('#drawer-apply-files').disabled = false })
  $('#drawer-apply-files').addEventListener('click', () => {
    const sel = $$('#drawer-files input').filter(c => c.checked).map(c => +c.dataset.index)
    try { state.engine.setSelection(state.detailId, sel); toast('File selection updated', 'success', 2500); renderDrawer(true) } catch (e) { toast(friendlyError(e), 'error') }
  })
  $('#drawer-save-all').addEventListener('click', () => saveAll(state.detailId))
  $('#drawer-remove').addEventListener('click', () => openRemove(state.detailId))

  $('#remove-cancel').addEventListener('click', closeRemove)
  $('#remove-confirm-check').addEventListener('change', e => { $('#remove-ok').disabled = !e.target.checked })
  $('#remove-ok').addEventListener('click', () => {
    const id = state.removeId
    if (!id) return
    try { state.engine.remove(id); if (state.detailId === id) closeDrawer(); closeRemove() } catch (e) { toast(friendlyError(e), 'error') }
  })

  $('#pause-all').addEventListener('click', () => toast(`Paused ${state.engine?.pauseAll() || 0} download(s)`, 'info', 2500))
  $('#resume-all').addEventListener('click', () => toast(`Resumed ${state.engine?.resumeAll() || 0} download(s)`, 'info', 2500))
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
    commitSettings({ ...state.settings, theme: next })
    $('#s-theme').value = next
  })
  $('#settings-form').addEventListener('submit', onSaveSettings)
  $('#settings-reset').addEventListener('click', () => { commitSettings({ ...DEFAULTS }); fillSettings(); toast('Settings reset to defaults', 'info', 2500) })
  $('#history-clear').addEventListener('click', () => { clearHistory(); renderHistory(); toast('History cleared', 'info', 2500) })
  $('#logs-clear').addEventListener('click', () => { state.logs = []; renderLogs() })

  let noticeClosed = false
  try { noticeClosed = localStorage.getItem('btd.notice') === 'closed' } catch { /* ignore */ }
  $('#banner-notice').hidden = noticeClosed
  $('#banner-notice-close').addEventListener('click', () => { $('#banner-notice').hidden = true; try { localStorage.setItem('btd.notice', 'closed') } catch { /* ignore */ } })
  const onlineState = () => { $('#banner-offline').hidden = navigator.onLine; if (state.engine) scheduleRender() }
  window.addEventListener('online', () => { onlineState(); log('info', 'Back online') })
  window.addEventListener('offline', () => { onlineState(); log('warn', 'Network connection lost') })
  onlineState()

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    if (!$('#remove-modal').hidden) closeRemove()
    else if (!$('#add-modal').hidden) closeAdd()
    else if (state.detailId) closeDrawer()
  })
  window.addEventListener('beforeunload', e => {
    const active = state.snapshot.torrents?.some(t => LIVE.has(t.status) || t.status === 'queued')
    if (active) { e.preventDefault(); e.returnValue = '' }
  })
  window.addEventListener('pagehide', () => state.engine?.destroy())
}

async function init () {
  applyTheme(state.settings.theme)
  wire()
  let view = 'dashboard'
  try { view = localStorage.getItem('btd.view') || 'dashboard' } catch { /* ignore */ }
  setView(view)

  if (!(await acquireInstanceLock())) {
    $('#instance-overlay').hidden = false
    hydrateIcons($('#instance-overlay'))
    $('#conn-text').textContent = 'Open in another tab'
    return
  }
  registerDownloadWorker()
  const engine = new TorrentEngine({ settings: state.settings, log })
  try {
    await engine.init()
  } catch (e) {
    $('#banner-unsupported-text').textContent = `The torrent engine could not start: ${friendlyError(e)}`
    $('#banner-unsupported').hidden = false
    $('#conn-text').textContent = 'Engine failed to start'
    return
  }
  state.engine = engine
  window.__btd = engine // for diagnostics in the browser console
  checkSupport(engine.capabilities)
  engine.addEventListener('update', scheduleRender)
  engine.addEventListener('completed', e => {
    const task = e.detail
    remember(task, 'Completed')
    toast(`Download complete: ${task.name}`, 'success')
    if (state.settings.notifications && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Download complete', { body: task.name, icon: '/icon.svg' }) } catch { /* ignore */ }
    }
  })
  engine.addEventListener('removed', e => { if (!e.detail.completedAt) remember(e.detail, 'Removed before completion') })
  $('#add-btn').disabled = false
  refreshStorage()
  setInterval(refreshStorage, 15000)
  scheduleRender()
}

init()
