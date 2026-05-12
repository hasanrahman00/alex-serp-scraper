'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  jobs: new Map(),
  ws: null,
  logsModalJobId: null,
};

/* -------- helpers -------- */
function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${type ? ' ' + type : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  // "May 08, 04:02 AM" — matches the screenshot
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true,
  }).replace(',', ',');
}
function setDot(parentSel, on) {
  const el = $(parentSel)?.querySelector('.dot');
  if (!el) return;
  el.classList.remove('on', 'off');
  el.classList.add(on ? 'on' : 'off');
}

/* -------- per-job derived stats --------
   green  = real (DeepSeek-verified)
   yellow = unverified (DeepSeek not run / null)
   red    = not real (DeepSeek-rejected)
   purple = total live unique extracted (raw, before validation)
   orange = failed queries (nav errors, no results)
*/
function computeStats(j) {
  const totalQueries = (j.config?.queries || []).length;
  const validated = j.validated || [];
  const real = validated.filter((v) => v.real === true).length;
  const notReal = validated.filter((v) => v.real === false).length;
  const unverified = validated.filter((v) => v.real === null || v.real === undefined).length;
  const liveUnique = j.liveEmailCount || 0;
  // Failed queries: results entries with no emails (run completed) OR with explicit error
  const failed = (j.results || []).filter((r) => r.error || (Array.isArray(r.emails) && r.emails.length === 0)).length;
  return { totalQueries, real, notReal, unverified, liveUnique, failed };
}

/* -------- job row rendering -------- */
function renderJobRow(j) {
  const stats = computeStats(j);
  const { stepsDone = 0, totalSteps = 0 } = j.progress || {};
  const pct = totalSteps ? Math.min(100, Math.round((stepsDone / totalSteps) * 100)) : 0;

  const row = document.createElement('div');
  row.className = 'job-row';
  row.dataset.id = j.id;

  // Per-stat zero highlighting (renders muted when 0)
  const cls = (n, base) => `stat ${n > 0 ? base : 'zero'}`;

  row.innerHTML = `
    <div class="job-name">
      <div class="name" title="${escape(j.name)}">${escape(j.name)}</div>
      <div class="date">${fmtShort(j.createdAt)}</div>
    </div>

    <span class="status-pill ${j.status}">${j.status}</span>

    <div class="total-count" title="Total queries in the file">${stats.totalQueries.toLocaleString()}</div>

    <div class="progress-cell">
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-text">${stepsDone.toLocaleString()}/${totalSteps.toLocaleString()} (${pct}%)</div>
    </div>

    <div class="stats">
      <span class="${cls(stats.liveUnique, 'green')}" title="Unique emails extracted (live)">${stats.liveUnique.toLocaleString()}</span>
      <span class="${cls(stats.real, 'yellow')}" title="DeepSeek-verified real">${stats.real.toLocaleString()}</span>
      <span class="${cls(stats.notReal, 'red')}" title="DeepSeek-rejected">${stats.notReal.toLocaleString()}</span>
      <span class="${cls(stats.unverified, 'purple')}" title="Unverified (DeepSeek not run / no answer)">${stats.unverified.toLocaleString()}</span>
      <span class="${cls(stats.failed, 'orange')}" title="Failed queries (nav errors / no results)">${stats.failed.toLocaleString()}</span>
    </div>

    <div class="row-actions" data-id="${j.id}"></div>
  `;

  // Actions cell (built imperatively to wire handlers)
  const actions = row.querySelector('.row-actions');
  const mkBtn = (label, cls, onClick, title) => {
    const b = document.createElement('button');
    b.className = `btn small ${cls}`;
    b.innerHTML = label;
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };

  if (j.status === 'running') {
    if (j.paused) {
      actions.appendChild(mkBtn('Resume', 'primary', () => doAction(j.id, 'resume')));
    } else {
      actions.appendChild(mkBtn('Pause', 'ghost', () => doAction(j.id, 'pause')));
    }
    actions.appendChild(mkBtn('Cancel', 'warn', () => doAction(j.id, 'cancel')));
  } else if (['queued', 'cancelled', 'failed', 'completed'].includes(j.status)) {
    actions.appendChild(mkBtn(j.status === 'queued' ? 'Start' : 'Re-run', 'ghost', () => doStart(j.id)));
  }

  // Download = Live CSV (most useful)
  actions.appendChild(mkBtn('Download', 'success', () => downloadLive(j.id), 'Download Live CSV (raw extracted)'));

  // "Issues" with badge = Validated CSV (real-count badge)
  if (stats.real > 0) {
    actions.appendChild(mkBtn(`Validated <span class="badge">${stats.real}</span>`, 'warn', () => downloadValidated(j.id), 'Download validated CSV (real emails only)'));
  }

  actions.appendChild(mkBtn('Logs', 'ghost', () => openLogsModal(j.id)));
  actions.appendChild(mkBtn('Delete', 'danger', () => doDelete(j.id)));

  return row;
}

