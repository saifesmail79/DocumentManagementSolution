# Scan Bridge — integration guide for the DMS frontend

**Audience:** the agent or developer building the web-based Document Management System
(React frontend).
**You are integrating with:** Scan Bridge, a small Windows tray helper already built and
running on user desktops.
**Protocol version:** 1

---

## 1. What this is, in one paragraph

Browsers cannot reach scanners. There is no Web Scanner API, and WebUSB cannot claim a
device a Windows driver already owns. So each user's PC runs a small helper — Scan
Bridge — that drives the scanner through WIA (the Windows acquisition API every scanner
driver implements) and exposes a tiny HTTP API on `127.0.0.1`. Your React app calls that
API with `fetch`, gets scanned pages back as base64 in memory, previews them, and uploads
them to your own backend. **Nothing is ever written to the user's disk.** Removing the
"save to Desktop, then upload" step is the entire point of the component.

```
┌────────────────────────┐  fetch   ┌──────────────────────────┐
│ DMS React app          │─────────>│ Scan Bridge (tray app)   │
│ http://10.x.x.x:3000   │<─────────│ Kestrel @ 127.0.0.1:PORT │
│                        │   JSON   │        │                 │
│ - discover port        │          │        ▼ COM (STA)       │
│ - preview pages        │          │   WIA → vendor driver    │
│ - build PDF            │          └────────┬─────────────────┘
└──────────┬─────────────┘                   ▼
           │ multipart                   ┌─────────┐
           ▼                             │ Scanner │
┌────────────────────────┐               └─────────┘
│ DMS backend            │
│ POST /api/documents    │
└────────────────────────┘
```

The bridge is a **dumb device proxy**. It holds no credentials, touches no database, and
makes no outbound network calls. All authorisation stays in your backend, where it
already belongs.

---

## 2. Read this before writing any code

Three things cause almost all first-day integration failures.

### 2.1 Your app's origin must be on the bridge's allowlist

The bridge refuses any request from an origin it does not trust, with **HTTP 403**. This
stops a malicious website the user happens to visit from silently driving their scanner.

Accepted out of the box:

| Pattern | Example |
|---|---|
| `http://localhost:5173` | exact |
| `http://127.0.0.1:5173` | exact |
| `^http://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$` | `http://192.168.1.40:3000` |
| `^http://10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$` | `http://10.18.6.15:3000` |

**Note what is *not* covered:** `https://` anything, hostnames (`http://dms-server`),
and `172.16–31.x.x`. If the DMS is served over HTTPS or from a named host — which it
will be in production — the allowlist **must** be extended, or every call returns 403.

To extend it, per machine, with no rebuild: create
`C:\ProgramData\ScanBridge\appsettings.json` and restart the bridge.

```json
{
  "allowedOrigins": [
    "https://dms.yourcompany.com",
    "http://localhost:5173"
  ],
  "allowedOriginPatterns": [
    "^https://dms\\.yourcompany\\.com(:\\d+)?$",
    "^http://192\\.168\\.\\d{1,3}\\.\\d{1,3}(:\\d+)?$"
  ]
}
```

Tell whoever deploys the bridge what your production origin will be. Get this settled
early; it is the single most common cause of "it doesn't work".

### 2.2 Use plain `fetch`, never your API client

If your DMS uses an axios instance (or similar) with an interceptor that attaches the
user's JWT, **do not use it for the bridge**. It would send your access token to a local
process that has no business seeing it. The bridge never needs authentication.

Also do not set `credentials: 'include'`. There are no cookies to send.

### 2.3 The bridge might not be installed

Some users will not have it. The scanning UI **must** degrade to an ordinary
`<input type="file">` upload rather than break. See §9 — this is what makes a gradual
rollout safe.

---

## 3. Discovery

The bridge does not use a fixed port. On startup it binds the first free port in
**45678–45687** and records it in `%LOCALAPPDATA%\ScanBridge\port.txt`.

Your app finds it by probing that range with `GET /ping` and checking two fields:

- `product === "scan-bridge"` — confirms you found *this* helper and not some other
  service squatting the port.
- `protocol === 1` — refuse anything else and show an "update the Scan Bridge" message.
  The number is bumped only on a breaking API change.

