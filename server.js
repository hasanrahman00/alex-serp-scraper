'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { parse: parseCsv } = require('csv-parse/sync');
const xlsx = require('xlsx');

const jobs = require('./src/jobManager');
const settings = require('./src/settings');
const browser = require('./src/browser');
const proxy = require('./src/proxy');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------ health ------------ */
app.get('/api/health', async (_req, res) => {
  const s = settings.load();
  let cdpStatus;
  try { cdpStatus = await browser.status({ debugPort: s.debugPort }); }
  catch { cdpStatus = { connected: false }; }
  const captchaConfigured = s.captchaProvider !== 'manual' && !!s.captchaApiKey;
  res.json({
    ok: true,
    deepseek: !!process.env.DEEPSEEK_API_KEY,
    captcha: captchaConfigured,
    captchaProvider: s.captchaProvider,
    cdp: cdpStatus.connected,
    cdpEndpoint: cdpStatus.endpoint || null,
  });
});

/* ------------ settings ------------ */
app.get('/api/settings', (_req, res) => {
  res.json(settings.load());
});
app.post('/api/settings', (req, res) => {
  try { res.json(settings.save(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ------------ browser ------------ */
app.get('/api/browser/status', async (_req, res) => {
  const s = settings.load();
  res.json(await browser.status({ debugPort: s.debugPort }));
});
app.post('/api/browser/launch', async (req, res) => {
  try {
    const s = { ...settings.load(), ...(req.body || {}) };
    settings.save(s);
    const out = await browser.launch({ chromePath: s.chromePath, userDataDir: s.userDataDir, debugPort: s.debugPort });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/browser/connect', async (_req, res) => {
  try {
    const s = settings.load();
    res.json(await browser.connect({ debugPort: s.debugPort }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/browser/stop', async (_req, res) => {
  try { res.json(await browser.stop()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ------------ proxy ------------ */
app.get('/api/proxy/status', (_req, res) => {
  const s = settings.load();
  res.json({
    configured: !!s.proxyUrl,
    upstream: s.proxyUrl || null,
    localChain: proxy.getLocalUrl(),
    chainActive: !!proxy.getLocalUrl(),
  });
});

// Saves the supplied (or current) proxy URL, then runs a real request
// through the chain to api.ipify.org and returns the egress IP.
app.post('/api/proxy/test', async (req, res) => {
  const s = settings.load();
  const url = (req.body && req.body.proxyUrl) || s.proxyUrl || '';
  if (!url) return res.status(400).json({ error: 'proxyUrl is empty' });
  try {
    const out = await proxy.testProxy({ url });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------ jobs ------------ */
app.get('/api/jobs', (_req, res) => res.json(jobs.list()));

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

app.post('/api/jobs', (req, res) => {
  const cfg = req.body || {};
  if (!Array.isArray(cfg.queries) || cfg.queries.length === 0) {
    return res.status(400).json({ error: 'queries[] required' });
  }
  const job = jobs.create(cfg);
  res.status(201).json(job);
});

app.post('/api/jobs/:id/start', async (req, res) => {
  try { res.json(await jobs.start(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/jobs/:id/pause', (req, res) => {
  try { res.json(jobs.pause(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/jobs/:id/resume', (req, res) => {
  try { res.json(jobs.resume(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  try { res.json(jobs.cancel(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/jobs/:id', (req, res) => {
  jobs.remove(req.params.id);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/live.csv', (req, res) => {
  const filePath = path.join(__dirname, 'data', 'results', `${req.params.id}.csv`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'no live CSV yet — job has not produced any rows' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="job-${req.params.id}-live.csv"`);
  fs.createReadStream(filePath).pipe(res);
});

app.get('/api/jobs/:id/export.csv', (req, res) => {
  try {
    const onlyReal = req.query.onlyReal !== 'false';
    const csv = jobs.exportCsv(req.params.id, { onlyReal });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="job-${req.params.id}.csv"`);
    res.send(csv);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/jobs/:id/export.json', (req, res) => {
  try {
    const data = jobs.exportJson(req.params.id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="job-${req.params.id}.json"`);
    res.send(data);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

/* ------------ upload (csv / xlsx / xls / json) ------------ */
function pickQueryColumn(keys) {
  const norm = (s) => String(s || '').toLowerCase().trim();
  return keys.find((k) => norm(k) === 'query') || keys[0];
}

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
  const baseName = req.file.originalname.replace(/\.[^.]+$/, '');
  let queries = [];
  let columnUsed = null;

  try {
    if (ext === 'xlsx' || ext === 'xls') {
      const wb = xlsx.readFile(req.file.path);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length) {
        columnUsed = pickQueryColumn(Object.keys(rows[0]));
        queries = rows.map((r) => r[columnUsed]).filter(Boolean);
      }
    } else if (ext === 'json') {
      const buf = fs.readFileSync(req.file.path, 'utf8');
      const data = JSON.parse(buf);
      if (Array.isArray(data)) {
        if (data.every((x) => typeof x === 'string')) {
          queries = data;
        } else if (data.length) {
          columnUsed = pickQueryColumn(Object.keys(data[0]));
          queries = data.map((r) => r[columnUsed]).filter(Boolean);
        }
      } else if (Array.isArray(data.queries)) {
        queries = data.queries;
      }
    } else {
      const buf = fs.readFileSync(req.file.path, 'utf8');
      const records = parseCsv(buf, { columns: true, skip_empty_lines: true, trim: true });
      if (records.length) {
        columnUsed = pickQueryColumn(Object.keys(records[0]));
        queries = records.map((r) => r[columnUsed]).filter(Boolean);
      }
      if (queries.length === 0) {
        const flat = parseCsv(buf, { skip_empty_lines: true, trim: true });
        queries = flat.flat().filter(Boolean);
      }
    }
  } catch (err) {
    return res.status(400).json({ error: `parse failed: ${err.message}` });
  } finally {
    fs.unlink(req.file.path, () => {});
  }

  queries = [...new Set(queries.map((s) => String(s).trim()).filter(Boolean))];
  if (!queries.length) {
    return res.status(400).json({ error: 'No queries found. Make sure your file has a "Query" column.' });
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const suggestedName = `${baseName} — ${stamp}`;
  res.json({ queries, count: queries.length, suggestedName, columnUsed });
});

/* ------------ websocket ------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', jobs: jobs.list() }));
  const onLog = (p) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'log', ...p }));
  const onProgress = (p) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'progress', ...p }));
  const onJob = (p) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'job', job: p }));
  const onRemoved = (p) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'removed', ...p }));
  const onLive = (p) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'liveEmails', ...p }));
  jobs.on('log', onLog);
  jobs.on('progress', onProgress);
  jobs.on('job', onJob);
  jobs.on('removed', onRemoved);
  jobs.on('liveEmails', onLive);
  ws.on('close', () => {
    jobs.off('log', onLog);
    jobs.off('progress', onProgress);
    jobs.off('job', onJob);
    jobs.off('removed', onRemoved);
    jobs.off('liveEmails', onLive);
  });
});

server.listen(PORT, () => {
  const s = settings.load();
  console.log('');
  console.log(`  SERP Email Harvester  →  http://localhost:${PORT}`);
  console.log('  ' + '─'.repeat(60));
  console.log(`  DeepSeek : ${process.env.DEEPSEEK_API_KEY ? 'configured' : 'NOT configured (set DEEPSEEK_API_KEY in .env)'}`);
  console.log(`  2captcha : ${process.env.TWOCAPTCHA_API_KEY ? 'configured' : 'NOT configured (optional)'}`);
  console.log(`  Chrome   : ${s.chromePath || 'NOT FOUND — open Settings in the UI to set the path'}`);
  console.log(`  Profile  : ${s.userDataDir}`);
  console.log(`  CDP port : ${s.debugPort}`);
  console.log('');
});
