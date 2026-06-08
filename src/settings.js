'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

const WIN_CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
].filter(Boolean);

function detectChrome() {
  for (const p of WIN_CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return '';
}

// Split a single proxy URL (http://user:pass@host:port) into the editable parts.
function parseProxyUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      proxyProtocol: (u.protocol || 'http:').replace(/:$/, '') || 'http',
      proxyHost: u.hostname || '',
      proxyPort: u.port || '',
      proxyUsername: decodeURIComponent(u.username || ''),
      proxyPassword: decodeURIComponent(u.password || ''),
    };
  } catch { return null; }
}

// Seed the proxy fields from .env on first run (no settings.json yet) so an
// existing PROXY_* / PROXY_URL config shows up — and stays fully editable in
// the UI. Once the user saves from the UI, settings.json is the source of truth.
function envProxyParts() {
  const fromUrl = parseProxyUrl((process.env.PROXY_URL || '').trim());
  if (fromUrl) return fromUrl;
  return {
    proxyProtocol: (process.env.PROXY_PROTOCOL || 'http').trim().toLowerCase().replace(/:$/, '') || 'http',
    proxyHost: (process.env.PROXY_HOST || '').trim(),
    proxyPort: (process.env.PROXY_PORT || '').trim(),
    proxyUsername: (process.env.PROXY_USERNAME || '').trim(),
    proxyPassword: (process.env.PROXY_PASSWORD || '').trim(),
  };
}

const DEFAULTS = {
  chromePath: detectChrome(),
  userDataDir: path.join(__dirname, '..', 'data', 'chrome-profile'),
  debugPort: 9222,
  // Proxy is entered as separate fields (mirrors a Webshare "Proxy List" page)
  // and composed into proxyUrl at load() for the rest of the app to consume.
  ...envProxyParts(),
  // Per-query sticky-session rotation: each query gets a new IP for its whole
  // pagination. Requires a PAID proxy plan — Webshare FREE rejects session
  // syntax with HTTP 590 (the scraper auto-disables on the first failure).
  proxyStickySession: /^(1|true|yes|on)$/i.test((process.env.PROXY_STICKY_SESSION || '').trim()),
  // Appended (with a space) to every CSV row before searching.
  // e.g. row "@abcepta.com+marketing" + suffix "email" => "@abcepta.com+marketing email"
  querySuffix: 'email',
  // NOTE: SERP page depth is set PER JOB (at upload time) — not here — and can
  // still be overridden per-row via a "Pages" CSV column. The inter-page delay
  // is a fixed, human-like default inside the scraper (no longer a UI setting).
};

function fileExists(p) { try { return p && fs.existsSync(p); } catch { return false; } }

// Compose http://user:pass@host:port from the editable parts. Empty when no host.
function composeProxyUrl(parts) {
  const host = String(parts.proxyHost || '').trim();
  if (!host) return '';
  const protocol = String(parts.proxyProtocol || 'http').trim().toLowerCase().replace(/:$/, '') || 'http';
  const port = String(parts.proxyPort || '').trim();
  const user = String(parts.proxyUsername || '').trim();
  const pass = String(parts.proxyPassword || '').trim();
  const auth = (user || pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  const hostPort = port ? `${host}:${port}` : host;
  return `${protocol}://${auth}${hostPort}`;
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  const merged = { ...DEFAULTS, ...saved };
  // Migrate a legacy single proxyUrl (older settings.json) into parts.
  if (!merged.proxyHost && saved.proxyUrl) {
    const p = parseProxyUrl(saved.proxyUrl);
    if (p) Object.assign(merged, p);
  }
  // Self-heal a missing / invalid Chrome path so auto-launch keeps working.
  if (!fileExists(merged.chromePath)) {
    const detected = detectChrome();
    if (detected) merged.chromePath = detected;
  }
  // proxyUrl is DERIVED from the parts — always recomputed, never stored.
  merged.proxyUrl = composeProxyUrl(merged);
  return merged;
}

function save(patch) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const incoming = { ...(patch || {}) };
  delete incoming.proxyUrl;       // derived field — recomposed on load, never persisted
  delete incoming._envSourced;
  const current = load();
  delete current.proxyUrl;
  const merged = { ...current, ...incoming };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return load();                  // return the freshly composed view (incl. proxyUrl)
}

// Proxy is UI-managed now (no env pinning), so nothing is read-only in the UI.
function envSourcedKeys() { return []; }

module.exports = { load, save, DEFAULTS, detectChrome, envSourcedKeys, composeProxyUrl, parseProxyUrl };
