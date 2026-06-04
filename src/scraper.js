'use strict';

const { chromium } = require('playwright');
const { extractFromHtml, extractFromText, dedupeAndScore } = require('./emailExtractor');
const { scrollToPagination, clickNextPage, getNextPageUrl } = require('./serpPaginator');
const proxyMod = require('./proxy');

// Inline /sorry/ detector — replaces the old captcha solver module. With
// rotating residential proxies we just skip to the next query (different IP)
// instead of trying to solve.
function isGoogleBlock(page) {
  return /\/sorry\//i.test(page.url());
}

// Parse the SERP DOM into per-result {title, url, description} objects.
// We try Google's stable wrapper classes first (.MjjYud / .tF2Cxc / .g),
// then fall back to a structural heuristic ("div that contains exactly one
// h3 and one external link"). This is robust against Google's frequent
// class-name churn.
async function extractSerpResults(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const blocks = new Set();
    document.querySelectorAll('div.MjjYud, div.tF2Cxc, div.g[data-hveid]').forEach((b) => blocks.add(b));
    // Heuristic fallback: any div with one h3 + one external anchor.
    if (blocks.size === 0) {
      document.querySelectorAll('div').forEach((b) => {
        if (b.querySelector('h3') && b.querySelector('a[href^="http"]')) blocks.add(b);
      });
    }
    const DESC_SEL = 'div[data-sncf="1"], .VwiC3b, .yXK7lf, .lyLwlc, span.aCOpRe, .lEBKkf';
    for (const block of blocks) {
      const a = block.querySelector('a[href^="http"]:not([href*="google."])');
      const h3 = block.querySelector('h3');
      if (!a || !h3) continue;
      const url = a.href;
      if (seen.has(url)) continue;
      const title = (h3.textContent || '').trim();
      if (!title) continue;
      const descEl = block.querySelector(DESC_SEL);
      let description = descEl ? (descEl.textContent || '').trim() : '';
      // Strip Google's trailing "...Read more" suffix.
      description = description.replace(/\s*…?\s*Read more\s*$/i, '').trim();
      seen.add(url);
      out.push({ url, title, description });
    }
    return out;
  });
}

// Strip Google's leading-date noise + trailing "Read more" link text.
// Matches:
//   "Jul 1, 2025 — …"      "Apr 30, 2024 — …"
//   "Aug 31, 2023 · …"     "1 day ago · …"
//   "Yesterday — …"        "Today · …"
function cleanDescription(desc) {
  if (!desc) return '';
  let s = String(desc);
  // Leading absolute date: "Month D, YYYY <separator>" — separators we've
  // seen are em-dash —, en-dash –, hyphen -, middle-dot ·.
  s = s.replace(/^([A-Z][a-z]+\.?)\s+\d{1,2},?\s+\d{4}\s*[—–·\-]\s*/, '');
  // Leading relative date: "N units ago <separator>"
  s = s.replace(/^\d+\s+(day|days|hour|hours|minute|minutes|week|weeks|month|months|year|years)\s+ago\s*[—–·\-]?\s*/i, '');
  // Leading "Yesterday — " / "Today · "
  s = s.replace(/^(yesterday|today)\s*[—–·\-]\s*/i, '');
  // Trailing "…Read more" link text
  s = s.replace(/\s*…?\s*Read more\s*$/i, '');
  return s.trim();
}

