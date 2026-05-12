'use strict';

const fetch = require('node-fetch');

const TWOCAPTCHA_BASE = 'https://2captcha.com';
const NOCAPTCHA_BASE = 'https://api.nocaptcha.io';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------- detection ------------------------- */
async function detectCaptcha(page) {
  const url = page.url();
  const html = await page.content().catch(() => '');
  if (/sorry\/index|\/sorry\//i.test(url)) return { type: 'google-block', url };
  if (/recaptcha\/api2|google\.com\/recaptcha/i.test(html)) return { type: 'recaptcha', url };
  if (/hcaptcha\.com\/captcha/i.test(html) || /h-captcha/i.test(html)) return { type: 'hcaptcha', url };
  if (/cf-challenge|cdn-cgi\/challenge/i.test(html)) return { type: 'cloudflare', url };
  return null;
}

async function findRecaptchaSiteKey(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    const m = document.documentElement.outerHTML.match(/sitekey["'\s:=]+([0-9A-Za-z_-]{30,})/);
    return m ? m[1] : null;
  }).catch(() => null);
}

async function findHcaptchaSiteKey(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.h-captcha[data-sitekey], [data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    return null;
  }).catch(() => null);
}

/* ------------------------- token injection ------------------------- */
async function injectRecaptchaToken(page, token) {
  await page.evaluate((t) => {
    const ta = document.getElementById('g-recaptcha-response');
    if (ta) { ta.value = t; ta.style.display = 'block'; }
    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach((n) => { n.value = t; });
    if (typeof window.___grecaptcha_cfg !== 'undefined') {
      try {
        const ids = Object.keys(window.___grecaptcha_cfg.clients || {});
        ids.forEach((cid) => {
          const c = window.___grecaptcha_cfg.clients[cid];
          for (const k of Object.keys(c)) {
            const v = c[k];
            if (v && typeof v === 'object' && v.callback) v.callback(t);
          }
        });
      } catch {}
    }
    const form = document.querySelector('form');
    if (form) form.submit();
  }, token);
}

async function injectHcaptchaToken(page, token) {
  await page.evaluate((t) => {
    document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]').forEach((n) => { n.value = t; });
  }, token);
}

/* ------------------------- 2captcha provider ------------------------- */
async function submit2captcha(apiKey, params) {
  const body = new URLSearchParams({ key: apiKey, json: '1', ...params });
  const res = await fetch(`${TWOCAPTCHA_BASE}/in.php`, { method: 'POST', body });
  const json = await res.json();
  if (json.status !== 1) throw new Error(`2captcha submit failed: ${json.request}`);
  return json.request;
}
async function poll2captcha(apiKey, captchaId, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const url = `${TWOCAPTCHA_BASE}/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status === 1) return json.request;
    if (json.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha poll failed: ${json.request}`);
  }
  throw new Error('2captcha timeout');
}
async function solveWith2Captcha(page, detected, { apiKey, log }) {
  if (detected.type === 'hcaptcha') {
    const siteKey = await findHcaptchaSiteKey(page);
    if (!siteKey) throw new Error('hCaptcha sitekey not found');
    log(`2captcha solving hCaptcha (sitekey=${siteKey.slice(0, 10)}…)`);
    const id = await submit2captcha(apiKey, { method: 'hcaptcha', sitekey: siteKey, pageurl: page.url() });
    const token = await poll2captcha(apiKey, id);
    await injectHcaptchaToken(page, token);
    return token;
  }
  // reCAPTCHA / google-block
  const siteKey = await findRecaptchaSiteKey(page);
  if (!siteKey) throw new Error('reCAPTCHA sitekey not found');
  log(`2captcha solving reCAPTCHA (sitekey=${siteKey.slice(0, 10)}…)`);
  const id = await submit2captcha(apiKey, { method: 'userrecaptcha', googlekey: siteKey, pageurl: page.url() });
  const token = await poll2captcha(apiKey, id);
  await injectRecaptchaToken(page, token);
  return token;
}