Cache the winning port in `localStorage`, and re-probe whenever a call fails.

Probing ten ports costs ~10 requests on a cold start. Keep the per-probe timeout short
(400 ms is plenty for loopback) so a machine without the bridge fails fast.

---

## 4. API reference

Base URL: `http://127.0.0.1:{port}`. Everything is
`application/json; charset=utf-8`.

### `GET /ping`

Discovery and version handshake. Cheap, and deliberately never touches the scanner —
safe to call often.

```json
{
  "product": "scan-bridge",
  "version": "1.0.0",
  "protocol": 1,
  "machine": "DESKTOP-1I9KIAN",
  "os": "Microsoft Windows 10.0.26200"
}
```

### `GET /scanners`

```json
{
  "scanners": [
    {
      "id": "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000",
      "name": "CANON DR-M160 USB",
      "isDefault": true,
      "capabilities": {
        "flatbed": false,
        "feeder": true,
        "duplex": true,
        "feederLoaded": false,
        "dpiOptions": [150, 200, 240, 300, 400, 600],
        "colorModes": ["bw", "gray", "color"]
      }
    }
  ]
}
```

- `id` is opaque. **Never parse it.** Store it verbatim if you remember the user's choice.
- `"scanners": []` is a **success**, not an error. Render "no scanner found" yourself.
- `isDefault` is simply the first device found; WIA has no real notion of a default.
- **`feederLoaded` is `bool | null`.** `null` means the driver does not report it —
  render that as "unknown", never as "no paper". Only `false` means genuinely empty.
- `dpiOptions` comes from the driver where possible, otherwise `[150, 200, 300, 600]`.
- Build your DPI dropdown from `dpiOptions`, and disable the duplex toggle when
  `capabilities.duplex` is false.

This call connects to each device to read its capabilities, so it is **not** instant —
budget a second or two, and show a spinner. It also shares the device lock with
scanning, so calling it during a scan returns `scanner_busy` rather than hanging.

### `POST /scan`

Request — every field optional:

| Field | Type | Default | Notes |
|---|---|---|---|
| `scannerId` | string | first device | omit to use the default |
| `source` | `auto` \| `flatbed` \| `feeder` | `auto` | `auto` = feeder if paper detected, else flatbed |
| `dpi` | int | `300` | snapped to the nearest value the driver supports |
| `colorMode` | `bw` \| `gray` \| `color` | `gray` | |
| `duplex` | bool | `false` | ignored with a warning if unsupported |
| `maxPages` | int | `50` | also capped server-side at 200 |
| `format` | `jpeg` \| `png` | see note | PNG when `colorMode` is `bw`, else JPEG q82 |

Response:

```json
{
  "jobId": "f803b23569944a5d9fda223bb8c2bfd8",
  "source": "feeder",
  "pageCount": 2,
  "warnings": ["duplex_unsupported_ignored"],
  "pages": [
    {
      "index": 0,
      "mimeType": "image/jpeg",
      "width": 2592,
      "height": 4200,
      "dpi": 300,
      "sizeBytes": 384102,
      "data": "<base64>"
    }
  ]
}
```

Behaviour you need to design around:

- **A feeder scans until empty.** One request can return many pages.
- **The request stays open for the whole scan** — potentially minutes. Do not set a short
  client timeout. Show a spinner and a cancel button.
- **One scan at a time.** A second concurrent call returns **409 `scanner_busy`**
  immediately rather than queueing.
- The job times out after 5 minutes by default.

### `POST /cancel`

Body `{ "jobId": "..." }`, or `{}` to cancel whatever is running.

```json
{ "cancelled": true }
```

`cancelled: false` just means nothing was running.

**Cancellation takes effect at the next page boundary.** WIA has no clean way to abort a
transfer that is already moving paper, so a flatbed scan cannot be cancelled at all, and
a feeder run stops after the sheet currently going through. **Say so in your UI** — label
the button something like *"Stop after current page"*, not *"Cancel"*.

Aborting the `fetch` does **not** stop the scanner. You must call `/cancel`.

### `GET /logs/recent`

`{ "lines": [...] }` — the last 200 log lines, for a support/diagnostics screen. Text
only; image data never reaches the log.

