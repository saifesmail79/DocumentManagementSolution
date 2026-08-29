/**
 * Scan Bridge client.
 *
 * The bridge is a tray helper on the user's own PC that exposes the scanner over
 * loopback HTTP. Contract: docs/SCAN_BRIDGE_INTEGRATION.md.
 *
 * Three rules from that document that are easy to get wrong:
 *
 *   • Use plain fetch, never the app's api client. These requests go to
 *     127.0.0.1, not to our server — sending session cookies or an Authorization
 *     header to a local process is both pointless and a credential leak.
 *
 *   • Never set a short timeout on /scan. A feeder run scans until the tray is
 *     empty and the request stays open for the whole job, potentially minutes.
 *     Only discovery gets a timeout.
 *
 *   • Aborting the fetch does NOT stop the scanner. Stopping requires POST
 *     /cancel, and it takes effect at the next page boundary — a sheet already
 *     moving through will finish, and a flatbed scan cannot be stopped at all.
 */

const PORT_RANGE = Array.from({ length: 10 }, (_, i) => 45678 + i);
const PROTOCOL = 1;
const CACHE_KEY = 'dms.scanBridge.port';
/** Loopback is fast; a machine without the bridge should fail quickly, not hang. */
const PROBE_TIMEOUT_MS = 400;

let baseUrl = null;

/** Bridge errors carry the machine-readable code so the UI can map it to a message. */
export class ScanBridgeError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'ScanBridgeError';
    this.code = code;
    this.detail = detail;
  }
}

async function ping(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ping`, { signal: controller.signal });
    if (!response.ok) return null;

    const info = await response.json();
    // Confirms this is the bridge and not another service squatting the port.
    if (info?.product !== 'scan-bridge') return null;
    // A different protocol number means a breaking API change; refusing is
    // safer than calling endpoints whose shape may have moved.
    if (Number(info.protocol) !== PROTOCOL) {
      return { port, info, incompatible: true };
    }
    return { port, info, incompatible: false };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds the bridge, or returns null when it is not installed.
 *
 * The winning port is cached in localStorage and tried first, so the usual case
 * is one request rather than ten.
 */
export async function discover({ force = false } = {}) {
  if (baseUrl && !force) return { baseUrl };

  const cached = readCachedPort();
  const order = cached ? [cached, ...PORT_RANGE.filter((p) => p !== cached)] : PORT_RANGE;

  for (const port of order) {
    const result = await ping(port);
    if (!result) continue;

    if (result.incompatible) {
      writeCachedPort(null);
      return { incompatible: true, version: result.info?.version };
    }

    baseUrl = `http://127.0.0.1:${port}`;
    writeCachedPort(port);
    return { baseUrl, info: result.info };
  }

  writeCachedPort(null);
  baseUrl = null;
  return null;
}

async function call(path, { method = 'GET', body, signal } = {}) {
  if (!baseUrl) {
    const found = await discover();
    if (!found?.baseUrl) throw new ScanBridgeError('bridge_unavailable', 'Scan Bridge not found');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    // No credentials: this is a local helper, not our API.
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // 403 means the app's origin is not on the bridge's allowlist. That is a
    // configuration problem on the workstation and no retry will fix it, so it
    // is reported distinctly from the runtime device errors.
    if (response.status === 403) {
      throw new ScanBridgeError('origin_rejected', 'Origin not allowed by the Scan Bridge', payload?.detail);
    }
    throw new ScanBridgeError(payload?.error ?? 'internal_error', payload?.message, payload?.detail);
  }

  return payload;
}

export const scanBridge = {
  discover,
  isReady: () => Boolean(baseUrl),
  scanners: () => call('/scanners'),

  /**
   * Runs a scan. Deliberately has no timeout — a feeder run continues until the
   * tray empties. `signal` only abandons the response; use cancel() to stop the
   * hardware.
   */
  scan: (options = {}, { signal } = {}) => call('/scan', { method: 'POST', body: options, signal }),

  /** Stops after the current page. Cannot interrupt a sheet already in motion. */
  cancel: (jobId) => call('/cancel', { method: 'POST', body: jobId ? { jobId } : {} }),

  logs: () => call('/logs/recent'),
};

/** Decodes one page's base64 payload into bytes for embedding. */
export function pageToBytes(page) {
  const binary = atob(page.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readCachedPort() {
  try {
    const value = Number(window.localStorage.getItem(CACHE_KEY));
    return PORT_RANGE.includes(value) ? value : null;
  } catch {
    // Private browsing and locked-down policies can make localStorage throw
    // rather than return null. Probing all ten ports is a fine fallback.
    return null;
  }
}

function writeCachedPort(port) {
  try {
    if (port) window.localStorage.setItem(CACHE_KEY, String(port));
    else window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* not fatal — discovery just costs more requests next time */
  }
}
