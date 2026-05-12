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
  // Captcha provider: 'manual' | '2captcha' | 'nocaptcha'
  captchaProvider: 'manual',
  captchaApiKey: '',
};

function fileExists(p) { try { return p && fs.existsSync(p); } catch { return false; } }

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  const merged = { ...DEFAULTS, ...saved };
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

module.exports = { load, save, DEFAULTS, detectChrome };