---

## 5. Errors

Every failure uses one shape:

```json
{
  "error": "paper_jam",
  "message": "انحشار ورق في وحدة التغذية.",
  "detail": "WIA HRESULT 0x80210002 from Transfer() on page 3 (document handling status 0x20)"
}
```

- `error` — a **stable code**. Switch on this. It will never be renamed or reused.
- `message` — user-facing, **currently Arabic**. See the note below.
- `detail` — English diagnostics. Log it to the console; **never show it to end users.**

HTTP status: **400** bad input, **409** busy, **500** device and driver failures.

> ### About the language of `message`
>
> The bridge ships Arabic user text, inherited from the project it was first specified
> for. If your DMS is not Arabic, or needs several languages, **ignore `message` and map
> the `error` code to your own i18n strings** — the codes exist precisely so the UI owns
> the wording. If you would rather the bridge itself returned English or a locale-aware
> string, that is a small change to one file (`ScanErrorMessages.cs`); ask for it.

### Codes and what to do about each

| Code | HTTP | Meaning | Suggested UI |
|---|---|---|---|
| `no_scanner` | 500 | no scanner attached | "No scanner found. Check it is on and plugged in." |
| `scanner_not_found` | 500 | the `scannerId` you sent is gone | refresh the scanner list, retry |
| `scanner_busy` | 409 | another scan is running | "Please wait…" — disable the button, retry shortly |
| `scanner_offline` | 500 | powered off or disconnected | ask the user to check the device |
| `paper_empty` | 500 | feeder was empty at the start | "Put paper in the feeder." |
| `paper_jam` | 500 | jam | "Clear the jam, then try again." |
| `paper_problem` | 500 | misfeed / multi-feed | "Check the paper and try again." |
| `cover_open` | 500 | lid or path open | "Close the scanner cover." |
| `warming_up` | 500 | not ready yet | auto-retry once after a few seconds |
| `user_intervention` | 500 | needs a human at the device | "Check the scanner." |
| `device_locked` | 500 | another program holds it | "Close other scanning software." |
| `driver_error` | 500 | driver failed | generic failure + "try again" |
| `unsupported_setting` | 500 | driver rejected the settings | fall back to defaults and retry |
| `bad_request` | 400 | your payload is wrong | a bug in your code — log `detail` |
| `cancelled` | 500 | cancelled before any page | no error toast; it was deliberate |
| `timeout` | 500 | job exceeded the limit | "Scan took too long." |
| `internal_error` | 500 | unexpected | generic failure; log `detail` |

**A 403 is not in this list.** If you get 403 with `detail` mentioning "Origin rejected",
your origin is not allowlisted — see §2.1. This is a configuration problem, not a
runtime error, and no retry will fix it.

### Warnings

`warnings` is a non-fatal string array on a **successful** response. Surface them quietly
(a small note), never as an error:

| Warning | Meaning |
|---|---|
| `duplex_unsupported_ignored` | duplex requested, device cannot do it — scanned single-sided |
| `max_pages_reached` | hit `maxPages`; **there may be more paper left in the feeder** |
| `cancelled_partial` | you cancelled; the pages returned are the ones already scanned |
| `dpi_adjusted` | driver snapped your DPI to a value it supports |
| `dpi_not_configurable` | driver would not expose resolution |
| `color_mode_not_configurable` | driver would not expose colour mode |
| `vertical_dpi_not_applied` | horizontal DPI applied, vertical did not |
| `extent_not_configurable` | scan area could not be set explicitly |
| `feeder_unavailable_using_flatbed` | asked for feeder, device has none |
| `flatbed_unavailable_using_feeder` | asked for flatbed, device has none |

`max_pages_reached` is worth a visible prompt — "More pages may remain, scan again?"

---

## 6. Drop-in client module

`src/utils/scanBridge.js` — no dependencies, plain `fetch`.

