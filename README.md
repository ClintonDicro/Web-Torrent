# Browser Torrent Downloader (WebTorrent, static site)

A browser-only version of the Python Torrent Downloader. It downloads torrents **inside the
browser tab** using [WebTorrent](https://webtorrent.io) and can be hosted for free as a static
site on **Cloudflare Pages**. There is no backend, no cloud worker, no server-side storage,
no API keys and no paid dependency.

> **Important: what a browser can and cannot reach**
> Browsers cannot open raw TCP/UDP sockets. A browser therefore **cannot connect to ordinary
> BitTorrent peers (TCP/uTP)**, UDP/HTTP trackers or the DHT. It only reaches **WebRTC peers**
> (other WebTorrent browser tabs and WebTorrent-enabled desktop clients) found via
> **WebSocket (`wss://`) trackers**, plus optional HTTPS web seeds. Torrents that nobody
> shares over WebRTC will stay at "Finding peers". See [Limitations](#limitations).

## Features

- Add torrents with a **`.torrent` file** (button or drag and drop; parsed locally, never
  uploaded) or a **magnet link** (the file list is fetched from peers first).
- Preview before downloading: name, size, file list, info hash, trackers, warnings about
  trackers a browser can't use. **Nothing downloads until you confirm.**
- Choose individual files; selected size is shown.
- Dashboard with live progress, download/upload speed, ETA, connected peers, downloaded bytes
  and status (Fetching metadata, Queued, Finding peers, Downloading, Paused, Stalled,
  Completed, Seeding, Error).
- Pause / resume / start now / retry / remove, pause all / resume all, queue with a
  configurable number of simultaneous downloads.
- **Saving to your device** without loading whole files into memory where the browser
  allows it (see [Saving files](#saving-files)).
- **Per-session limits** (torrents per session, size per torrent, total per session, speed
  limits) and automatic **cleanup** of browser storage.
- History (this browser only, can be turned off), activity log, settings, dark/light theme,
  desktop notifications, responsive layout for desktop and mobile.

## Requirements (development)

- Windows 10/11 (or any OS) with **Node.js 20.19+ or 22+** (`node --version`).
  Tested with Node 20.20.0. Node 22 LTS is recommended; WebTorrent's `package.json`
  asks for Node 22 only for running it *in Node*, which this project never does
  (npm may print an `EBADENGINE` warning on Node 20; it is harmless here).
- For browser tests: Google Chrome and/or Microsoft Edge (optional) and Playwright browsers.

## Windows development commands

From PowerShell or Command Prompt in this `web` folder:

```bat
npm install
```

```bat
npm run dev
```

Opens a dev server at http://localhost:5173 (hot reload).

```bat
npm run build
```

Builds the production site into `dist\` and then runs `scripts/check-dist.mjs`, which checks
the Cloudflare Pages limits (≤ 20,000 files, ≤ 25 MiB per file), required files, no inline
scripts, CSP directives, no source maps and no secrets.

```bat
npm run serve:dist
```

Serves `dist\` at http://127.0.0.1:4174 **with the production `_headers` applied** (CSP etc.).

```bat
npm run pages:dev
```

Same, but using Cloudflare's own local Pages emulator (Wrangler).

### Tests

```bat
npm test
```

Unit tests (Vitest): magnet validation, `.torrent` upload parsing, file-name sanitising,
status/progress model, limits, settings, history.

```bat
npx playwright install chromium firefox
```

```bat
npm run build && npm run test:e2e
```

End-to-end tests (Playwright) in **Chromium, Google Chrome, Microsoft Edge and Firefox**.
Each test starts a second browser context that **seeds generated files over WebRTC**, a
**local WSS tracker** (self-signed, 127.0.0.1) and downloads through the real UI of the
production build served with the production CSP. Files are compared by SHA-256.
Chrome/Edge projects need those browsers installed (remove them from
`playwright.config.js` otherwise).

Optional public-network test (Sintel, CC-BY, WebRTC peers only, web seeds off):

```bat
set PUBLIC_TORRENT_TEST=1&& npx playwright test tests/e2e/public.spec.js --project=chromium
```

## Deploying to Cloudflare Pages (free plan, Direct Upload)

The `dist` folder is a plain static site. Nothing needs to run on Cloudflare.

**Option A: dashboard (drag and drop)**

1. `npm run build`
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
3. Name the project, then drag the **`dist` folder** (not the `web` folder) into the upload box.
4. **Deploy site**. You get `https://<project>.pages.dev`.
   To update, open the project → **Create new deployment** → upload `dist` again.

**Option B: Wrangler CLI** (Wrangler 3 is a dev dependency; needs a free Cloudflare account)

```bat
npx wrangler login
```

```bat
npm run build && npx wrangler pages project create browser-torrent-downloader --production-branch main
```

```bat
npm run deploy
```

`npm run deploy` runs `wrangler pages deploy dist --project-name browser-torrent-downloader`.
No API keys are stored in this project; Wrangler keeps its login in your user profile.

`dist/_headers` is picked up automatically by Pages and sets the security headers (below).
Check them after deploying:

```bat
curl -sI https://<project>.pages.dev/ | findstr /i "content-security-policy x-frame-options permissions-policy"
```

## Saving files

| Browser | "Browser storage" downloads are saved via | Memory use |
|---|---|---|
| Chrome / Edge (desktop) | "Save as" dialog (`showSaveFilePicker`) streaming to disk, or **Save all to folder…** keeping folder structure | streamed |
| Firefox (tested); Safari and mobile browsers (expected, not tested) | the app's download **service worker** (`/download-sw.js`) streaming into the browser's download manager | streamed |
| Private windows where service workers are disabled | in-memory Blob | whole file in RAM; refused above 512 MB |

In **Chrome/Edge on desktop** you can also pick **"Folder on this device"** before downloading:
WebTorrent then writes straight into that folder, in a sub-folder named
`<torrent name> - <first 8 hex digits of the info hash>`. This app never deletes anything in
that folder.

Data in browser storage lives in the site's **Origin Private File System** (private to this
site, in this browser profile). It is deleted when you remove a download, after it has been
saved and idle for the auto-cleanup time, and at the next app start.

## Limitations

| Feature of the Python/libtorrent version | Browser version |
|---|---|
| TCP/uTP peers, UDP/HTTP trackers, DHT, PEX with desktop clients, LSD, UPnP/NAT-PMP | **Not possible in a browser.** WebRTC peers + WSS trackers + HTTPS web seeds only |
| Downloads continue in the background / after closing | **No.** The tab must stay open; mobile browsers may suspend background tabs |
| Resume after restart (fast-resume) | **No.** Closing/reloading discards unfinished data (cleaned at next start) |
| Saving into `Downloads\TorrentDownloads` automatically | Browsers don't allow choosing paths. Files go to your browser's download folder (or a folder you pick in Chrome/Edge) |
| Open folder in Explorer | Not possible from a web page |
| SQLite history | `localStorage` in this browser (optional) |
| System logs | In-page activity log for the current session |
| BitTorrent v2-only torrents | Not supported by WebTorrent |
| Private torrents | Only reachable if their own tracker is a WSS tracker (rare) |
| Running in several tabs | One tab at a time (they would share browser storage) |

### Privacy: IP address exposure

As with any BitTorrent client, **peers and trackers see your IP address**. WebRTC also exposes
it to every peer you connect to. A VPN that covers WebRTC traffic hides it; disabling WebRTC
(some privacy extensions do) stops the app from working.

## Security

See [`SECURITY.md`](SECURITY.md) for the full assessment. In short:

- Static site, **no backend**: no server-side storage, no accounts, no secrets.
- Strict **Content-Security-Policy** (`script-src 'self'`, no inline script/style, no eval,
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`), plus nosniff,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`,
  COOP/CORP and HSTS. Tested in all four browsers with zero CSP violations.
- All untrusted text (names, paths, trackers, errors) is rendered with `textContent`.
- Magnet links are parsed strictly and **rebuilt** with only `xt`, `dn`, `wss://` trackers and
  `https://` web seeds. `xs`/`as` (URLs the browser would fetch) are dropped.
- `.torrent` files: 10 MB limit, validated, path traversal / absolute paths / unsafe names
  rejected, max 10,000 files.
- Saved file names are sanitised (reserved characters, Windows device names, bidi tricks,
  hidden/relative names, length).
- Downloads served by the service worker are always `attachment` with
  `Content-Security-Policy: sandbox` and `nosniff`, so content from a torrent can never run as
  this site.

## Project layout

```text
web/
├── index.html                 UI markup (no inline scripts or styles)
├── public/
│   ├── _headers               Cloudflare Pages security headers (CSP, …)
│   ├── download-sw.js         Streaming download service worker
│   └── icon.svg
├── src/
│   ├── main.js                UI controller
│   ├── engine.js              WebTorrent wrapper: queue, limits, status, cleanup
│   ├── save.js                Saving strategies (picker / service worker / blob)
│   ├── styles/app.css         Tailwind styles (shared design with the Python version)
│   └── lib/                   Pure, unit-tested modules
│       ├── validate.js        Magnet/tracker/file-name validation
│       ├── torrent-file.js    .torrent parsing
│       ├── status.js          Status model
│       ├── limits.js          Per-session limits
│       ├── settings.js        Settings + persistence
│       ├── history.js         Local history
│       └── format.js
├── scripts/                   check-dist.mjs, serve-dist.mjs
└── tests/                     unit/ (Vitest), e2e/ (Playwright), support/ (WSS tracker, static server)
```

## Troubleshooting

| Problem | What to do |
|---|---|
| Stuck at "Fetching file list" / "Finding peers" | No WebRTC peer shares this torrent. Torrents shared only by normal desktop clients can't be reached from a browser. Try WebTorrent Desktop for those. |
| "WebRTC is not available" banner | A browser setting, extension (privacy/ad blockers), VPN or company policy disables WebRTC. Allow WebRTC for this site. |
| "Browser storage is full" | Remove finished downloads, free disk space, or use "Folder on this device" (Chrome/Edge). |
| "Already open in another tab" | Close the other tab running the app, then reload. |
| Save button does nothing in a private window | Service workers are off there; files ≤ 512 MB are saved through memory, larger ones need a normal window or Chrome/Edge. |
| Tracker warnings in the Activity Log | The tracker is down or blocked. Add more `wss://` trackers in Settings. |
| `npm install` prints EBADENGINE warnings | Harmless on Node 20 (see Requirements). |
