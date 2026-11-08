# Security and compatibility assessment

Scope: the static browser app in this folder (`web/`), deployed to Cloudflare Pages.

## Architecture and trust boundaries

| Component | Runs where | Trust |
|---|---|---|
| HTML/JS/CSS bundle | User's browser, origin `https://<project>.pages.dev` | Ours |
| WebTorrent client | Same tab | Library (pinned 3.0.21) |
| `.torrent` files, magnet links | Provided by the user, authored by anyone | **Untrusted** |
| Torrent metadata from peers (names, paths) | Received over WebRTC | **Untrusted** |
| Peers, WSS trackers, web seeds | Internet | **Untrusted** |
| Downloaded content | Browser storage (OPFS) or a user-chosen folder | **Untrusted**, never executed or rendered |

There is **no server-side component**: Cloudflare Pages only serves static files. No user data,
torrents or downloaded content are sent to the site's host. No API keys, credentials or private
configuration exist in the project (`scripts/check-dist.mjs` scans the build for key-like strings).

## Threats and mitigations

| Threat | Mitigation | Verified by |
|---|---|---|
| HTML/script injection via torrent names, file paths, tracker URLs, error messages | Every untrusted string is inserted with `textContent`/attributes, never `innerHTML`; control and bidi-override characters stripped for display | E2E "untrusted names are shown as text" (4 browsers); unit tests |
| Injection if a bug ever reached the DOM | CSP `script-src 'self'` (no inline, no eval), `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` | E2E asserts zero `securitypolicyviolation` events; `check-dist` rejects inline scripts/handlers/styles |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | Header test |
| Malicious content served as this origin | Downloaded files are never rendered. The download service worker always answers with `Content-Disposition: attachment`, `application/octet-stream`, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, single-use random tokens, 60 s expiry. WebTorrent's own service-worker file server (which serves torrent files from the site's origin without these headers) is **not used** | Code review; E2E save tests |
| Path traversal / unsafe paths in torrents | `.torrent` and peer metadata: absolute paths, drive letters, `.`/`..`/empty components and names with `/` `\` NUL rejected. File System Access API additionally refuses to escape the chosen folder | Unit tests |
| Malicious file names when saving | Sanitised: reserved characters `<>:"/\|?*`, control/bidi characters, Windows device names (CON, NUL, COM1…), leading dots, trailing dots/spaces, 180-char limit keeping the extension | Unit tests; E2E checks the saved name |
| Untrusted URLs in magnet links | Strict parser; link is **rebuilt** from `xt` (v1 hash), `dn`, `wss://` trackers (no credentials) and `https://` web seeds. `xs`, `as`, `kt` and unknown params dropped, so the app never fetches arbitrary URLs | Unit tests (incl. round-trip through WebTorrent's parser) |
| Oversized / malformed `.torrent` uploads | 10 MB limit, bencode + info-dictionary checks, max 10,000 files, friendly errors | Unit + E2E tests |
| Deleting user files | "Folder on this device" downloads are never wiped: removal never asks WebTorrent to destroy that store; only the app's private OPFS cache is cleared | E2E "folder destination…" checks the file survives removal |
| Overwriting user files | Folder mode writes into a new sub-folder `<name> - <hash8>`; "Save all to folder" adds ` (1)` instead of overwriting | Code; E2E |
| Resource exhaustion | Per-session caps (torrents, GB per torrent, GB per session), browser storage quota check, max active downloads, speed limits, preview expiry (15 min), auto-cleanup of saved+idle torrents, cleanup of leftover storage at start, single-tab lock | Unit tests (limits); E2E (session limit, queue, storage freed on remove, single tab) |
| Tampered `localStorage` settings | Every stored value re-validated on load; invalid values fall back to defaults | Unit test |
| Third-party tracking / data leaks | No analytics, no third-party scripts/fonts/CDNs, `Referrer-Policy: no-referrer`, `Permissions-Policy` denies camera, microphone, geolocation, payment, USB, serial, Bluetooth, HID, MIDI, Topics | Header test |

### Content-Security-Policy (production, `public/_headers`)

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src 'self' wss: https:; worker-src 'self'; manifest-src 'self'; media-src 'none';
object-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Why the non-`'self'` sources are needed:

- `connect-src wss:`: WebTorrent trackers are WebSocket servers chosen by the torrent or the user.
- `connect-src https:`: BitTorrent web seeds (BEP 19). Turning web seeds off in Settings stops
  the app from using it, but the CSP still allows it.
- `frame-src 'self'`: streamed saves use a hidden same-origin iframe that the service worker
  answers with an attachment (an `<a download>` click bypasses service workers in Chromium).
- WebRTC data channels are not controlled by CSP.

Tested: the E2E suite runs against the production build served **with this exact header**
(`tests/support/static-server.mjs` applies `_headers`), in Chromium, Chrome, Edge and Firefox,
and fails on any CSP violation in the main flows.

## Dependency audit (`npm audit`, 2026-11-08)

| Finding | Where | Assessment |
|---|---|---|
| `ip` – SSRF misclassification in `isPublic` (GHSA-2p57-rm9w-gvfp), high | `webtorrent → torrent-discovery → bittorrent-tracker → ip` | **Not shipped**: the browser bundle contains no `isPublic` code (checked in `dist/assets`). It is used by the Node tracker/server code paths only. No fixed WebTorrent release exists |
| `wrangler 3` chain (undici, miniflare, sharp, ws, zod, esbuild, @fastify/busboy), moderate–high | dev dependency for local Pages emulation / deploy | Developer machine only, never deployed. Fixed in Wrangler 4, which needs Node 22: on Node 22 run `npm i -D wrangler@4` |
| PostCSS, Vitest/tinypool (high/critical) | dev dependencies | **Fixed** by upgrading to `postcss@8.5.30` and `vitest@4.1.12` |

## Residual risks (accepted)

1. **IP address exposure.** Peers and trackers see the user's IP, as with any BitTorrent client.
   WebRTC reveals it to each connected peer. Documented in the app and README.
2. **Untrusted content on disk.** Downloaded files can be malicious. The app never opens or
   executes them; users must treat them like any download.
3. **Legal use.** The app cannot know whether content may be downloaded; the UI reminds users.
4. **Library trust.** WebTorrent and its dependencies run with the page's privileges. Versions
   are pinned in `package.json` / `package-lock.json`. Run `npm audit` before deploying.
5. **`connect-src` breadth.** `wss:`/`https:` allow connections to any host; required by the
   BitTorrent protocol. No user data other than BitTorrent traffic is sent.
6. **Upstream bug worked around.** WebTorrent 3.0.21's `rootDir` mode breaks because
   `fsa-chunk-store` overwrites methods on WebTorrent's `File` objects. The app passes plain
   descriptors through its own store factory (`engine.js → _folderStore`). Re-check after upgrades.

## Browser compatibility

| Capability | Chrome / Edge (desktop) | Firefox (desktop) | Safari | Mobile |
|---|---|---|---|---|
| WebRTC peers, WSS trackers | Yes (tested) | Yes (tested) | Expected (not tested) | Expected (not tested) |
| Browser storage (OPFS) | Yes (tested) | Yes (tested) | Expected (not tested) | Expected (not tested) |
| "Folder on this device" (`showDirectoryPicker`) | Yes (tested with a stand-in folder) | No (option disabled) | No | No |
| Save via "Save as" stream (`showSaveFilePicker`) | Yes (not automatable; the native dialog cannot be driven by tests) | No | No | No |
| Save via service-worker stream | Yes (tested) | Yes (tested) | Expected (not tested) | Expected (not tested) |
| Downloads in background tabs | Usually yes on desktop, may be throttled | Same | Same | Often suspended |
