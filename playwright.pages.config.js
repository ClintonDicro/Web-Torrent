// Same E2E tests, but against Cloudflare's local Pages emulator (`npm run pages:dev`, port 8788)
// instead of our static server, to confirm Cloudflare applies _headers as expected.
import base from './playwright.config.js'

export default {
  ...base,
  use: { ...base.use, baseURL: 'http://127.0.0.1:8788' },
  webServer: undefined
}