function renderJobsList() {
  const list = $('#jobsList');
  const jobs = [...state.jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $('#jobsCount').textContent = jobs.length ? `${jobs.length} total` : '—';
  if (!jobs.length) {
    list.innerHTML = '<div class="empty">No jobs yet — upload a file above to start.</div>';
    return;
  }
  list.innerHTML = '';
  for (const j of jobs) list.appendChild(renderJobRow(j));
}

function rerenderRow(jobId) {
  const j = state.jobs.get(jobId);
  if (!j) return;
  const list = $('#jobsList');
  const old = list.querySelector(`.job-row[data-id="${jobId}"]`);
  const next = renderJobRow(j);
  if (old) old.replaceWith(next); else renderJobsList();
}

/* -------- job actions -------- */
async function doStart(id) { try { await api(`/api/jobs/${id}/start`, { method: 'POST' }); toast('Started', 'success'); } catch (e) { toast(e.message, 'error'); } }
async function doAction(id, action) { try { await api(`/api/jobs/${id}/${action}`, { method: 'POST' }); toast(action); } catch (e) { toast(e.message, 'error'); } }
async function doDelete(id) {
  if (!confirm('Delete this job?')) return;
  try {
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
    state.jobs.delete(id);
    renderJobsList();
    toast('Deleted');
  } catch (e) { toast(e.message, 'error'); }
}
function downloadLive(id) { window.open(`/api/jobs/${id}/live.csv`, '_blank'); }
function downloadValidated(id) { window.open(`/api/jobs/${id}/export.csv?onlyReal=true`, '_blank'); }

/* -------- logs modal -------- */
function openLogsModal(jobId) {
  state.logsModalJobId = jobId;
  const j = state.jobs.get(jobId);
  $('#logsModalJob').textContent = j ? j.name : jobId;
  renderLogsModal();
  $('#logsModal').classList.remove('hidden');
}
function closeLogsModal() {
  state.logsModalJobId = null;
  $('#logsModal').classList.add('hidden');
}
function renderLogsModal() {
  const id = state.logsModalJobId;
  if (!id) return;
  const j = state.jobs.get(id);
  const el = $('#logsModalContent');
  if (!j) { el.textContent = ''; return; }
  const lines = (j.logs || []).slice(-1000).map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`);
  el.textContent = lines.join('\n');
  el.scrollTop = el.scrollHeight;
}

async function refreshJobs() {
  try {
    const list = await api('/api/jobs');
    state.jobs.clear();
    for (const j of list) state.jobs.set(j.id, j);
    renderJobsList();
  } catch (e) { toast(e.message, 'error'); }
}

/* -------- upload flow -------- */
async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

async function handleFile(file) {
  if (!file) return;
  let parsed;
  try { parsed = await uploadFile(file); }
  catch (err) { toast(err.message, 'error'); return; }

  toast(`Loaded ${parsed.count} queries — starting job…`, 'success');
  const name = parsed.suggestedName || file.name;
  try {
    const j = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ name, queries: parsed.queries }),
    });
    state.jobs.set(j.id, j);
    await api(`/api/jobs/${j.id}/start`, { method: 'POST' });
    renderJobsList();
    $('#fileInput').value = '';
  } catch (e) { toast(e.message, 'error'); }
}

/* -------- settings modal -------- */
let settingsPollTimer = null;
async function openSettings() {
  try {
    const s = await api('/api/settings');
    $('#set-chromePath').value = s.chromePath || '';
    $('#set-userDataDir').value = s.userDataDir || '';
    $('#set-debugPort').value = s.debugPort || 9222;
    $('#set-proxyUrl').value = s.proxyUrl || '';
    $('#set-proxyStickySession').checked = !!s.proxyStickySession;
    $('#set-pageDelayMin').value = s.pageDelayMin || 1500;
    $('#set-pageDelayMax').value = s.pageDelayMax || 4000;
    $('#set-querySuffix').value = s.querySuffix == null ? 'email' : s.querySuffix;
    $('#set-captchaProvider').value = s.captchaProvider || 'manual';
    $('#set-captchaApiKey').value = s.captchaApiKey || '';
    updateCaptchaKeyVisibility();
    await refreshBrowserStatus();
    await refreshProxyStatus();
    $('#settingsModal').classList.remove('hidden');
    clearInterval(settingsPollTimer);
    settingsPollTimer = setInterval(() => { refreshBrowserStatus(); refreshProxyStatus(); }, 3000);
  } catch (e) { toast(e.message, 'error'); }
}
function closeSettings() {
  $('#settingsModal').classList.add('hidden');
  clearInterval(settingsPollTimer);
  settingsPollTimer = null;
}

async function refreshBrowserStatus() {
  try {
    const s = await api('/api/browser/status');
    const dot = $('#modalCdpDot');
    dot.classList.remove('on', 'off');
    dot.classList.add(s.connected ? 'on' : 'off');
    $('#modalCdpText').textContent = s.connected
      ? `Connected · port ${s.port}${s.launchedByApp ? ' (launched by app)' : ''}`
      : 'Disconnected';
    setDot('#status-cdp', s.connected);
  } catch {}
}

async function refreshProxyStatus() {
  try {
    const s = await api('/api/proxy/status');
    const dot = $('#modalProxyDot');
    dot.classList.remove('on', 'off');
    if (s.configured) {
      dot.classList.add(s.chainActive ? 'on' : 'off');
      $('#modalProxyText').textContent = s.chainActive
        ? `Active · routing through ${shortHost(s.upstream)}`
        : `Configured but not started — runs on first job`;
    } else {
      $('#modalProxyText').textContent = 'No proxy configured (using your own IP)';
    }
  } catch {}
}
function shortHost(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; }
  catch { return url; }
}

async function testProxy() {
  const url = $('#set-proxyUrl').value.trim();
  if (!url) { toast('Paste a proxy URL first', 'error'); return; }
  $('#modalProxyText').textContent = 'Testing — fetching api.ipify.org through the chain…';
  $('#testProxyBtn').disabled = true;
  try {
    const r = await api('/api/proxy/test', { method: 'POST', body: JSON.stringify({ proxyUrl: url }) });
    $('#modalProxyDot').classList.remove('off');
    $('#modalProxyDot').classList.add('on');
    $('#modalProxyText').textContent = `OK · egress IP ${r.ip} (via ${shortHost(url)})`;
    toast(`Proxy working — egress ${r.ip}`, 'success');
  } catch (e) {
    $('#modalProxyDot').classList.remove('on');
    $('#modalProxyDot').classList.add('off');
    $('#modalProxyText').textContent = `Test failed: ${e.message}`;
    toast(e.message, 'error');
  } finally {
    $('#testProxyBtn').disabled = false;
  }
}

function readSettingsForm() {
  return {
    chromePath: $('#set-chromePath').value.trim(),
    userDataDir: $('#set-userDataDir').value.trim(),
    debugPort: parseInt($('#set-debugPort').value, 10) || 9222,
    proxyUrl: $('#set-proxyUrl').value.trim(),
    proxyStickySession: $('#set-proxyStickySession').checked,
    pageDelayMin: parseInt($('#set-pageDelayMin').value, 10) || 0,
    pageDelayMax: parseInt($('#set-pageDelayMax').value, 10) || 0,
    querySuffix: $('#set-querySuffix').value.trim(),
    captchaProvider: $('#set-captchaProvider').value,
    captchaApiKey: $('#set-captchaApiKey').value.trim(),
  };
}

function updateCaptchaKeyVisibility() {
  const isManual = $('#set-captchaProvider').value === 'manual';
  $('#captchaKeyField').style.display = isManual ? 'none' : '';
}

async function saveSettings() {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(readSettingsForm()) });
    toast('Saved', 'success');
    closeSettings();
  } catch (e) { toast(e.message, 'error'); }
}

async function stopBrowser() {
  try {
    await api('/api/browser/stop', { method: 'POST' });
    toast('Stopped');
    refreshBrowserStatus();
  } catch (e) { toast(e.message, 'error'); }
}

/* -------- health -------- */
async function loadHealth() {
  try {
    const h = await api('/api/health');
    setDot('#status-deepseek', h.deepseek);
    setDot('#status-captcha', h.captcha);
    setDot('#status-cdp', h.cdp);
  } catch {}
}

/* -------- websocket -------- */
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello') {
      state.jobs.clear();
      for (const j of m.jobs) state.jobs.set(j.id, j);
      renderJobsList();
    } else if (m.type === 'job') {
      state.jobs.set(m.job.id, m.job);
      rerenderRow(m.job.id);
    } else if (m.type === 'progress') {
      const j = state.jobs.get(m.jobId);
      if (j) { j.progress = m.progress; rerenderRow(m.jobId); }
    } else if (m.type === 'log') {
      const j = state.jobs.get(m.jobId);
      if (j) {
        j.logs = j.logs || [];
        j.logs.push(m.line);
        if (j.logs.length > 2000) j.logs.splice(0, j.logs.length - 2000);
        if (state.logsModalJobId === m.jobId) renderLogsModal();
      }
    } else if (m.type === 'liveEmails') {
      const j = state.jobs.get(m.jobId);
      if (j) { j.liveEmailCount = m.total; rerenderRow(m.jobId); }
    } else if (m.type === 'removed') {
      state.jobs.delete(m.jobId);
      renderJobsList();
    }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

/* -------- bind -------- */
function bindUI() {
  // Dropzone + file input
  const dz = $('#dropzone');
  $('#fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', (e) => { handleFile(e.dataTransfer.files[0]); });

  // Settings modal
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#cancelSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#stopBrowserBtn').addEventListener('click', stopBrowser);
  $('#testProxyBtn').addEventListener('click', testProxy);
  $('#set-captchaProvider').addEventListener('change', updateCaptchaKeyVisibility);

  // Logs modal
  $('#closeLogsModal').addEventListener('click', closeLogsModal);
  $('#logsModal').addEventListener('click', (e) => { if (e.target.id === 'logsModal') closeLogsModal(); });
}

bindUI();
loadHealth();
connectWs();
refreshJobs();
setInterval(loadHealth, 15000);
