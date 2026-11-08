// End-to-end tests: real WebRTC transfers between two browser contexts through a local
// WSS tracker, against the production build served with the production _headers (CSP).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  addMagnet, card, launchOther, openApp, savedFileHash, seedFiles, waitForBadge, waitForWorker
} from './helpers.js'

const isChromiumFamily = name => name === 'chromium'

test.describe('Browser torrent downloader', () => {
  let seeder

  test.beforeEach(async ({ browser }) => {
    seeder = await openApp(browser)
  })
  test.afterEach(async () => {
    await seeder?.context.close()
  })

  test('loads under the production CSP with security headers and no errors', async ({ browser, request }) => {
    const res = await request.get('/')
    const h = res.headers()
    expect(h['content-security-policy']).toContain("script-src 'self'")
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['referrer-policy']).toBe('no-referrer')
    expect(h['permissions-policy']).toContain('camera=()')
    const { page, errors, context } = await openApp(browser)
    await expect(page.locator('#conn-text')).toContainText('WebRTC')
    await expect(page.locator('#banner-unsupported')).toBeHidden()
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
    expect(errors).toEqual([])
    await context.close()
  })

  test('magnet link: preview, file selection, live progress, completion and save', async ({ browser }) => {
    const seed = await seedFiles(seeder.page, [{ name: 'movie.bin', size: 1_500_000 }, { name: 'extra.bin', size: 300_000 }], { name: 'Magnet Pack', uploadLimit: 400 * 1024 })
    const { page, errors, context } = await openApp(browser)
    await addMagnet(page, seed.magnet)
    await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#pv-name')).toHaveText('Magnet Pack')
    await expect(page.locator('#pv-files')).toHaveText('2')
    await expect(page.locator('#pv-hash')).toHaveText(seed.infoHash)
    await expect(page.locator('#pv-file-list li')).toHaveCount(2)
    // Select only movie.bin
    await page.click('#pv-none')
    await expect(page.locator('#pv-confirm')).toBeDisabled()
    await page.locator('#pv-file-list label', { hasText: 'movie.bin' }).click()
    await expect(page.locator('#pv-selected')).toContainText('1 of 2 selected')
    await page.click('#pv-confirm')

    const pct = card(page).locator('[data-role="pct"]')
    const seen = new Set()
    await expect.poll(async () => {
      seen.add(await pct.textContent())
      return card(page).locator('[data-role="badge"]').textContent()
    }, { timeout: 60_000, intervals: [200] }).toContain('Completed')
    expect(seen.size, `progress should update live, saw ${[...seen]}`).toBeGreaterThanOrEqual(3)
    await expect(pct).toHaveText('100.0%')
    await expect(card(page).locator('[data-role="sizes"]')).toContainText('1.4 MB of 1.4 MB')

    // The unselected file must not be complete.
    const files = await page.evaluate(() => { const e = window.__btd; const t = [...e.tasks.values()][0]; return e.files(t.id) })
    expect(files.find(f => f.name === 'extra.bin')).toMatchObject({ selected: false, done: false })

    await waitForWorker(page)
    const downloadPromise = page.waitForEvent('download')
    await card(page).locator('[data-act="save"]').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('movie.bin')
    expect(await savedFileHash(download)).toBe(seed.hashes['movie.bin'])
    expect(errors).toEqual([])
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
    await context.close()
  })

  test('.torrent upload: preview, download and save multi-file content', async ({ browser }, testInfo) => {
    const seed = await seedFiles(seeder.page, [{ name: 'a.bin', size: 400_000 }, { name: 'b.bin', size: 250_000 }], { name: 'Upload Pack' })
    const torrentPath = testInfo.outputPath('upload.torrent')
    fs.mkdirSync(path.dirname(torrentPath), { recursive: true })
    fs.writeFileSync(torrentPath, Buffer.from(seed.torrentB64, 'base64'))

    const { page, context } = await openApp(browser)
    await page.click('#add-btn')
    await page.setInputFiles('#file-input', torrentPath)
    await expect(page.locator('#add-step-preview')).toBeVisible()
    await expect(page.locator('#pv-name')).toHaveText('Upload Pack')
    await expect(page.locator('#pv-size')).toHaveText('635 KB')
    await expect(page.locator('#pv-trackers')).toContainText('wss://127.0.0.1')
    await page.click('#pv-confirm')
    await waitForBadge(page, 'Completed')

    await waitForWorker(page)
    await card(page).locator('button.icon-btn[data-act="details"]').click()
    await expect(page.locator('#drawer-files li')).toHaveCount(2)
    for (const name of ['a.bin', 'b.bin']) {
      const row = page.locator('#drawer-files li', { hasText: name })
      const dl = page.waitForEvent('download')
      await row.locator('[data-save]').click()
      expect(await savedFileHash(await dl)).toBe(seed.hashes[name])
    }
    await context.close()
  })

  test('pause stops progress and resume completes the download', async ({ browser }) => {
    const seed = await seedFiles(seeder.page, [{ name: 'slow.bin', size: 2_000_000 }], { name: 'Slow', uploadLimit: 150 * 1024 })
    const { page, context } = await openApp(browser)
    await addMagnet(page, seed.magnet)
    await page.click('#pv-confirm')
    const downloaded = () => page.evaluate(() => window.__btd.snapshot().torrents[0]?.downloaded || 0)
    await expect.poll(downloaded, { timeout: 30_000 }).toBeGreaterThan(100_000)
    await card(page).locator('[data-act="pause"]').click()
    await waitForBadge(page, 'Paused', 5_000)
    await page.waitForTimeout(1500)
    const d1 = await downloaded()
    await page.waitForTimeout(3000)
    expect(await downloaded()).toBe(d1)
    await expect(card(page).locator('[data-act="resume"]')).toBeVisible()
    await seeder.page.evaluate(() => window.__btd.client.throttleUpload(-1))
    await card(page).locator('[data-act="resume"]').click()
    await waitForBadge(page, 'Completed')
    await waitForWorker(page)
    const dl = page.waitForEvent('download')
    await card(page).locator('[data-act="save"]').click()
    expect(await savedFileHash(await dl)).toBe(seed.hashes['slow.bin'])
    await context.close()
  })

  test('errors: invalid magnet, invalid torrent, no peers, unreachable tracker, offline', async ({ browser }, testInfo) => {
    const { page, context } = await openApp(browser)
    await addMagnet(page, 'https://example.com/not-a-magnet')
    await expect(page.locator('#upload-error')).toContainText('not a magnet link')
    await page.fill('#magnet-input', 'magnet:?xt=urn:btih:1234')
    await page.click('#magnet-submit')
    await expect(page.locator('#upload-error')).toContainText('no valid BitTorrent info hash')

    await page.click('[data-tab="file"]')
    const bad = testInfo.outputPath('broken.torrent')
    fs.mkdirSync(path.dirname(bad), { recursive: true })
    fs.writeFileSync(bad, 'this is not bencode')
    await page.setInputFiles('#file-input', bad)
    await expect(page.locator('#upload-error')).toContainText('not a valid torrent')
    const txt = testInfo.outputPath('notes.txt')
    fs.writeFileSync(txt, 'hello')
    await page.setInputFiles('#file-input', txt)
    await expect(page.locator('#upload-error')).toContainText('Only .torrent files')

    // A torrent nobody seeds, announced to an unreachable tracker as well.
    await page.click('[data-tab="magnet"]')
    await page.fill('#magnet-input', 'magnet:?xt=urn:btih:' + 'ab'.repeat(20) + '&dn=Nobody&tr=' + encodeURIComponent('wss://127.0.0.1:9'))
    await page.click('#magnet-submit')
    await expect(page.locator('#add-step-wait')).toBeVisible()
    await expect(page.locator('#wait-hint')).toContainText('No WebRTC peers', { timeout: 40_000 })
    await page.click('#wait-cancel')
    await page.click('[data-view="logs"]')
    await expect(page.locator('#logs-pre')).toContainText('127.0.0.1:9', { timeout: 20_000 })

    await context.setOffline(true)
    await expect(page.locator('#banner-offline')).toBeVisible()
    await context.setOffline(false)
    await expect(page.locator('#banner-offline')).toBeHidden()
    await context.close()
  })

  test('untrusted names are shown as text, never as HTML', async ({ browser }) => {
    const evil = '<img src=x onerror="window.__xss=1">.txt'
    const seed = await seedFiles(seeder.page, [{ name: evil, size: 20_000 }], { name: '<b onmouseover=alert(1)>Pack' })
    const { page, context } = await openApp(browser)
    await addMagnet(page, seed.magnet)
    await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#pv-name')).toHaveText('<b onmouseover=alert(1)>Pack')
    await page.click('#pv-confirm')
    await waitForBadge(page, 'Completed')
    expect(await page.locator('#app img, #add-modal img, b[onmouseover]').count()).toBe(0)
    expect(await page.evaluate(() => window.__xss)).toBeUndefined()
    // The saved file name is sanitised for the file system.
    await waitForWorker(page)
    const dl = page.waitForEvent('download')
    await card(page).locator('[data-act="save"]').click()
    const name = (await dl).suggestedFilename()
    expect(name).not.toMatch(/[<>"/\\]/)
    await context.close()
  })

  test('per-session limit and removing a download frees browser storage', async ({ browser }) => {
    const s1 = await seedFiles(seeder.page, [{ name: 'one.bin', size: 120_000 }], { name: 'One' })
    const s2 = await seedFiles(seeder.page, [{ name: 'two.bin', size: 120_000 }], { name: 'Two' })
    const { page, context } = await openApp(browser, { settings: { maxTorrentsPerSession: 1 } })
    await addMagnet(page, s1.magnet)
    await page.click('#pv-confirm')
    await waitForBadge(page, 'Completed')
    await addMagnet(page, s2.magnet)
    await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 30_000 })
    await page.click('#pv-confirm')
    await expect(page.locator('#confirm-error')).toContainText('at most 1 torrents per session')
    await page.click('#pv-cancel')

    const before = await page.evaluate(async () => { const out = []; for await (const k of (await navigator.storage.getDirectory()).keys()) out.push(k); return out })
    expect(before.some(n => n.startsWith('One - '))).toBe(true)
    await card(page).locator('[data-act="remove"]').click()
    await expect(page.locator('#remove-confirm-row')).toBeVisible() // file was never saved
    await expect(page.locator('#remove-ok')).toBeDisabled()
    await page.check('#remove-confirm-check')
    await page.click('#remove-ok')
    await expect(page.locator('[data-testid="torrent-card"]')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(async () => { const out = []; for await (const k of (await navigator.storage.getDirectory()).keys()) out.push(k); return out.filter(n => n.startsWith('One - ')) })).toEqual([])
    await context.close()
  })

  test('queue: only the configured number of downloads run at once', async ({ browser }) => {
    const seeds = []
    for (const n of ['Q1', 'Q2', 'Q3']) seeds.push(await seedFiles(seeder.page, [{ name: `${n}.bin`, size: 600_000 }], { name: n, uploadLimit: 300 * 1024 }))
    const { page, context } = await openApp(browser, { settings: { maxActive: 1 } })
    for (const s of seeds) {
      await addMagnet(page, s.magnet)
      await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 30_000 })
      await page.click('#pv-confirm')
      await expect(page.locator('#add-modal')).toBeHidden()
    }
    let maxRunning = 0
    let sawQueued = false
    await expect.poll(async () => {
      const ts = await page.evaluate(() => window.__btd.snapshot().torrents.map(t => t.status))
      maxRunning = Math.max(maxRunning, ts.filter(s => ['downloading', 'finding_peers', 'stalled'].includes(s)).length)
      sawQueued ||= ts.includes('queued')
      return ts.filter(s => s === 'completed').length
    }, { timeout: 90_000, intervals: [250] }).toBe(3)
    expect(maxRunning).toBeLessThanOrEqual(1)
    expect(sawQueued).toBe(true)
    await context.close()
  })

  test('settings are validated and persisted', async ({ browser }) => {
    const { page, context } = await openApp(browser)
    await page.click('[data-view="settings"]')
    await page.fill('#s-maxActive', '9')
    await page.fill('#s-trackers', 'udp://tracker.example:1337')
    await page.click('#settings-save')
    await expect(page.locator('.field-error[data-for="maxActive"]')).toContainText('between 1 and 5')
    await expect(page.locator('.field-error[data-for="trackers"]')).toContainText('wss://')
    await page.fill('#s-maxActive', '4')
    await page.fill('#s-trackers', 'wss://tracker.example')
    await page.click('#settings-save')
    await expect(page.locator('#settings-status')).toHaveText('Saved')
    await page.reload()
    await page.click('[data-view="settings"]')
    await expect(page.locator('#s-maxActive')).toHaveValue('4')
    await context.close()
  })

  test('only one app tab can run at a time', async ({ browser }) => {
    const { page, context } = await openApp(browser)
    const second = await context.newPage()
    await second.goto('/')
    await expect(second.locator('#instance-overlay')).toBeVisible()
    await expect(page.locator('#instance-overlay')).toBeHidden()
    await context.close()
  })

  test('responsive layout on a phone-sized screen', async ({ browser }) => {
    const { page, context } = await openApp(browser, { viewport: { width: 390, height: 844 } })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const box = await page.locator('#sidebar').boundingBox()
    expect(box.x + box.width).toBeLessThanOrEqual(0)
    await page.click('#menu-btn')
    await page.click('[data-view="about"]')
    await expect(page.locator('#view-about')).toBeVisible()
    await page.click('#add-btn')
    await page.click('[data-tab="magnet"]')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await context.close()
  })

  test('folder destination writes straight to the chosen folder (Chromium)', async ({ browser, browserName }) => {
    test.skip(!isChromiumFamily(browserName), 'showDirectoryPicker is Chromium-only')
    const seed = await seedFiles(seeder.page, [{ name: 'disk.bin', size: 500_000 }], { name: 'Disk Pack' })
    const { page, context } = await openApp(browser)
    // The native folder picker can't be automated: stand in an OPFS folder the test can read back.
    await page.evaluate(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
    })
    await addMagnet(page, seed.magnet)
    await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 30_000 })
    await page.check('#pv-dest-folder')
    await page.click('#pv-pick-folder')
    await expect(page.locator('#pv-folder-name')).toHaveText('picked')
    await page.click('#pv-confirm')
    await waitForBadge(page, 'Completed')
    const hashOnDisk = async () => page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const picked = await root.getDirectoryHandle('picked')
      // Expected layout: <picked>/<torrent name> - <hash8>/<torrent path>
      for await (const [name, h] of picked.entries()) {
        if (!name.startsWith('Disk Pack - ') || h.kind !== 'directory') continue
        const stack = [h]
        while (stack.length) {
          const dir = stack.pop()
          for await (const child of dir.values()) {
            if (child.kind === 'directory') { stack.push(child); continue }
            const f = await child.getFile()
            if (f.size !== 500000) continue
            const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer())
            return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
          }
        }
      }
      return null
    })
    await expect.poll(hashOnDisk, { timeout: 15_000 }).toBe(seed.hashes['disk.bin'])
    // Removing the task must keep the user's files.
    await card(page).locator('[data-act="remove"]').click()
    await page.click('#remove-ok')
    await expect(page.locator('[data-testid="torrent-card"]')).toHaveCount(0)
    await page.waitForTimeout(1000)
    expect(await hashOnDisk()).toBe(seed.hashes['disk.bin'])
    await context.close()
  })

  test('Chrome/Edge save paths: "Save as" stream and "Save all to folder"', async ({ browser, browserName }) => {
    test.skip(!isChromiumFamily(browserName), 'File System Access pickers are Chromium-only')
    const seed = await seedFiles(seeder.page, [{ name: 'x1.bin', size: 300_000 }, { name: 'x2.bin', size: 200_000 }], { name: 'Pickers' })
    // Keep the real showSaveFilePicker path enabled, but answer the dialogs with OPFS handles.
    const { page, context } = await openApp(browser, { removeSavePicker: false })
    await page.evaluate(() => {
      window.showSaveFilePicker = async ({ suggestedName }) => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('saveas', { create: true })
        return dir.getFileHandle(suggestedName, { create: true })
      }
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('saveall', { create: true })
    })
    await addMagnet(page, seed.magnet)
    await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 30_000 })
    await page.click('#pv-confirm')
    await waitForBadge(page, 'Completed')
    const readHash = (dirName, parts) => page.evaluate(async ({ dirName, parts }) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName)
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p)
      const f = await (await dir.getFileHandle(parts[parts.length - 1])).getFile()
      const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer())
      return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
    }, { dirName, parts })

    await card(page).locator('button.icon-btn[data-act="details"]').click()
    await page.locator('#drawer-files li', { hasText: 'x1.bin' }).locator('[data-save]').click()
    await expect.poll(() => readHash('saveas', ['x1.bin']).catch(() => null), { timeout: 15_000 }).toBe(seed.hashes['x1.bin'])

    await page.click('#drawer-save-all')
    await expect.poll(() => readHash('saveall', ['Pickers', 'x2.bin']).catch(() => null), { timeout: 15_000 }).toBe(seed.hashes['x2.bin'])
    expect(await readHash('saveall', ['Pickers', 'x1.bin'])).toBe(seed.hashes['x1.bin'])
    // Saving again must not overwrite: the second copy gets " (1)".
    await page.click('#drawer-save-all')
    await expect.poll(() => readHash('saveall', ['Pickers', 'x1 (1).bin']).catch(() => null), { timeout: 15_000 }).toBe(seed.hashes['x1.bin'])
    await context.close()
  })

  test('cross-browser: a different browser engine seeds, this one downloads', async ({ browser, browserName }, testInfo) => {
    test.skip(!['chromium', 'firefox'].includes(testInfo.project.name), 'one Chromium<->Firefox pairing per engine is enough')
    const other = await launchOther(browserName)
    try {
      const remote = await openApp(other)
      const seed = await seedFiles(remote.page, [{ name: 'cross.bin', size: 800_000 }], { name: 'Cross' })
      const { page, context } = await openApp(browser)
      await addMagnet(page, seed.magnet)
      await page.click('#pv-confirm')
      await waitForBadge(page, 'Completed')
      await waitForWorker(page)
      const dl = page.waitForEvent('download')
      await card(page).locator('[data-act="save"]').click()
      expect(await savedFileHash(await dl)).toBe(seed.hashes['cross.bin'])
      await context.close()
      await remote.context.close()
    } finally {
      await other.close()
    }
  })
})
