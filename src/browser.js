'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fetch = require('node-fetch');
const proxy = require('./proxy');

// Kill any Chrome process that's currently bound to the given debug port,
// regardless of whether THIS app started it. Used when the user adds a
// proxy config but Chrome is already running without --proxy-server (e.g.
// a previous job's Chrome that survived a nodemon restart).
function killByPort(port) {
  let killed = 0;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr ":${port} "`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      const pids = [...new Set([...out.matchAll(/\s(\d+)\s*$/gm)].map((m) => parseInt(m[1], 10)))].filter(Boolean);
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); killed++; } catch {}
      }
    } else {
      const out = execSync(`lsof -i tcp:${port} -t 2>/dev/null`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      const pids = out.split('\n').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
      for (const pid of pids) { try { process.kill(pid); killed++; } catch {} }
    }
  } catch {}
  return killed;
}

let chromeProcess = null;
let lastEndpoint = null;
let lastPort = null;
let lastProxyUrl = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getCdpFromPort(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.webSocketDebuggerUrl) throw new Error('webSocketDebuggerUrl missing');
  return json.webSocketDebuggerUrl;
}

async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { return await getCdpFromPort(port); }
    catch (e) { lastErr = e; await sleep(400); }
  }
  throw new Error(`Chrome did not respond on port ${port}: ${lastErr?.message || 'timeout'}`);
}

async function launch({ chromePath, userDataDir, debugPort, proxyUrl = '' }) {
  // Only relaunch Chrome when the proxy is being TOGGLED on/off — changing
  // the URL between two non-empty values is handled in-place by the proxy
  // chain (same local port, swapped upstream). This means the user can
  // change provider mid-run without Chrome ever restarting.
  const wasOnProxy = !!lastProxyUrl;
  const wantsProxy = !!proxyUrl;
  const proxyToggled = wasOnProxy !== wantsProxy;
  if (chromeProcess && !chromeProcess.killed && proxyToggled) {
    try { chromeProcess.kill(); } catch {}
    chromeProcess = null;
    lastEndpoint = null;
    lastPort = null;
    if (!wantsProxy) await proxy.stop();
  }

  if (chromeProcess && !chromeProcess.killed) {
    return { endpoint: lastEndpoint, port: lastPort, pid: chromeProcess.pid, alreadyRunning: true, proxy: lastProxyUrl || null };
  }
  if (!chromePath) throw new Error('Chrome executable path not set in settings');
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);
  if (!debugPort) throw new Error('Debug port not set');

  // EXTERNAL-CHROME-MISMATCH RECOVERY
  // If we don't own the running Chrome (nodemon restart, manually launched,
  // etc.) AND the proxy state we want doesn't match what it was launched
  // with, the only fix is to kill it at the OS level and respawn. Cases:
  //   - want proxy, existing Chrome has no --proxy-server  → kill & respawn
  //   - want no proxy, existing Chrome has stale dead --proxy-server → kill
  //   - same proxy state as last launch → fine, fall through to reuse below
  const stateChanged = (!!proxyUrl) !== (!!lastProxyUrl);
  if (!chromeProcess && stateChanged) {
    try {
      await getCdpFromPort(debugPort);
      const killed = killByPort(debugPort);
      if (killed > 0) {
        for (let i = 0; i < 25; i++) {
          await sleep(300);
          let stillBound = true;
          try { await getCdpFromPort(debugPort); } catch { stillBound = false; }
          if (!stillBound) break;
        }
      }
    } catch { /* nothing on the port — fine */ }
  }

  // Boot the local proxy-chain if an upstream URL is configured. Chrome
  // ignores inline credentials in --proxy-server; the chain handles auth
  // and exposes a cred-free local endpoint.
  let localProxy = null;
  if (proxyUrl) {
    try {
      localProxy = await proxy.start({ url: proxyUrl });
    } catch (err) {
      throw new Error(`proxy-chain failed: ${err.message}`);
    }
  } else {
    await proxy.stop();
  }

  // If something is already listening on the debug port, reuse it (but only
  // when no proxy is required — otherwise the existing Chrome might not be
  // routed through the proxy).
  if (!proxyUrl) {
    try {
      const endpoint = await getCdpFromPort(debugPort);
      lastEndpoint = endpoint; lastPort = debugPort; lastProxyUrl = '';
      return { endpoint, port: debugPort, pid: null, alreadyRunning: true, proxy: null };
    } catch {}
  }

  if (userDataDir) fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (localProxy) args.push(`--proxy-server=${localProxy}`);

  chromeProcess = spawn(chromePath, args, { detached: false, stdio: 'ignore', windowsHide: false });
  chromeProcess.on('exit', () => {
    chromeProcess = null; lastEndpoint = null; lastPort = null; lastProxyUrl = null;
    // proxy chain is left up — kept warm so Test still works without re-init.
  });
  chromeProcess.on('error', () => { chromeProcess = null; });

  const endpoint = await waitForCdp(debugPort).catch(async (err) => {
    try { chromeProcess?.kill(); } catch {}
    chromeProcess = null;
    throw err;
  });
  lastEndpoint = endpoint;
  lastPort = debugPort;
  lastProxyUrl = proxyUrl || '';
  return { endpoint, port: debugPort, pid: chromeProcess?.pid || null, alreadyRunning: false, proxy: localProxy };
}

async function connect({ debugPort }) {
  if (!debugPort) throw new Error('Debug port not set');
  const endpoint = await waitForCdp(debugPort, 5000);
  lastEndpoint = endpoint;
  lastPort = debugPort;
  return { endpoint, port: debugPort };
}

async function stop() {
  const wasOurs = !!chromeProcess;
  if (chromeProcess && !chromeProcess.killed) {
    try { chromeProcess.kill(); } catch {}
  }
  chromeProcess = null;
  lastEndpoint = null;
  lastPort = null;
  lastProxyUrl = null;
  await proxy.stop();
  return { stopped: true, wasOurs };
}

async function status({ debugPort } = {}) {
  const port = debugPort || lastPort;
  if (!port) return { connected: false, endpoint: null, launchedByApp: false, port: null };
  try {
    const endpoint = await getCdpFromPort(port);
    return { connected: true, endpoint, launchedByApp: !!chromeProcess, port };
  } catch {
    return { connected: false, endpoint: null, launchedByApp: !!chromeProcess, port };
  }
}

function getCachedEndpoint() { return lastEndpoint; }

process.on('exit', () => { try { chromeProcess?.kill(); } catch {} });
process.on('SIGINT', () => { try { chromeProcess?.kill(); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { try { chromeProcess?.kill(); } catch {}; process.exit(0); });

module.exports = { launch, connect, stop, status, getCachedEndpoint };
