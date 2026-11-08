# Test Report: Browser Torrent Downloader (WebTorrent)

**Date:** 2026-11-08 · **Machine:** Windows 11 Pro for Workstations, x64 · **Node:** 20.20.0
**Stack:** WebTorrent 3.0.21, Vite 8.3.6, Vitest 4.1.12, Playwright 1.65.0, Wrangler 3.114.17
**Browsers:** Playwright Chromium (Chrome for Testing 158), Google Chrome (installed), Microsoft Edge (installed), Playwright Firefox 159

## Results

| Suite | Command | Result |
|---|---|---|
| Unit (Vitest) | `npm test` | **67 passed** |
| Production build + dist check | `npm run build` | **Passed**: 8 files, ~370 KiB, all limits met |
| End-to-end, 4 browsers, local WebRTC swarm | `npm run test:e2e` | **52 passed, 0 failed, 8 skipped (intentional)** |
| Public WebRTC torrent (Sintel, opt-in) | `PUBLIC_TORRENT_TEST=1 npx playwright test tests/e2e/public.spec.js` | **4 passed** (Chromium, Chrome, Edge, Firefox) |
| Same E2E tests against Cloudflare's Pages emulator (`wrangler pages dev dist`) | `npx playwright test -c playwright.pages.config.js` | **8 passed** (Chromium + Firefox: CSP, magnet flow, pause/resume, untrusted names) |

Logs: `unit-output.txt`, `e2e-output.txt`, `e2e-public-output.txt`, `e2e-pages-output.txt`
(in this folder; not committed).

Intentional skips: folder destination and File System Access pickers on Firefox (Chromium-only
APIs, ×2), cross-browser pairing under the Chrome/Edge projects (one Chromium↔Firefox pairing is
enough, ×2), public-network test without `PUBLIC_TORRENT_TEST` (×4).

## How the E2E tests work

Each test opens **two browser contexts on the production build** served with the production
`_headers` (CSP etc.). One context **seeds generated random files** with WebTorrent over WebRTC;
the other uses the app's UI exactly as a user would. Peers find each other through a **local
WebSocket tracker over TLS** (`wss://127.0.0.1`, self-signed), so tests need no internet and run
under the real CSP (`connect-src wss:`). Saved files are captured as browser downloads and
compared by **SHA-256** with the originals.

The public test downloads two small files of *Sintel* (Blender Foundation, CC BY 3.0) with
**web seeds disabled**, so data could only come from WebRTC peers. Observed: 1–4 public WebRTC
peers per browser, connection type `webrtc` only, SHA-256 equal to the reference copies on
webtorrent.io.

