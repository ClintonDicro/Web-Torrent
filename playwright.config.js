import { defineConfig } from '@playwright/test'

const PORT = 4180
const chromiumArgs = ['--disable-features=WebRtcHideLocalIpsWithMdns']
const firefoxPrefs = { 'media.peerconnection.ice.obfuscate_host_addresses': false }

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  globalSetup: './tests/e2e/global-setup.mjs',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ignoreHTTPSErrors: true, // local test tracker uses a self-signed certificate
    acceptDownloads: true,
    trace: 'retain-on-failure'
  },
  webServer: {
    // Serves the production build with the real _headers (CSP etc.) applied.
    command: `node scripts/serve-dist.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: chromiumArgs } } },
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome', launchOptions: { args: chromiumArgs } } },
    { name: 'msedge', use: { browserName: 'chromium', channel: 'msedge', launchOptions: { args: chromiumArgs } } },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: firefoxPrefs } } }
  ]
})
