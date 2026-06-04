'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { EventEmitter } = require('events');
const { parse: parseCsv } = require('csv-parse/sync');
const { runJob } = require('./scraper');
const { dedupeAndScore } = require('./emailExtractor');
const settings = require('./settings');
const browser = require('./browser');
const proxy = require('./proxy');
const { JobCsvAppender } = require('./csvAppender');

const JOBS_DIR = path.join(__dirname, '..', 'data', 'jobs');
const RESULTS_DIR = path.join(__dirname, '..', 'data', 'results');

for (const d of [JOBS_DIR, RESULTS_DIR]) fs.mkdirSync(d, { recursive: true });

class JobManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'));
          j._control = { paused: false, cancelled: true };
          if (j.status === 'running') j.status = 'cancelled';
          this.jobs.set(j.id, j);
        } catch {}
      }
    } catch {}
  }

  _persist(job) {
    const { _control, _runtime, ...persistable } = job;
    fs.writeFileSync(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(persistable, null, 2));
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((j) => this._publicView(j));
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this._publicView(j) : null;
  }

  _publicView(j) {
    const { _control, _runtime, ...rest } = j;
    return { ...rest, paused: !!_control?.paused, cancelRequested: !!_control?.cancelled };
  }

  create(config) {
    const id = uuid();
    const job = {
      id,
      name: config.name || `Job ${id.slice(0, 8)}`,
      config,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      progress: { stepsDone: 0, totalSteps: 0 },
      logs: [],
      results: [],
      validated: [],
      error: null,
      _control: { paused: false, cancelled: false },
    };
    this.jobs.set(id, job);
    this._persist(job);
    this.emit('job', this._publicView(job));
    return this._publicView(job);
  }

  _log(job, msg) {
    const line = { t: Date.now(), msg };
    job.logs.push(line);
    if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
    this.emit('log', { jobId: job.id, line });
  }

  async start(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job not found');
    if (job.status === 'running') return this._publicView(job);
    job.status = 'running';
    job.startedAt = Date.now();
    job._control.paused = false;
    job._control.cancelled = false;
    this._persist(job);
    this.emit('job', this._publicView(job));

    const onLog = (msg) => this._log(job, msg);
    const onProgress = (p) => {
      job.progress = p;
      this.emit('progress', { jobId: job.id, progress: p });
    };
    const isCancelled = () => job._control.cancelled;
    const isPaused = () => job._control.paused;

    // Open the per-job live CSV right at start so any crash mid-scrape still
    // leaves a usable file on disk. Header is written only the first time.
    const liveCsv = new JobCsvAppender(job.id, [
      'query', 'email', 'title', 'url', 'description', 'serp_page',
    ]);
    job.liveCsvPath = liveCsv.path;
    onLog(`[live-csv] streaming results to ${liveCsv.path}`);

    // Job-wide dedupe set. Pre-load any addresses already on disk from a
    // previous run so re-runs append ONLY new emails — never duplicates.
    const seenEmails = new Set();
    try {
      if (fs.existsSync(liveCsv.path) && fs.statSync(liveCsv.path).size > 0) {
        const records = parseCsv(fs.readFileSync(liveCsv.path, 'utf8'), {
          columns: true,
          skip_empty_lines: true,
          relax_quotes: true,
          relax_column_count: true,
        });
        for (const r of records) {
          const e = String(r.email || '').toLowerCase().trim();
          if (e && e.includes('@')) seenEmails.add(e);
        }
        if (seenEmails.size) onLog(`[live-csv] loaded ${seenEmails.size} known address(es) from previous run — duplicates will be skipped`);
      }
    } catch (err) {
      onLog(`[live-csv] couldn't preload dedupe set: ${err.message}`);
    }
    job.liveEmailCount = seenEmails.size;

    const onEmails = ({ query, sourceUrl, sourceTitle, serpPage, emails }) => {
      let added = 0;
      const justAdded = [];
      for (const e of emails) {
        const key = String(e.email || '').toLowerCase().trim();
        if (!key || !key.includes('@')) continue;
        if (seenEmails.has(key)) continue;
        seenEmails.add(key);
        liveCsv.append({
          query,
          email: e.email,
          title: e.title || '',
          url: e.url || '',
          description: (e.description || '').slice(0, 500), // truncate long snippets
          serp_page: serpPage != null ? `page ${serpPage}` : (sourceTitle || ''),
        });
        added++;
        if (justAdded.length < 10) justAdded.push(e.email);
      }
      if (added > 0) {
        job.liveEmailCount = seenEmails.size;
        this.emit('liveEmails', {
          jobId: job.id,
          added,
          total: job.liveEmailCount,
          sample: justAdded,
        });
      }
    };

    (async () => {
      try {
        // Merge live settings + auto-resolved CDP endpoint into job config.
        const s = settings.load();
        const runConfig = {
          pageDelayMin: s.pageDelayMin,
          pageDelayMax: s.pageDelayMax,
          querySuffix: s.querySuffix || '',
          proxyUrl: s.proxyUrl || '',
          proxyStickySession: !!s.proxyStickySession,
          maxSerpPages: parseInt(s.maxSerpPages, 10) || 10,
          ...job.config,
        };

        // ─── Proxy preflight ─────────────────────────────────────────────
        // If a proxy is configured, probe it once via api.ipify.org. If the
        // probe fails (out of bandwidth → 402, dead, wrong creds, etc.), drop
        // the proxy from this run and fall back to the local network
        // connection so the job can still proceed. This means a borked proxy
        // never silently breaks 478 queries — worst case it costs 5 s of
        // preflight time and you get a clear log line.
        if (runConfig.proxyUrl) {
          try {
            const probe = await proxy.testProxy({ url: runConfig.proxyUrl, timeoutMs: 5000 });
            onLog(`[proxy] preflight OK · egress IP ${probe.ip}`);
          } catch (err) {
            onLog(`[proxy] preflight FAILED: ${err.message}`);
            onLog(`[proxy] falling back to LOCAL NETWORK connection (no proxy) for this run`);
            runConfig.proxyUrl = '';
            try { await proxy.stop(); } catch {}
          }
        } else {
          onLog('[proxy] not configured — using LOCAL NETWORK connection');
        }

        // Auto-attach: reuse cached endpoint, otherwise probe the port; if Chrome
        // isn't there, launch it from the configured chromePath / userDataDir.
        if (!runConfig.cdpEndpoint && s.debugPort) {
          let endpoint = browser.getCachedEndpoint();
          if (!endpoint) {
            try {
              const conn = await browser.connect({ debugPort: s.debugPort });
              endpoint = conn.endpoint;
              onLog(`[browser] reusing existing Chrome on port ${s.debugPort}`);
            } catch {
              if (!s.chromePath) {
                onLog('[browser] Chrome not running and no executable path configured — falling back to bundled Chromium');
              } else {
                const effectiveProxy = runConfig.proxyUrl || '';
                onLog(`[browser] no Chrome on port ${s.debugPort} — launching ${s.chromePath}${effectiveProxy ? ' (with proxy)' : ' (direct connection)'}`);
                try {
                  const launched = await browser.launch({
                    chromePath: s.chromePath,
                    userDataDir: s.userDataDir,
                    debugPort: s.debugPort,
                    proxyUrl: effectiveProxy,
                  });
                  endpoint = launched.endpoint;
                  onLog(`[browser] launched · pid=${launched.pid || 'n/a'} · ${endpoint}${launched.proxy ? ` · proxy ${launched.proxy}` : ' · direct'}`);
                } catch (err) {
                  onLog(`[browser] launch failed: ${err.message} — falling back to bundled Chromium`);
                }
              }
            }
          } else {
            onLog(`[browser] reusing cached CDP endpoint`);
          }
          if (endpoint) runConfig.cdpEndpoint = endpoint;
        }

        const scraped = await runJob(runConfig, { onLog, onProgress, onEmails, isCancelled, isPaused });
        job.results = scraped;

        const allCandidates = [];
        for (const q of scraped) for (const e of q.emails) allCandidates.push({ ...e, query: q.query });
        const dedupedEmails = dedupeAndScore(allCandidates);
        onLog(`merged into ${dedupedEmails.length} unique email candidates across all queries`);

        // No DeepSeek validation — relying on the proxy + regex filters only.
        // Keep job.validated as an empty array for backward UI compatibility.
        job.validated = [];

        job.status = job._control.cancelled ? 'cancelled' : 'completed';
        job.finishedAt = Date.now();
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        job.finishedAt = Date.now();
        onLog(`FATAL: ${err.message}`);
      } finally {
        liveCsv.close();
        onLog(`[live-csv] flushed · ${liveCsv.count} row(s) appended`);
        this._persist(job);
        this.emit('job', this._publicView(job));
      }
    })();

    return this._publicView(job);
  }

  pause(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job not found');
    job._control.paused = true;
    this._log(job, 'pause requested');
    this.emit('job', this._publicView(job));
    return this._publicView(job);
  }

  resume(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job not found');
    job._control.paused = false;
    this._log(job, 'resume requested');
    this.emit('job', this._publicView(job));
    return this._publicView(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job not found');
    job._control.cancelled = true;
    job._control.paused = false;
    this._log(job, 'cancel requested');
    this.emit('job', this._publicView(job));
    return this._publicView(job);
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') job._control.cancelled = true;
    this.jobs.delete(id);
    try { fs.unlinkSync(path.join(JOBS_DIR, `${id}.json`)); } catch {}
    this.emit('removed', { jobId: id });
    return true;
  }

  exportCsv(id, { onlyReal = true } = {}) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job not found');
    const rows = [['email', 'real', 'confidence', 'reason', 'sources', 'contexts', 'query']];
    for (const v of job.validated || []) {
      if (onlyReal && !v.real) continue;
      rows.push([
        v.email,
        v.real === null ? '' : v.real ? 'true' : 'false',
        v.confidence == null ? '' : String(v.confidence),
        (v.reason || '').replace(/[\r\n]+/g, ' '),
        (v.sources || []).join(' | '),
        (v.contexts || []).join(' | '),
        v.query || '',
      ]);
    }
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  exportJson(id) {
    const j = this.get(id);
    if (!j) throw new Error('job not found');
    return JSON.stringify(j, null, 2);
  }
}

module.exports = new JobManager();