## Requirement checklist

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Inspect existing files first | Done | Python app reviewed; feature-by-feature mapping in README "Limitations" |
| 2 | Preserve UI and responsive design | Done | Same layout, Tailwind design, sidebar/cards/drawer/modals; phone-width test passes |
| 3 | Replace Flask/libtorrent with WebTorrent | Done | `src/engine.js`; no server code in `web/` |
| 4 | Vite + modern JavaScript | Done | ES modules, Vite 8 |
| 5 | Magnet links and `.torrent` uploads | **Pass** | E2E "magnet link…", ".torrent upload…" (4 browsers) |
| 6 | Name, file list, progress %, speed, peers, downloaded bytes, status | **Pass** | Preview + card assertions; live progress seen with ≥3 distinct values |
| 7 | Select files; save completed files to device | **Pass** | Selection E2E (unselected file not completed); saves via service worker (4 browsers), "Save as" stream and "Save all to folder" (Chromium/Chrome/Edge, OPFS stand-in for the native dialog), folder destination |
| 8 | Safe errors: invalid torrents, unavailable trackers, no WebRTC peers, network failures | **Pass** | E2E "errors…" (invalid magnet/torrent/extension, unreachable `wss://127.0.0.1:9` logged, "No WebRTC peers" hint, offline banner); unit tests |
| 9 | Explain no TCP/uTP peers | Done | In-app notice + "How it works & limits" page + README |
| 10 | No backend / worker / paid hosting / server storage | Done | Static `dist/` only |
| 11 | Avoid loading whole files into memory | **Pass** | Service-worker streaming and File System Access streaming tested; Blob fallback only without service workers, capped at 512 MB. WebTorrent stores data in OPFS, not RAM |
| 12 | Per-session limits; cleanup of unused resources | **Pass** | Unit (5 limit types); E2E session cap, queue limit, storage freed on remove; leftover storage purged at start; preview expiry; auto-cleanup |
| 13 | Prevent HTML injection, unsafe paths, malicious names, untrusted URLs | **Pass** | E2E "untrusted names…" (no elements created, `__xss` unset, saved name sanitised); unit tests for paths/names/magnets |
| 14 | Security headers + tested CSP | **Pass** | `_headers`; zero CSP violations asserted in 4 browsers; headers confirmed on Cloudflare's emulator |
| 15 | No API keys / credentials / private config | Done | None exist; `check-dist` scans the build |
| 16 | Document browser restrictions, WebRTC compatibility, IP exposure, background limits | Done | README, SECURITY.md, in-app pages |
| 17 | Responsive desktop + mobile | **Pass** | 390 px test: no horizontal scroll, collapsible sidebar |
| 18 | Tests for magnet validation, uploads, progress, completion, errors | **Pass** | 67 unit + 52 E2E |
| 19 | Legal WebRTC-seeded torrent in Chrome, Edge, Firefox | **Pass** | Sintel, 4/4 browsers, WebRTC only |
| 20 | `npm run build` | **Pass** | |
| 21 | `dist` deployable via Direct Upload | **Pass (emulated)** | `check-dist` (file count/size limits, required files); served by `wrangler pages dev` with headers applied. **Actual upload NOT TESTED** (needs your Cloudflare account) |
| 22 | README with Windows commands + deployment | Done | `README.md` |

## Defects found and fixed during this work

1. **Rebuilt magnet links were rejected by WebTorrent** ("Invalid torrent identifier"):
   `URLSearchParams` percent-encoded `xt=urn:btih:…`, which WebTorrent's parser does not decode.
   Fixed with a dedicated builder, plus a regression test that round-trips through `magnet-uri`.
2. **`.torrent` parsing would have failed in the browser**: `parse-torrent` imports Node's `path`.
   Aliased to `path-browserify`.
3. **WebTorrent 3.0.21 upstream bug**: with `rootDir` (writing into a folder),
   `fsa-chunk-store` overwrites `stream()`/`blob()` on WebTorrent's `File` objects, so every
   write fails ("….write is not a function"). Worked around with a store factory that passes
   plain descriptors; browser-storage mode uses WebTorrent's default store.
4. **`<a download>` bypassed the download service worker in Chromium**, so streamed saves were
   cancelled. Saves now navigate a hidden same-origin iframe (CSP `frame-src 'self'`).
5. **Torrent names containing `/` or `\`** cannot be storage folder names and would stall
   silently. Now rejected with a clear message.
6. **Magnet preview copies leaked in browser storage** when the final destination was a folder.
   Store cleanup is now decided per torrent.
7. A failed magnet cleared the pasted link; it is now kept.
8. Dev-dependency advisories (PostCSS, Vitest/tinypool) fixed by upgrading.

## NOT TESTED / limitations

| Item | Why |
|---|---|
| Actual Cloudflare Pages deployment | Needs your Cloudflare login. Verified with `wrangler pages dev` instead |
| Safari, iOS, Android browsers | Not available on this machine |
| Native "Save as" / folder picker dialogs | Can't be automated; the code behind them was tested with OPFS stand-ins |
| Very large torrents (GBs) | Largest automated transfer ~3 MB; browser storage quota on this machine ~10 GB |
| Long-running / background-tab behaviour | Browsers throttle hidden tabs; documented, not measured |
| Interop with WebRTC-capable desktop clients (e.g. WebTorrent Desktop) | Not installed; public test peers were browser/hybrid peers of the Sintel swarm |
| Wrangler 4 | Needs Node 22; Wrangler 3 used (dev-only advisories documented in SECURITY.md) |