/* ------------------------- nocaptcha.io provider ------------------------- */
// https://nocaptcha.io — best-tuned solver for Google's /sorry/ block.
async function callNoCaptcha(path, apiKey, body) {
  const res = await fetch(`${NOCAPTCHA_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Token': apiKey },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); }
  catch { throw new Error(`nocaptcha non-JSON response (HTTP ${res.status})`); }
  if (json.status !== 1) {
    throw new Error(`nocaptcha: ${json.msg || json.message || JSON.stringify(json)}`);
  }
  return json.data;
}
async function solveWithNoCaptcha(page, detected, { apiKey, log }) {
  if (detected.type === 'hcaptcha') {
    const siteKey = await findHcaptchaSiteKey(page);
    if (!siteKey) throw new Error('hCaptcha sitekey not found');
    log(`nocaptcha solving hCaptcha (sitekey=${siteKey.slice(0, 10)}…)`);
    const data = await callNoCaptcha('/api/wanda/hcaptcha/universal', apiKey, {
      sitekey: siteKey, referer: page.url(),
    });
    if (!data?.token) throw new Error('nocaptcha returned no token');
    await injectHcaptchaToken(page, data.token);
    return data.token;
  }
  // reCAPTCHA / google-block
  const siteKey = await findRecaptchaSiteKey(page);
  if (!siteKey) throw new Error('reCAPTCHA sitekey not found');
  log(`nocaptcha solving reCAPTCHA (sitekey=${siteKey.slice(0, 10)}…)`);
  const data = await callNoCaptcha('/api/wanda/recaptcha/universal', apiKey, {
    sitekey: siteKey,
    referer: page.url(),
    size: 'normal',
    title: detected.type === 'google-block' ? 'google sorry' : '',
  });
  if (!data?.token) throw new Error('nocaptcha returned no token');
  await injectRecaptchaToken(page, data.token);
  return data.token;
}

/* ------------------------- manual solve fallback ------------------------- */
async function waitForManualSolve(page, { log, timeoutMs = 5 * 60 * 1000, intervalMs = 1500 } = {}) {
  log('waiting for human to solve in the visible Chrome window (timeout 5 min)…');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      const stillBlocked = await page.evaluate(() => {
        if (/\/sorry\//i.test(location.href)) return true;
        if (document.querySelector('iframe[src*="recaptcha/api2/bframe"]')) return true;
        return false;
      }).catch(() => true);
      if (!stillBlocked) {
        log('captcha cleared by human — continuing');
        return true;
      }
    } catch {}
  }
  log('manual solve timed out');
  return false;
}

/* ------------------------- entry point ------------------------- */
async function maybeSolve(page, { provider = 'manual', apiKey = '', log = () => {} } = {}) {
  const detected = await detectCaptcha(page);
  if (!detected) return { detected: null, solved: false };
  log(`captcha detected: ${detected.type} @ ${detected.url}`);

  // 1. Try the configured automated provider, if any.
  if (apiKey && (provider === '2captcha' || provider === 'nocaptcha')) {
    try {
      if (provider === '2captcha') await solveWith2Captcha(page, detected, { apiKey, log });
      else if (provider === 'nocaptcha') await solveWithNoCaptcha(page, detected, { apiKey, log });
      // Give the page a moment to react to the token / form submit.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const after = await detectCaptcha(page);
      if (!after) { log('captcha cleared by solver'); return { detected, solved: true, via: provider }; }
      log(`solver returned a token but page still shows captcha — waiting for human assist`);
    } catch (err) {
      log(`${provider} failed: ${err.message} — waiting for human assist`);
    }
  } else if (provider === 'manual' || !apiKey) {
    log('manual mode (no API key) — solve the captcha in the Chrome window');
  }

  // 2. Fall back to manual solve in the visible browser.
  const ok = await waitForManualSolve(page, { log });
  return { detected, solved: ok, via: 'manual' };
}

module.exports = {
  detectCaptcha,
  maybeSolve,
  solveWith2Captcha,
  solveWithNoCaptcha,
  waitForManualSolve,
};
