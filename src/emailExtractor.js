'use strict';

const cheerio = require('cheerio');

// Lookbehind prevents the local-part from absorbing a preceding email-char
// run. e.g. ">privacyofficer@..." (> decoded to ">" first) — the
// match starts at "p", not "u003eprivacy…". Domain still has its old shape;
// it's validated/trimmed against COMMON_TLDS afterwards.
const EMAIL_REGEX = /(?<![a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

// Domains where the regex stopped at a real TLD: "gmail.com", "sagebase.org".
// Domains where the regex over-ran into trailing words: "sagebase.org.read",
// "adknowledgeportal.synapse.org.research". We trim by walking the domain
// labels from the right and keeping the longest prefix ending in a valid TLD.
const COMMON_TLDS = new Set([
  // Original gTLDs
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int',
  'info', 'biz', 'name', 'pro', 'mobi', 'tel', 'travel', 'jobs', 'museum', 'aero', 'coop',
  // Newer gTLDs commonly seen on company / SaaS sites
  'io', 'ai', 'co', 'app', 'dev', 'me', 'tv', 'us', 'eu', 'asia',
  'tech', 'cloud', 'online', 'site', 'store', 'shop', 'agency', 'media', 'studio', 'group',
  'club', 'world', 'today', 'live', 'life', 'top', 'xyz', 'ltd', 'company', 'community',
  'health', 'care', 'services', 'consulting', 'design', 'digital', 'global', 'works',
  'systems', 'solutions', 'network', 'foundation', 'institute', 'academy', 'press',
  'news', 'photo', 'photos', 'photography', 'video', 'film', 'music', 'art', 'gallery',
  'zone', 'link', 'page', 'space', 'website', 'web',
  'finance', 'fund', 'capital', 'partners', 'energy', 'science', 'engineering',
  // ccTLDs (top usage). 2-letter labels are also accepted by isValidTld().
  'uk', 'de', 'fr', 'es', 'it', 'nl', 'be', 'se', 'no', 'fi', 'dk', 'pl', 'cz', 'at', 'ch',
  'jp', 'cn', 'kr', 'in', 'au', 'nz', 'ca', 'mx', 'br', 'ar', 'ru', 'tr', 'gr', 'pt', 'hu',
  'ie', 'sg', 'hk', 'tw', 'ph', 'th', 'vn', 'my', 'id', 'ae', 'sa', 'eg', 'za', 'ng', 'ke',
  'il', 'ua', 'by', 'rs', 'ba', 'mk', 'al', 'md', 'ge', 'am', 'az',
  'is', 'lu', 'mt', 'cy', 'sk', 'ro', 'bg', 'lt', 'lv', 'ee',
]);

function isValidTld(label) {
  if (!label) return false;
  if (COMMON_TLDS.has(label)) return true;
  if (/^[a-z]{2}$/.test(label)) return true;        // any 2-letter ccTLD
  if (/^xn--[a-z0-9-]+$/.test(label)) return true;  // IDN punycode
  return false;
}

function trimDomainToValidTld(domain) {
  const parts = String(domain || '').toLowerCase().split('.');
  if (parts.length < 2) return null;
  if (isValidTld(parts[parts.length - 1])) return parts.join('.');
  for (let i = parts.length - 1; i >= 2; i--) {
    if (isValidTld(parts[i - 1])) return parts.slice(0, i).join('.');
  }
  return null;
}

const OBFUSCATION_PATTERNS = [
  { re: /\s*\[\s*at\s*\]\s*/gi, replace: '@' },
  { re: /\s*\(\s*at\s*\)\s*/gi, replace: '@' },
  { re: /\s*\{\s*at\s*\}\s*/gi, replace: '@' },
  { re: /\s+at\s+/gi, replace: '@' },
  { re: /\s*\[\s*dot\s*\]\s*/gi, replace: '.' },
  { re: /\s*\(\s*dot\s*\)\s*/gi, replace: '.' },
  { re: /\s*\{\s*dot\s*\}\s*/gi, replace: '.' },
  { re: /\s+dot\s+/gi, replace: '.' },
  { re: /&#64;/g, replace: '@' },
  { re: /&#46;/g, replace: '.' },
  { re: /​|‌|‍|﻿/g, replace: '' },
];

const BLOCKED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
  'css', 'js', 'mp3', 'mp4', 'avi', 'mov', 'pdf', 'zip',
  'rar', 'tar', 'gz', 'doc', 'docx', 'xls', 'xlsx', 'ppt',
  'pptx', 'woff', 'woff2', 'ttf', 'eot',
]);

const SPAMMY_LOCALS = new Set([
  'example', 'test', 'sample', 'foo', 'bar', 'noreply',
  'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
  'postmaster', 'abuse', 'webmaster',
]);

function deobfuscate(text) {
  let out = String(text || '');

  // 1. Decode JS string escapes that show up in JSON-embedded HTML / inline
  //    <script> JSON. e.g. raw HTML literally contains ">privacyofficer"
  //    when a script wrote ">privacyofficer". Without this, the regex skips
  //    the "\" and starts at "u003e" → bogus local part.
  out = out
    .replace(/\\u003[eE]/g, '>').replace(/\\u003[cC]/g, '<')
    .replace(/\\u0026/g, '&').replace(/\\u0027/g, "'")
    .replace(/\\u0022/g, '"').replace(/\\u002[fF]/g, '/')
    .replace(/\\x3[eE]/g, '>').replace(/\\x3[cC]/g, '<')
    .replace(/\\x3[dD]/g, '=').replace(/\\x26/g, '&')
    .replace(/\\x27/g, "'").replace(/\\x22/g, '"');

  // 2. Decode common HTML entities so raw-HTML scans don't see "&gt;email" etc.
  out = out
    .replace(/&gt;/gi, '>').replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'");

  // 3. Original obfuscation patterns ([at], (dot), zero-width chars, …).
  for (const { re, replace } of OBFUSCATION_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

// Cloudflare Email Protection: a hex string where the first byte is an XOR
// key for every subsequent byte. e.g. data-cfemail="b1c8c9e3..." → "info@…".
function decodeCfEmail(encoded) {
  if (!encoded || typeof encoded !== 'string' || encoded.length < 4) return null;
  if (!/^[a-f0-9]+$/i.test(encoded)) return null;
  try {
    const r = parseInt(encoded.slice(0, 2), 16);
    if (Number.isNaN(r)) return null;
    let email = '';
    for (let n = 2; n < encoded.length; n += 2) {
      const c = parseInt(encoded.slice(n, n + 2), 16) ^ r;
      if (Number.isNaN(c) || c < 32 || c > 126) return null;
      email += String.fromCharCode(c);
    }
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

function isLikelyAsset(local, domain) {
  const ext = (local.split('.').pop() || '').toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) return true;
  const tld = (domain.split('.').pop() || '').toLowerCase();
  if (BLOCKED_EXTENSIONS.has(tld)) return true;
  if (/^\d+x\d+$/.test(local)) return true;
  if (local.length > 64) return true;
  if (domain.length > 253) return true;
  return false;
}

function looksSpammy(local) {
  return SPAMMY_LOCALS.has(local.toLowerCase());
}

function extractFromText(text) {
  if (!text) return [];
  const cleaned = deobfuscate(text);
  const found = new Set();
  let m;
  EMAIL_REGEX.lastIndex = 0;
  while ((m = EMAIL_REGEX.exec(cleaned)) !== null) {
    const local = m[1];
    let domain = m[2].toLowerCase();
    if (isLikelyAsset(local, domain)) continue;

    // Drop tiny locals that are usually JS-escape leftovers (e.g. "x3d", "u").
    if (local.length < 2) continue;
    // Pure-numeric locals are almost always tracking pixels / IDs.
    if (/^[0-9]+$/.test(local)) continue;

    // Trim trailing non-TLD labels: "sagebase.org.read" → "sagebase.org",
    // "adknowledgeportal.synapse.org.research" → "adknowledgeportal.synapse.org".
    const trimmed = trimDomainToValidTld(domain);
    if (!trimmed) continue;
    domain = trimmed;

    found.add(`${local}@${domain}`.toLowerCase());
  }
  return [...found];
}

function extractFromHtml(html, sourceUrl = '') {
  if (!html) return [];
  const found = new Set();
  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return extractFromText(html).map((e) => ({ email: e, source: sourceUrl, context: 'text' }));
  }

  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const raw = href.replace(/^mailto:/i, '').split('?')[0].trim();
    // mailto: can contain comma-separated recipients
    for (const part of raw.split(/[,;]/)) {
      for (const e of extractFromText(part)) found.add(JSON.stringify({ email: e, context: 'mailto' }));
    }
  });

  // ---------- Cloudflare Email Protection decoder ----------
  // Sites using this look like:
  //   <a class="__cf_email__" data-cfemail="HEX">[email protected]</a>
  // or
  //   <a href="/cdn-cgi/l/email-protection#HEX">[email protected]</a>
  // The visible text is NEVER the real email — it has to be XOR-decoded.
  $('[data-cfemail], .__cf_email__').each((_, el) => {
    const enc = $(el).attr('data-cfemail');
    const decoded = decodeCfEmail(enc);
    if (decoded) {
      for (const e of extractFromText(decoded)) {
        found.add(JSON.stringify({ email: e, context: 'cloudflare' }));
      }
    }
  });
  $('a[href*="/cdn-cgi/l/email-protection"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/#([a-fA-F0-9]+)/);
    if (m) {
      const decoded = decodeCfEmail(m[1]);
      if (decoded) {
        for (const e of extractFromText(decoded)) {
          found.add(JSON.stringify({ email: e, context: 'cloudflare' }));
        }
      }
    }
  });

  // ---------- visible text + raw HTML ----------
  $('script, style, noscript').remove();
  const visible = $('body').text() || $.root().text();
  for (const e of extractFromText(visible)) {
    found.add(JSON.stringify({ email: e, context: 'body' }));
  }

  for (const e of extractFromText(html)) {
    found.add(JSON.stringify({ email: e, context: 'html' }));
  }

  return [...found].map((s) => {
    const obj = JSON.parse(s);
    return { ...obj, source: sourceUrl };
  });
}

function dedupeAndScore(records) {
  const map = new Map();
  for (const r of records) {
    const key = r.email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { email: key, sources: new Set(), contexts: new Set(), spammy: looksSpammy(key.split('@')[0]) });
    }
    const item = map.get(key);
    if (r.source) item.sources.add(r.source);
    if (r.context) item.contexts.add(r.context);
  }
  return [...map.values()].map((v) => ({
    email: v.email,
    sources: [...v.sources],
    contexts: [...v.contexts],
    spammy: v.spammy,
  }));
}

module.exports = { extractFromText, extractFromHtml, dedupeAndScore, deobfuscate, decodeCfEmail };