// Given the parsed SERP results + the full page HTML, build a unified list
// of email records each carrying its source-result context (title / url /
// description). Descriptions are cleaned (dates + "Read more" stripped).
function buildEmailRecords(serpResults, pageHtml, pageUrl) {
  const out = [];
  const seenPerPage = new Set();

  // Pass 1 — per-result emails (high-confidence, since Google chose to
  // surface the snippet because it matched the query).
  for (const r of serpResults) {
    const cleanedDesc = cleanDescription(r.description);
    const descEmails = extractFromText(cleanedDesc);
    const titleEmails = extractFromText(r.title);
    const all = new Set([...descEmails, ...titleEmails]);
    for (const email of all) {
      const inDesc = cleanedDesc && cleanedDesc.toLowerCase().includes(email);
      out.push({
        email,
        title: r.title,
        url: r.url,
        description: cleanedDesc,
        in_text: !!inDesc,
        context: inDesc ? 'description' : 'title',
      });
      seenPerPage.add(email);
    }
  }

  // Pass 2 — emails in the rest of the page HTML that didn't already land
  // in pass 1 (footers, knowledge panels, embedded widgets, etc.).
  const pageEmails = extractFromHtml(pageHtml, pageUrl);
  for (const e of pageEmails) {
    if (seenPerPage.has(e.email)) continue;
    out.push({
      email: e.email,
      title: '',
      url: '',
      description: '',
      in_text: false,
      context: `page-${e.context || 'html'}`,
    });
    seenPerPage.add(e.email);
  }
  return out;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getBrowser({ cdpEndpoint, headless, slowMo, proxyUrl }) {
  if (cdpEndpoint) {
    // Chrome was launched with --proxy-server pointing at the local chain
    // (handled in browser.js). CDP attach inherits that routing for free.
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    return { browser, attached: true };
  }
  // Bundled Chromium fallback uses Playwright's native proxy option which
  // handles auth via Fetch.handleAuthRequired internally — no chain needed.
  const launchOpts = {
    headless: !!headless,
    slowMo: slowMo || 0,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (proxyUrl) {
    const p = proxyMod.parseUrl(proxyUrl);
    if (p) {
      launchOpts.proxy = { server: p.server };
      if (p.username) launchOpts.proxy.username = p.username;
      if (p.password) launchOpts.proxy.password = p.password;
    }
  }
  try {
    const browser = await chromium.launch(launchOpts);
    return { browser, attached: false };
  } catch (err) {
    if (/Executable doesn't exist/i.test(err.message)) {
      throw new Error(
        'No CDP endpoint configured AND Playwright Chromium is not installed. ' +
        'Open Settings (gear icon) → fill in your Chrome executable path so the harvester can auto-launch your real Chrome. ' +
        '(Or install the fallback browser with: npx playwright install chromium)'
      );
    }
    throw err;
  }
}

async function newContext(browser, attached, { userAgent }) {
  if (attached) {
    const contexts = browser.contexts();
    if (contexts.length) return { ctx: contexts[0], owned: false };
  }
  const ctx = await browser.newContext({
    userAgent: userAgent || DEFAULT_UA,
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  return { ctx, owned: true };
}

// Preserve `+` (already-encoded space) and `@` literally so queries like
// `@adinstruments.com+marketing` produce the URL the user expects.
function encodeQuery(q) {
  return String(q)
    .split('')
    .map((c) => {
      if (/[a-zA-Z0-9._~+@\-]/.test(c)) return c;
      if (c === ' ') return '+';
      return encodeURIComponent(c);
    })
    .join('');
}

function buildSearchUrl(query, page, { num = 10 } = {}) {
  const start = Math.max(0, (page - 1) * num);
  const q = encodeQuery(query);
  let url = `https://www.google.com/search?q=${q}`;
  if (num !== 10) url += `&num=${num}`;
  if (start > 0) url += `&start=${start}`;
  return url;
}

// CSV rows can be either bare query strings ("@abcepta.com+marketing") OR
// pre-built URLs ("https://www.google.com/search?q=..."). Detect URL form so
// we navigate to it directly instead of running it through encodeQuery, which
// would turn the URL into a search FOR that URL.
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

// Hard safety net so a truly broken page doesn't paginate forever.
const MAX_SERP_PAGES = 20;

async function runJob(jobConfig, { onLog, onProgress, onEmails, isCancelled, isPaused }) {
  const {
    queries = [],
    cdpEndpoint = process.env.CDP_ENDPOINT || '',
    headless = (process.env.HEADLESS || 'false') === 'true',
    slowMo = parseInt(process.env.SLOW_MO || '0', 10),
    userAgent = process.env.USER_AGENT || '',
    navTimeoutMs = parseInt(process.env.NAV_TIMEOUT_MS || '45000', 10),
    pageDelayMin = parseInt(process.env.PAGE_DELAY_MIN_MS || '1500', 10),
    pageDelayMax = parseInt(process.env.PAGE_DELAY_MAX_MS || '4000', 10),
    querySuffix = '',
    proxyUrl = '',
    proxyStickySession = false,
    maxSerpPages = 10,
  } = jobConfig;

  const log = (msg) => onLog?.(`[scraper] ${msg}`);
  const progress = (p) => onProgress?.(p);

  // Append suffix (e.g. "email") to every query if configured. CSV rows like
  // "@abcepta.com+marketing" become Google searches "@abcepta.com+marketing email".
  const trimmedSuffix = String(querySuffix || '').trim();
  const decorate = (q) => trimmedSuffix ? `${q} ${trimmedSuffix}` : q;

  log(`starting job: ${queries.length} queries · extracting emails directly from SERP pages${trimmedSuffix ? ` · suffix "${trimmedSuffix}"` : ''}`);
  log(cdpEndpoint ? `attaching to CDP ${cdpEndpoint}` : `launching local Chromium (headless=${headless})`);

  const { browser, attached } = await getBrowser({ cdpEndpoint, headless, slowMo, proxyUrl });
  const { ctx, owned } = await newContext(browser, attached, { userAgent });

  // Reuse the first existing tab (Chrome's default New Tab when we just
  // launched it) instead of opening another one. Only spawn a fresh page
  // if the context is empty for some reason.
  const existingPages = ctx.pages();
  const ownedPage = existingPages.length === 0;
  const page = ownedPage ? await ctx.newPage() : existingPages[0];
  try { await page.bringToFront(); } catch {}
  page.setDefaultNavigationTimeout(navTimeoutMs);

  // Egress-IP sanity check — Chrome routes through the proxy chain (or not)
  // for real here. Logging this once at job start makes it instantly obvious
  // whether the proxy is taking effect. If the IP looks like the user's
  // home IP and a proxy was configured, something's off (typically a stale
  // un-killed Chrome from a previous run).
  try {
    await page.goto('https://api.ipify.org?format=json', { timeout: 8000 });
    const ip = await page.evaluate(() => {
      try { return JSON.parse(document.body.innerText).ip; } catch { return document.body.innerText.trim(); }
    });
    if (proxyUrl) log(`[browser] egress IP through proxy: ${ip}`);
    else log(`[browser] egress IP (direct, no proxy): ${ip}`);
  } catch (err) {
    log(`[browser] egress IP check failed: ${err.message}`);
  }

  const allResults = [];
  // 1 step per query — no dynamic step inflation. The bar is a stable
  // "queries done / queries total" counter for the whole run.
  const totalSteps = queries.length;
  let stepsDone = 0;
  const tick = () => { stepsDone++; progress({ stepsDone, totalSteps }); };

  // If the user enabled sticky rotation but their proxy plan rejects it
  // (free-tier Webshare returns HTTP 590), we flip this flag on the first
  // failed query and stop rewriting the session for the rest of the run.
  let stickyDisabled = false;

  try {
    for (let qi = 0; qi < queries.length; qi++) {
      const rawQ = queries[qi];
      // Queries can be plain strings OR { query, pages } objects (when the
      // uploaded CSV has an optional Pages column).
      const q = typeof rawQ === 'string' ? rawQ : (rawQ && rawQ.query) || '';
      const queryPagesCap = (rawQ && typeof rawQ.pages === 'number' && rawQ.pages > 0)
        ? Math.min(rawQ.pages, MAX_SERP_PAGES)
        : Math.min(maxSerpPages || 10, MAX_SERP_PAGES);
      if (!q) { log(`[query ${qi + 1}/${queries.length}] empty — skipping`); tick(); continue; }
      if (isCancelled?.()) { log('cancelled'); break; }
      while (isPaused?.()) await sleep(500);

      // Bail out cleanly if the browser died between queries — otherwise
      // every subsequent goto() throws a confusing "Target closed" error.
      if (!browser.isConnected || !browser.isConnected()) {
        log('browser disconnected — aborting remaining queries');
        break;
      }

      // Per-query sticky-session rotation — each query gets a fresh IP from
      // the upstream pool and keeps it for its whole pagination. Off by
      // default because Webshare FREE rejects session syntax (HTTP 590).
      // The auto-disable below catches that case mid-run too.
      // Token must be pure alphanumeric: Webshare splits the username on '-'.
      if (proxyUrl && proxyStickySession && !stickyDisabled) {
        const token = `q${qi + 1}${Math.random().toString(36).slice(2, 10)}`;
        const rewritten = proxyMod.setSessionToken(token);
        if (rewritten && rewritten !== proxyUrl) {
          log(`[proxy] sticky session token: ${token}`);
        }
      }

      const queryEmails = [];

      // Two CSV row shapes: bare query string vs. full URL. Bare strings get
      // the "+ suffix" decoration and a built search URL; URLs are used as-is.
      const asUrl = isHttpUrl(q);
      const firstUrl = asUrl ? q.trim() : buildSearchUrl(decorate(q), 1);
      const decoratedNote = (!asUrl && trimmedSuffix) ? ` (+ "${trimmedSuffix}")` : '';
      const kindNote = asUrl ? ' [direct URL]' : '';
      log(`[query ${qi + 1}/${queries.length}]${kindNote} "${q}"${decoratedNote} -> ${firstUrl}`);

      try {
        await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
      } catch (err) {
        log(`nav failed: ${err.message}`);
        // Webshare FREE returns HTTP 590 / proxy errors when given session
        // syntax. Flip sticky rotation off, point the chain back at the
        // base URL, and let the next query proceed via plain rotating.
        if (proxyUrl && proxyStickySession && !stickyDisabled &&
            /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|net::ERR_HTTP_RESPONSE_CODE_FAILURE|590|407/i.test(err.message)) {
          stickyDisabled = true;
          proxyMod.setSessionToken(''); // restores baseUrl as upstream
          log('[proxy] sticky session rejected by upstream — disabling rotation for the rest of this run (likely a free-tier Webshare account; sticky requires a paid plan)');
        }
        tick();
        allResults.push({ query: q, emails: [] });
        continue; // move on to the next query — never abort the whole run
      }

      // Paginate through the SERP up to this query's page cap, extracting
      // per-result {title, url, description} + emails from each result.
      log(`[query ${qi + 1}/${queries.length}] page cap: ${queryPagesCap}`);
      for (let p = 1; p <= queryPagesCap; p++) {
        if (isCancelled?.()) break;
        while (isPaused?.()) await sleep(500);

        // Captcha block? With rotating proxies just bail on this query and
        // let the next query land on a fresh IP. No solver, no manual wait.
        if (isGoogleBlock(page)) {
          log(`page ${p}: Google /sorry/ block — abandoning query, next query gets a different IP`);
          break;
        }

        // Wait for SERP to settle (initial paint + Google's late XHRs).
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await scrollToPagination(page, { log: (m) => log(m) });
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

        const pageUrl = page.url();
        let html = '';
        try { html = await page.content(); }
        catch (err) { log(`content failed on page ${p}: ${err.message}`); }

        // Per-result parse: title / url / description for every SERP result
        // block on the page.
        const serpResults = await extractSerpResults(page).catch(() => []);
        log(`page ${p}: ${serpResults.length} SERP result block(s) parsed`);

        // Cross-reference: extract emails per result + from page chrome.
        const records = buildEmailRecords(serpResults, html, pageUrl);

        // Iframe sweep (rare, but cheap — keep it).
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            const fHtml = await frame.content();
            if (!fHtml) continue;
            const fEmails = extractFromHtml(fHtml, frame.url() || pageUrl);
            if (fEmails.length) {
              log(`+${fEmails.length} from iframe ${(frame.url() || '').slice(0, 60)}`);
              for (const e of fEmails) {
                records.push({
                  email: e.email, title: '', url: '', description: '',
                  in_text: false, context: `iframe-${e.context || 'html'}`,
                });
              }
            }
          } catch {}
        }

        if (records.length) {
          log(`page ${p}: ${records.length} email candidate(s) (${records.filter((r) => r.in_text).length} in-text)`);
          queryEmails.push(...records.map((e) => ({ ...e, query: q })));
          if (onEmails) {
            try {
              onEmails({
                query: q,
                sourceUrl: pageUrl,
                sourceTitle: `SERP page ${p}`,
                serpPage: p,
                emails: records,
              });
            } catch (cbErr) { log(`onEmails callback error: ${cbErr.message}`); }
          }
        } else {
          log(`page ${p}: no emails on this page`);
        }

        // Move to the next page if there is one.
        const nextHref = await getNextPageUrl(page);
        if (!nextHref) { log(`page ${p}: no next link — stopping`); break; }

        await sleep(rand(pageDelayMin, pageDelayMax));
        if (isCancelled?.()) break;
        while (isPaused?.()) await sleep(500);

        const clicked = await clickNextPage(page, { navTimeoutMs, log });
        if (clicked) {
          log(`page ${p} → ${p + 1}: clicked Next`);
        } else {
          log(`page ${p} → ${p + 1}: click failed, navigating by URL`);
          try {
            await page.goto(nextHref, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
          } catch (err) {
            log(`page ${p + 1} nav failed: ${err.message}`);
            break;
          }
        }

      }

      const scored = dedupeAndScore(queryEmails);
      allResults.push({ query: q, emails: scored });
      log(`[query ${qi + 1}/${queries.length}] complete: ${scored.length} unique email candidate(s)`);
      tick();
    }
  } finally {
    // Only close the page if WE created it. A reused tab (the user's existing
    // Chrome tab via CDP) stays open after the job finishes.
    if (ownedPage) { try { await page.close(); } catch {} }
    if (owned) { try { await ctx.close(); } catch {} }
    if (!attached) { try { await browser.close(); } catch {} }
  }

  return allResults;
}

module.exports = { runJob, buildSearchUrl };