```js
/**
 * Client for the local Scan Bridge helper.
 *
 * Deliberately uses plain fetch rather than the app's API client: that client attaches
 * the user's access token, and a local helper has no business seeing it.
 */

const PRODUCT = 'scan-bridge';
const PROTOCOL = 1;
const PORTS = [45678, 45679, 45680, 45681, 45682, 45683, 45684, 45685, 45686, 45687];
const STORAGE_KEY = 'dms.scanBridge.port';
const PROBE_TIMEOUT_MS = 400;

let baseUrl = null;

export class ScanBridgeError extends Error {
  constructor(code, detail, userMessage) {
    super(detail || code);
    this.name = 'ScanBridgeError';
    this.code = code;
    this.detail = detail;
    this.userMessage = userMessage; // the bridge's own text; usually ignore it
  }
}

/** Not installed / not running. Distinct from a scan failure. */
export class ScanBridgeUnavailableError extends Error {
  constructor() {
    super('Scan Bridge is not available on this machine.');
    this.name = 'ScanBridgeUnavailableError';
  }
}

function readCachedPort() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const port = Number(raw);
    return PORTS.includes(port) ? port : null;
  } catch {
    return null; // private mode, storage disabled
  }
}

function writeCachedPort(port) {
  try {
    if (port === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(port));
  } catch {
    /* non-fatal */
  }
}

async function probe(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ping`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const info = await response.json();
    if (info.product !== PRODUCT) return null;      // something else on this port
    if (info.protocol !== PROTOCOL) {
      // Deliberately distinct: found, but we cannot speak to it.
      return { port, info, incompatible: true };
    }
    return { port, info, incompatible: false };
  } catch {
    return null;                                     // closed port, timeout, blocked
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Locates the bridge. Returns { baseUrl, info } or null when it is not installed.
 * Throws only if a bridge is found but speaks an incompatible protocol.
 */
export async function discover({ force = false } = {}) {
  if (baseUrl && !force) return { baseUrl, info: null };

  const cached = readCachedPort();
  const order = cached ? [cached, ...PORTS.filter((p) => p !== cached)] : PORTS;

  for (const port of order) {
    const found = await probe(port);
    if (!found) continue;

    if (found.incompatible) {
      writeCachedPort(null);
      throw new ScanBridgeError(
        'protocol_mismatch',
        `Bridge speaks protocol ${found.info.protocol}, this app expects ${PROTOCOL}.`,
      );
    }

    baseUrl = `http://127.0.0.1:${port}`;
    writeCachedPort(port);
    return { baseUrl, info: found.info };
  }

  baseUrl = null;
  writeCachedPort(null);
  return null;
}

async function call(path, { method = 'GET', body, signal } = {}) {
  if (!baseUrl) {
    const found = await discover();
    if (!found) throw new ScanBridgeUnavailableError();
  }

  let response;
  try {
    response = await fetch(baseUrl + path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    baseUrl = null;                 // it went away; re-probe next time
    writeCachedPort(null);
    throw new ScanBridgeUnavailableError();
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }

  if (!response.ok) {
    throw new ScanBridgeError(
      payload?.error ?? `http_${response.status}`,
      payload?.detail ?? text,
      payload?.message,
    );
  }
  return payload;
}

export async function listScanners() {
  const data = await call('/scanners');
  return data.scanners;
}

/**
 * Runs a scan. Resolves with { jobId, source, pageCount, warnings, pages }.
 * Pages carry base64 in `data`; use pageToBytes() to decode.
 *
 * Note: aborting `signal` abandons the HTTP response but does NOT stop the scanner.
 * Call cancel() for that.
 */
export function scan(options = {}, { signal } = {}) {
  return call('/scan', { method: 'POST', body: options, signal });
}

export async function cancel(jobId) {
  const data = await call('/cancel', { method: 'POST', body: jobId ? { jobId } : {} });
  return data.cancelled;
}

export async function recentLogs() {
  const data = await call('/logs/recent');
  return data.lines;
}

/** Decodes one page's base64 payload into bytes. */
export function pageToBytes(page) {
  const binary = atob(page.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Object URL for previewing a page. Revoke it when the preview unmounts. */
export function pageToObjectUrl(page) {
  return URL.createObjectURL(new Blob([pageToBytes(page)], { type: page.mimeType }));
}
```

---

## 7. React usage

A hook that owns availability, scanner list and scan state:

```jsx
import { useCallback, useEffect, useRef, useState } from 'react';
import * as bridge from '../utils/scanBridge';

export function useScanBridge() {
  const [status, setStatus] = useState('checking'); // checking | ready | unavailable
  const [scanners, setScanners] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [pages, setPages] = useState([]);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const refresh = useCallback(async () => {
    setError(null);
    const found = await bridge.discover({ force: true }).catch((e) => {
      setError(e);
      return null;
    });
    if (!found) {
      setStatus('unavailable');
      setScanners([]);
      return;
    }
    try {
      setScanners(await bridge.listScanners());
      setStatus('ready');
    } catch (e) {
      setError(e);
      setStatus(e instanceof bridge.ScanBridgeUnavailableError ? 'unavailable' : 'ready');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const startScan = useCallback(async (options) => {
    setScanning(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const result = await bridge.scan(options, { signal: abortRef.current.signal });
      setPages((prev) => [...prev, ...result.pages]);   // append: users scan in batches
      return result;
    } catch (e) {
      if (e.name !== 'AbortError') setError(e);
      return null;
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }, []);

  // Stops the scanner, not just the request. Takes effect at the next page boundary.
  const stopScan = useCallback(async () => {
    try { await bridge.cancel(); } catch { /* best effort */ }
  }, []);

  return { status, scanners, scanning, pages, setPages, error, refresh, startScan, stopScan };
}
```

Component notes:

- Build the DPI dropdown from the selected scanner's `capabilities.dpiOptions`.
- Disable the duplex toggle when `capabilities.duplex` is false.
- Remember the last scanner choice per user in `localStorage`, keyed by `id`.
- Show a thumbnail strip with rotate / delete / reorder. Do rotation client-side on a
  `<canvas>` before building the PDF — the bridge does not rotate.
- Revoke object URLs on unmount, or you will leak memory across repeated scans.
- Show page count and estimated size before saving.

---

## 8. Turning pages into a PDF and uploading

Assemble client-side and post to your existing upload endpoint. No new backend route is
needed — the pages become one ordinary PDF file.

With `pdf-lib` (MIT, pure JS):

```js
import { PDFDocument } from 'pdf-lib';
import { pageToBytes } from '../utils/scanBridge';

export async function pagesToPdfFile(pages) {
  const pdf = await PDFDocument.create();

  for (const page of pages) {
    const bytes = pageToBytes(page);
    const image = page.mimeType === 'image/png'
      ? await pdf.embedPng(bytes)
      : await pdf.embedJpg(bytes);

    // Points, so the PDF page is the paper's real physical size.
    const dpi = page.dpi > 0 ? page.dpi : 300;
    const width = (image.width * 72) / dpi;
    const height = (image.height * 72) / dpi;

    const pdfPage = pdf.addPage([width, height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width, height });
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  return new File([await pdf.save()], `scan-${stamp}.pdf`, { type: 'application/pdf' });
}
```

Then post it exactly as you would a user-selected file:

```js
const form = new FormData();
form.append('file', await pagesToPdfFile(pages));
// ...plus whatever metadata fields your endpoint expects
await api.post('/api/documents', form);   // your normal client, with auth — this one is yours
```

Because the result is a plain `File`, **permissions, audit logging and validation on your
upload route all apply unchanged.** Do not build a separate scan-upload path.

> If you would rather not add a dependency, the bridge's own test page contains a ~120-line
> dependency-free PDF writer that embeds JPEG directly via `DCTDecode`. See
> `src/ScanBridge/Web/index.html` in this repository and copy `buildPdf`.

---

## 9. Graceful degradation — required

If `discover()` returns `null`, the scanning UI must not break. Show a dismissible note
and fall back to the ordinary file upload that already exists:

```jsx
{status === 'unavailable' && (
  <Notice onDismiss={...}>
    Scanning from this browser needs the Scan Bridge helper, which is not installed on
    this PC. <a href="/downloads/ScanBridge.zip">Install it</a>, or upload a file instead.
  </Notice>
)}
{status === 'unavailable' ? <FileUpload /> : <ScanPanel .../>}
```

Users without the helper keep working exactly as they do today. This is what makes the
rollout safe to do gradually, one machine at a time.

---

## 10. Things that will bite you

1. **Payload size.** A 50-page colour scan at 300 dpi returns **one JSON response of
   roughly 100–200 MB** (base64 adds ~33%). The tab will stall while it parses. For
   colour work, default `maxPages` to something like 20–25 and let users scan in batches
   (the hook above appends). If this becomes a real problem, the bridge can grow a
   per-page fetch endpoint — ask; it is an additive change, not a breaking one.
2. **Don't send your JWT.** §2.2. Plain `fetch`, no interceptors, no `credentials`.
3. **`feederLoaded: null` ≠ `false`.** Null means the driver stayed silent.
4. **Empty scanner list is a 200, not an error.**
5. **Cancel is not instant.** Label the button honestly.
6. **Aborting the fetch does not stop the scanner.** Call `/cancel`.
7. **Re-probe on failure.** The user may restart the bridge onto a different port. The
   module above clears its cache whenever a call fails at the network level.
8. **HTTP page → loopback is fine.** An `http://` page calling `http://127.0.0.1` has no
   mixed-content problem. An `https://` page calling `http://127.0.0.1` is also allowed —
   browsers treat loopback as a trustworthy origin. Safari does not, but this is a
   Windows/Edge/Chrome context by definition, since the helper is Windows-only.
9. **Chrome's local-network permission.** Chrome has been moving from Private Network
   Access to a Local Network Access permission prompt. The bridge already returns both
   `Access-Control-Allow-Private-Network` and `Access-Control-Allow-Local-Network-Access`
   on preflight. If scanning silently fails on a newer Chrome with a CORS error that makes
   no sense, this is the first thing to suspect — it may need a browser policy.
   **This has not been tested on a newer Chrome yet.**

---

## 11. What is verified, and what is not

Be aware of where the ice is thin. Verified on real hardware (Canon DR-M160, sheet-fed
duplex):

- Discovery, `/ping`, `/scanners` with real capability reading
- A real single-page feeder scan end to end (2592×4200 @ 300 dpi grayscale JPEG)
- `paper_empty` when the tray is empty
- The origin gate: allowed origin passes, `https://malware.example` and a different
  loopback port both get 403
- The Chrome private-network preflight (204 with the required headers)
- 400 on bad input, `/cancel` when idle

**Not yet verified on hardware** — write defensively around these:

- A multi-page ADF run (20+ sheets, ordering, `max_pages_reached`)
- The feeder emptying mid-run (partial success)
- Duplex
- **Any flatbed device at all** — the test scanner has no glass
- A second and third scanner brand
- Unplugging mid-scan
- Newer Chrome's local-network permission

---

## 12. Security model, so you can answer questions about it

What the bridge does:

- Binds **loopback only** (`127.0.0.1`). Never `0.0.0.0`. Nothing on the LAN can reach it.
- Enforces the origin allowlist **before routing**, returning 403. CORS headers alone are
  advisory — they constrain a browser after the fact, they do not stop a request arriving.
- Recognises its own diagnostic page as same-origin via `Sec-Fetch-Site`, which is a
  forbidden header name and therefore cannot be forged by a page.

What it deliberately does **not** do:

- No filesystem writes of scanned images — pages live in memory and go out over HTTP.
- No outbound network calls of any kind.
- No auth tokens, no credentials, no database access.

So the security boundary that matters for the DMS is **your backend**, unchanged. The
bridge only decides *whether a page may operate the scanner*, never *what may be stored*.

---

## 13. Quick reference

```
GET  /ping           -> { product, version, protocol, machine, os }
GET  /scanners       -> { scanners: [ { id, name, isDefault, capabilities } ] }
POST /scan           -> { jobId, source, pageCount, warnings, pages: [ { …, data } ] }
POST /cancel         -> { cancelled }
GET  /logs/recent    -> { lines }

errors               -> { error, message, detail }   400 bad input | 409 busy | 500 device
ports                -> 45678..45687, first free one wins
config override      -> C:\ProgramData\ScanBridge\appsettings.json
logs                 -> %LOCALAPPDATA%\ScanBridge\logs\bridge-YYYYMMDD.log
port actually in use -> %LOCALAPPDATA%\ScanBridge\port.txt
built-in test page   -> http://127.0.0.1:45678/
```
