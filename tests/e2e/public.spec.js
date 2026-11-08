// Opt-in test against the public network: downloads two small files of "Sintel"
// (Blender Foundation, CC BY 3.0), a torrent the WebTorrent project keeps seeded
// over WebRTC. Web seeds are turned OFF, so the data can only come from WebRTC peers.
//
// Run with:  set PUBLIC_TORRENT_TEST=1 && npx playwright test tests/e2e/public.spec.js
// Depends on third-party peers and trackers being online, so it is not part of the default run.
import { expect, test } from '@playwright/test'
import { addMagnet, card, openApp, savedFileHash, waitForWorker } from './helpers.js'

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
// SHA-256 of the reference copies at https://webtorrent.io/torrents/Sintel/
const EXPECTED = {
  'poster.jpg': '153e7e5d393cbec778dd140b7eaf7da123dcc0fdcffdc096d092a90f3ea389c8',
  'Sintel.en.srt': '4ed7e1f1bc5ff69fe33606960e4c048ba6766237bf33b132fef76e1a92cb64b2'
}

test.describe('public WebRTC swarm (opt-in)', () => {
  test.skip(!process.env.PUBLIC_TORRENT_TEST, 'set PUBLIC_TORRENT_TEST=1 to run against the public network')
  test.setTimeout(240_000)

  test('downloads Sintel poster and subtitles from WebRTC peers only', async ({ browser }) => {
    const { page, context, errors } = await openApp(browser, {
      settings: { useDefaultTrackers: true, trackers: '', allowWebSeeds: false, stallSeconds: 120 }
    })
    await addMagnet(page, SINTEL)
    await expect(page.locator('#add-step-preview')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('#pv-name')).toHaveText('Sintel')
    await expect(page.locator('#pv-files')).toHaveText('11')
    await page.click('#pv-none')
    await page.locator('#pv-file-list label', { hasText: 'poster.jpg' }).click()
    await page.locator('#pv-file-list label', { hasText: 'Sintel.en.srt' }).click()
    await page.click('#pv-confirm')

    let maxPeers = 0
    const wireTypes = new Set()
    await expect.poll(async () => {
      const s = await page.evaluate(() => {
        const e = window.__btd
        const t = [...e.tasks.values()][0]
        return { peers: t.torrent?.numPeers || 0, types: (t.torrent?.wires || []).map(w => w.type), status: e.snapshot().torrents[0]?.status }
      })
      maxPeers = Math.max(maxPeers, s.peers)
      s.types.forEach(t => wireTypes.add(t))
      return s.status
    }, { timeout: 180_000, intervals: [500] }).toBe('completed')
    test.info().annotations.push({ type: 'peers', description: `max peers ${maxPeers}, wire types ${[...wireTypes].join(',')}` })
    expect(maxPeers).toBeGreaterThan(0)
    expect(wireTypes.has('webSeed')).toBe(false)

    await waitForWorker(page)
    await card(page).locator('button.icon-btn[data-act="details"]').click()
    for (const [name, hash] of Object.entries(EXPECTED)) {
      const row = page.locator('#drawer-files li', { hasText: name })
      const dl = page.waitForEvent('download')
      await row.locator('[data-save]').click()
      expect(await savedFileHash(await dl), name).toBe(hash)
    }
    expect(errors).toEqual([])
    await context.close()
  })
})
