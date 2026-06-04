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

const DEFAULTS = {
  chromePath: detectChrome(),
  userDataDir: path.join(__dirname, '..', 'data', 'chrome-profile'),
  debugPort: 9222,
  // Upstream rotating-residential proxy. Format:
  //   http://USER:PASS@host:port  (e.g. http://krazblud-US-rotate:****@p.webshare.io:80)
  // Leave blank to scrape from your own IP.
  proxyUrl: '',
  // Per-query sticky-session rotation: each query gets a new IP for its
  // whole pagination, then a fresh one for the next query. Requires a paid
  // proxy plan (Webshare paid / IPRoyal / NodeMaven). Webshare FREE rejects
  // session syntax with HTTP 590 — keep this off on the free tier.
  proxyStickySession: false,
  pageDelayMin: 1500,
  pageDelayMax: 4000,
  // Appended (with a space) to every CSV row before searching.
  // e.g. CSV row "@abcepta.com+marketing" + suffix "email"
  //      => Google query "@abcepta.com+marketing email"
  // Set to '' to disable.
  querySuffix: 'email',
  // Default max SERP pages to paginate per query. Hard ceiling is 20
  // (in src/scraper.js) regardless of this value. Can be overridden per
  // query via an optional "Pages" column in the uploaded CSV.
  maxSerpPages: 10,
};

function fileExists(p) { try { return p && fs.existsSync(p); } catch { return false; } }

// Env vars that override settings.json. Source of truth for production
// deployment / secret management — anything set here can't be changed
// from the UI (the field renders read-only). Empty / missing env vars
// fall through to the JSON value.
//
// Two equivalent ways to configure the proxy:
//   1. Multi-var (mirrors Webshare's UI 1:1 — easier copy-paste):
//        PROXY_PROTOCOL=http
//        PROXY_HOST=p.webshare.io
//        PROXY_PORT=80
//        PROXY_USERNAME=krazblud-US-rotate
//        PROXY_PASSWORD=ithigl5ggoda
//   2. Single URL (takes precedence if both are set):
//        PROXY_URL=http://krazblud-US-rotate:ithigl5ggoda@p.webshare.io:80
function composeProxyUrl() {
  const host = (process.env.PROXY_HOST || '').trim();
  const port = (process.env.PROXY_PORT || '').trim();
  if (!host || !port) return '';
  const protocol = (process.env.PROXY_PROTOCOL || 'http').trim().toLowerCase().replace(/:$/, '');
  const user = (process.env.PROXY_USERNAME || '').trim();
  const pass = (process.env.PROXY_PASSWORD || '').trim();
  const auth = (user || pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `${protocol}://${auth}${host}:${port}`;
}

function envOverlay() {
  const env = {};
  const urlFromUrl = (process.env.PROXY_URL || '').trim();
  const urlFromParts = composeProxyUrl();
  // PROXY_URL takes precedence if explicitly set; otherwise compose from parts.
  const resolved = urlFromUrl || urlFromParts;
  if (resolved) env.proxyUrl = resolved;
  if (process.env.PROXY_STICKY_SESSION !== undefined) {
    env.proxyStickySession = /^(1|true|yes|on)$/i.test(process.env.PROXY_STICKY_SESSION);
  }
  return env;
}

// Reports which settings keys are currently sourced from .env (so the UI
// can grey out the corresponding fields and label them "from .env").
function envSourcedKeys() {
  return Object.keys(envOverlay());
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  // Order: DEFAULTS < saved (UI) < env (highest priority).
  const merged = { ...DEFAULTS, ...saved, ...envOverlay() };
  // Self-heal a missing / invalid Chrome path so auto-launch keeps working.
  if (!fileExists(merged.chromePath)) {
    const detected = detectChrome();
    if (detected) merged.chromePath = detected;
  }
  return merged;
}

function save(patch) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const merged = { ...load(), ...(patch || {}) };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { load, save, DEFAULTS, detectChrome, envSourcedKeys };
