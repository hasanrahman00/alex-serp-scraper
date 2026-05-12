# SERP Email Harvester

Full-stack Node.js / Playwright Google SERP scraper with CDP attach, 2Captcha auto-solve, multi-pattern email extraction, and DeepSeek AI filtering — wrapped in a vanilla HTML/CSS/JS SaaS-style UI with live progress, CSV/JSON upload, job controls, and exports.

## Stack

- **Backend** — Node 18+, Express, `ws` (WebSocket), Playwright (`chromium.connectOverCDP` or local launch), `csv-parse`, `multer`.
- **Captcha** — 2captcha (`userrecaptcha`, `hcaptcha`); manual fallback when no key is set.
- **AI filter** — DeepSeek Chat (OpenAI-compatible) with strict JSON output to mark each address `real / not real`.
- **Frontend** — pure HTML / CSS / vanilla JS, no framework, no build step.

## Quick start

```bash
cd serp-scraper
cp .env.example .env       # then fill in API keys
npm install
npm run install-browsers   # Playwright Chromium
npm start
```

Open `http://localhost:3000`.

## .env

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DEEPSEEK_API_KEY` | Required to mark emails real / fake |
| `DEEPSEEK_MODEL` | Default `deepseek-chat` |
| `TWOCAPTCHA_API_KEY` | Optional; enables auto reCAPTCHA / hCaptcha solve |
| `CDP_ENDPOINT` | Optional; attach to a running browser instead of launching |
| `HEADLESS` | `true` / `false` (default false so captchas can be solved by hand if needed) |
| `SLOW_MO`, `NAV_TIMEOUT_MS`, `PAGE_DELAY_MIN_MS`, `PAGE_DELAY_MAX_MS`, `USER_AGENT` | Tuning |

## CDP attach mode

Launch your own Chrome with remote debugging:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/serp-profile
```

Grab the `webSocketDebuggerUrl` from `http://127.0.0.1:9222/json/version` and set `CDP_ENDPOINT` (or paste it into the **Advanced → CDP endpoint** field in the UI). The scraper will reuse your existing browser profile, cookies, and any logged-in sessions.

## Job lifecycle

```
queued → running → (paused) → completed | cancelled | failed
```

Buttons in the UI map directly onto these endpoints:

| Action | Endpoint |
|---|---|
| Create | `POST /api/jobs` |
| Start | `POST /api/jobs/:id/start` |
| Pause | `POST /api/jobs/:id/pause` |
| Resume | `POST /api/jobs/:id/resume` |
| Cancel | `POST /api/jobs/:id/cancel` |
| Delete | `DELETE /api/jobs/:id` |
| CSV export | `GET /api/jobs/:id/export.csv?onlyReal=true` |
| JSON export | `GET /api/jobs/:id/export.json` |
| Upload queries | `POST /api/upload` (multipart, field `file`, optional `headerKey`) |
| Live updates | `ws://host/ws` |

`start` is non-blocking: the request returns immediately and the actual scrape runs in the background while every log line, progress tick, and status change is broadcast over the WebSocket.

## Pipeline

1. For each query, navigate `https://www.google.com/search?q=…&start=…`.
2. Detect captcha (`/sorry/`, `recaptcha/api2`, `hcaptcha`, Cloudflare). If `TWOCAPTCHA_API_KEY` is set, fetch a token and inject it; otherwise the run pauses so a human can solve it (only when `HEADLESS=false`).
3. Scrape SERP result URLs (filter out Google internal links).
4. Visit each result URL, run captcha detection again, capture HTML.
5. Email extraction:
   - `cheerio` walks `mailto:` links and visible body text;
   - regex over raw HTML;
   - de-obfuscate `[at]`, `(dot)`, `&#64;`, zero-width chars;
   - reject asset-looking strings (`logo@2x.png`), oversize locals, and obvious role/system aliases.
6. Dedupe across queries; send batches to DeepSeek with a strict JSON schema asking for `{ real, confidence, reason }` per address.
7. Persist the job (config + logs + validated emails) to `data/jobs/<id>.json` so it survives a restart.

## CSV / JSON upload format

The **Upload CSV / JSON** button in the form accepts:

- CSV with a header row — the column whose name matches **header key** (default `query`) is used. If no match, all cells are read flat.
- JSON array of strings: `["plumbers berlin", "dentists munich"]`
- JSON array of objects: `[{ "query": "plumbers berlin" }, …]` — the **header key** picks the field.
- JSON object with `queries`: `{ "queries": [...] }`.

Parsed queries are appended to the textarea, deduped, and ready to launch.

## Project layout

```
serp-scraper/
├── server.js            Express + WebSocket
├── package.json
├── .env.example
├── public/
│   ├── index.html       UI shell
│   ├── style.css        dark gradient theme
│   └── app.js           state, WebSocket, render
├── src/
│   ├── scraper.js       Playwright SERP + page visits
│   ├── captcha.js       detection + 2captcha submit/poll
│   ├── emailExtractor.js  cheerio + regex + de-obfuscation
│   ├── deepseek.js      AI validation
│   └── jobManager.js    job state, control flags, persistence
└── data/
    ├── jobs/            persisted job JSON
    ├── results/
    └── uploads/         multer scratch
```

## Notes & limits

- Google aggressively rate-limits scraping. Use a residential / mobile-tier IP, keep concurrency low (`MAX_CONCURRENCY=1` is safest), and prefer **CDP attach** to a real browser profile that already has a normal cookie history. Don't run this against Google from a datacenter IP without expecting captchas.
- The DeepSeek classifier is conservative — it flips role aliases like `noreply@`, asset filenames, and randomized hashes to `real: false`. Tune `SYSTEM_PROMPT` in `src/deepseek.js` for a different bar.
- Use this responsibly. Respect each site's `robots.txt`, terms of service, and applicable anti-spam / data-protection laws. This tool is intended for things like contacting opted-in leads, public business directory enrichment, OSINT research, and personal projects — not for sending unsolicited bulk mail.
