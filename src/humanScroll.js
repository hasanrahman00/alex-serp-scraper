'use strict';

// Human-paced scroller. Steps are small + randomised, pauses are 0.6–1.6 s with
// occasional long "reading" pauses, scroll behavior is `auto` (no animation
// queue) so the JS stays in sync with the actual scrollTop.
//
// Used both for SERP pagination ("stop when pagination link is visible") and
// for result-page extraction ("scroll all the way down so lazy-loaded contact
// sections render before we read the HTML").

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.random() * (max - min); }

/**
 * @param {import('playwright').Page} page
 * @param {Object} [opts]
 * @param {(page) => Promise<boolean>} [opts.until]   - stop early when truthy
 * @param {[number, number]} [opts.stepPx]            - px range per scroll
 * @param {[number, number]} [opts.delayMs]           - ms range between scrolls
 * @param {number} [opts.maxTicks]                    - safety cap on iterations
 * @param {number} [opts.stableTicks]                 - bottom detected after N unchanged heights
 * @param {number} [opts.longPauseChance]             - 0..1, chance of a 2× pause
 * @param {(msg: string) => void} [opts.log]
 * @param {() => boolean} [opts.isCancelled]
 * @returns {Promise<{ reachedBottom: boolean, hitTarget: boolean, ticks: number }>}
 */
async function humanScroll(page, opts = {}) {
  const {
    until,
    stepPx = [350, 650],
    delayMs = [700, 1400],
    maxTicks = 25,
    stableTicks = 3,
    longPauseChance = 0.08,
    log = () => {},
    isCancelled = () => false,
  } = opts;

  let lastHeight = 0;
  let stable = 0;
  let ticks = 0;

  for (let i = 0; i < maxTicks; i++) {
    if (isCancelled()) return { reachedBottom: false, hitTarget: false, ticks: i };

    if (until) {
      let hit = false;
      try { hit = !!(await until(page)); } catch {}
      if (hit) return { reachedBottom: false, hitTarget: true, ticks: i };
    }

    const step = Math.floor(rand(stepPx[0], stepPx[1]));
    const newHeight = await page.evaluate((s) => {
      window.scrollBy({ top: s, left: 0, behavior: 'auto' });
      return document.documentElement.scrollHeight;
    }, step).catch(() => 0);

    if (newHeight && newHeight === lastHeight) {
      stable++;
      if (stable >= stableTicks) {
        log(`scroll: bottom reached after ${i + 1} tick(s) (height ${lastHeight})`);
        ticks = i + 1;
        break;
      }
    } else {
      stable = 0;
      lastHeight = newHeight;
    }

    // Mostly normal pace; sometimes pause longer like a human reading.
    let waitMs = rand(delayMs[0], delayMs[1]);
    if (Math.random() < longPauseChance) waitMs *= 2;
    await sleep(waitMs);
    ticks = i + 1;
  }

  // Belt-and-braces: jump to absolute bottom in case incremental scrolling
  // didn't hit the very last pixel.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
  return { reachedBottom: true, hitTarget: false, ticks };
}

module.exports = { humanScroll };
