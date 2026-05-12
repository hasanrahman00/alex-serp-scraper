'use strict';

const { humanScroll } = require('./humanScroll');

// Smooth scroll-to-pagination + click-to-next module for Google SERP.
// More human-like than jumping by URL each page: it preserves session state,
// triggers any lazy-loaded results, and gives Google fewer "bot-y" signals.

const NEXT_SEL = 'a#pnnext, a[aria-label="Next page"], a[aria-label^="Next"], a[aria-label*="Next page"], td a[id="pnnext"]';
const NAV_SEL = `${NEXT_SEL}, #botstuff table[role="navigation"], #foot, table.AaVjTc`;

/**
 * Scroll the SERP downward at human pace until the pagination/footer is
 * visible (early-exit) or the page has truly bottomed out.
 */
async function scrollToPagination(page, { log = () => {}, isCancelled } = {}) {
  // Google SERP is fully server-rendered, so scrolling here only exists to
  // reveal the "Next" link. Big steps + short pauses get us there fast.
  // Email extraction is unaffected by scroll position because page.content()
  // returns the complete DOM regardless.
  const result = await humanScroll(page, {
    log,
    isCancelled,
    stepPx: [700, 1200],
    delayMs: [180, 420],
    maxTicks: 12,
    stableTicks: 2,
    longPauseChance: 0.02,
    until: (p) =>
      p.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight + 300 && r.bottom > -100;
      }, NAV_SEL),
  });
  if (result.hitTarget) log(`paginator: nav visible after ${result.ticks} tick(s)`);
  return result.hitTarget;
}

/** Returns the href of the "Next" SERP link, or null if there isn't one. */
async function getNextPageUrl(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.href : null;
  }, NEXT_SEL).catch(() => null);
}

/**
 * Try to advance to the next SERP page by clicking the visible "Next" link.
 * Returns true on a successful navigation, false if no link is found or
 * the click didn't take.
 */
async function clickNextPage(page, { navTimeoutMs = 30000, log = () => {} } = {}) {
  const handle = await page.$(NEXT_SEL).catch(() => null);
  if (!handle) return false;

  try {
    await handle.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    const before = page.url();

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => {}),
      handle.click({ delay: 40 + Math.random() * 80 }),
    ]);

    // Some Google variants do soft URL changes — wait for either url or DOM swap.
    const settled = await page.waitForFunction(
      (b) => location.href !== b,
      before,
      { timeout: 4000 },
    ).then(() => true).catch(() => false);

    if (!settled) {
      log('paginator: click did not change URL — falling back');
      return false;
    }
    return true;
  } catch (err) {
    log(`paginator: click failed (${err.message})`);
    return false;
  }
}

module.exports = { scrollToPagination, getNextPageUrl, clickNextPage };
