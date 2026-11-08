import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { chromium, expect, firefox } from '@playwright/test'

export const TRACKER = () => process.env.TEST_TRACKER

/** Settings applied before the app loads: only the local tracker, short stall timeout. */
export function testSettings (extra = {}) {
  return {
    useDefaultTrackers: false,
    trackers: TRACKER(),
    allowWebSeeds: false,
    stallSeconds: 10,
    ...extra
  }
}

/** Open the app in a fresh context with test settings. Collects CSP violations and errors. */
export async function openApp (browser, { settings = {}, removeSavePicker = true, viewport } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: viewport || { width: 1360, height: 900 } })
  await context.addInitScript(({ s, removePicker }) => {
    try {
      if (!sessionStorage.getItem('test-init')) {
        localStorage.setItem('btd.settings.v1', JSON.stringify(s))
        localStorage.setItem('btd.notice', 'closed')
        sessionStorage.setItem('test-init', '1')
      }
    } catch { /* opaque origins */ }
    // Native "Save as" dialogs cannot be automated: force the streaming download path.
    if (removePicker) { try { delete window.showSaveFilePicker } catch { window.showSaveFilePicker = undefined } }
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', e => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
  }, { s: testSettings(settings), removePicker: removeSavePicker })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#add-btn')).toBeEnabled({ timeout: 20_000 })
  return { context, page, errors }
}

/**
 * Seed generated files from the app's own WebTorrent client in a separate context.
 * Returns the magnet link, .torrent bytes and SHA-256 of every file.
 */
export async function seedFiles (page, files, { name = 'Test Pack', uploadLimit = 0 } = {}) {
  return page.evaluate(async ({ files, name, tracker, uploadLimit }) => {
    const engine = window.__btd
    const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
    const objs = []
    const hashes = {}
    for (const f of files) {
      const data = new Uint8Array(f.size)
      for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536))
      hashes[f.name] = toHex(await crypto.subtle.digest('SHA-256', data))
      objs.push(new File([data], f.name))
    }
    if (uploadLimit) engine.client.throttleUpload(uploadLimit)
    const torrent = await new Promise((resolve, reject) => {
      const t = engine.client.seed(objs, { announce: [tracker], name }, resolve)
      t.on('error', e => reject(String(e)))
    })
    window.__seeded = torrent
    return { magnet: torrent.magnetURI, torrentB64: btoa(String.fromCharCode(...torrent.torrentFile)), hashes, infoHash: torrent.infoHash }
  }, { files, name, tracker: TRACKER(), uploadLimit })
}

export const sha256 = buf => createHash('sha256').update(buf).digest('hex')

export async function savedFileHash (download) {
  const p = await download.path()
  return sha256(fs.readFileSync(p))
}

export async function addMagnet (page, magnet) {
  await page.click('#add-btn')
  await page.click('[data-tab="magnet"]')
  await page.fill('#magnet-input', magnet)
  await page.click('#magnet-submit')
}

export function card (page) {
  return page.locator('[data-testid="torrent-card"]').first()
}

export async function waitForBadge (page, label, timeout = 60_000) {
  await expect(card(page).locator('[data-role="badge"]')).toHaveText(label, { timeout })
}

export async function waitForWorker (page) {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 })
}

/** A second browser of a different engine for cross-browser WebRTC tests. */
export async function launchOther (browserName) {
  return browserName === 'firefox'
    ? chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
    : firefox.launch({ firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } })
}
