'use strict';

// Proxy plumbing with per-query sticky-session rotation.
//
// Architecture:
//   * One long-lived ProxyChain.Server listens on a stable local port.
//   * Chrome's --proxy-server flag points at that port — and never has to
//     change for the life of the run.
//   * The server's prepareRequestFunction returns the CURRENT upstream URL
//     fresh on every request, so the scraper can swap upstreams between
//     queries without disturbing Chrome.
//
// Webshare sticky-session convention (also used by NodeMaven / similar):
//   USER-COUNTRY-rotate           → new IP every request
//   USER-COUNTRY-session-TOKEN    → same IP for ~10 min
// We auto-rewrite "-rotate" → "-session-${token}" each query, giving one
// IP per query's full pagination instead of per request. ~5× lower
// captcha rate against Google in practice.

const ProxyChain = require('proxy-chain');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

let server = null;
let serverPort = null;
let baseUrl = null;       // configured URL from settings (with -rotate or whatever)
let upstreamUrl = null;   // current effective URL (with session token swapped in)
let lastSessionToken = null;

function parseUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      server: `${u.protocol}//${u.hostname}:${port}`,
    };
  } catch {
    return null;
  }
}

function rebuildUrl(p, username) {
  return `${p.protocol}://${encodeURIComponent(username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`;
}

// Swap the username's "-rotate" or "-session-XXX" suffix with "-session-${token}".
// Returns the original URL unchanged if neither pattern is present (caller's
// proxy doesn't follow the Webshare convention — we don't speculate).
function withSession(url, token) {
  const p = parseUrl(url);
  if (!p) return url;
  if (/-rotate$/.test(p.username)) {
    return rebuildUrl(p, p.username.replace(/-rotate$/, `-session-${token}`));
  }
  if (/-session-[^-]+$/.test(p.username)) {
    return rebuildUrl(p, p.username.replace(/-session-[^-]+$/, `-session-${token}`));
  }
  return url;
}

async function start({ url } = {}) {
  if (!url) {
    await stop();
    return null;
  }
  baseUrl = url;
  upstreamUrl = url;
  lastSessionToken = null;

  if (server) {
    // Server already listening — keep the same local port so Chrome doesn't
    // need to know anything changed. The closure below reads upstreamUrl
    // fresh on every request.
    return getLocalUrl();
  }

  server = new ProxyChain.Server({
    port: 0, // random free port
    prepareRequestFunction: () => ({
      upstreamProxyUrl: upstreamUrl,
    }),
  });
  await server.listen();
  serverPort = server.port;
  return getLocalUrl();
}

// Called by the scraper at the top of each query iteration. Generates a
// new sticky session token, rewrites the upstream URL with it, and the
// next request through the chain (Chrome's first goto for the query) will
// land on a fresh dedicated IP. Pass an empty token to restore baseUrl.
function setSessionToken(token) {
  if (!baseUrl) return null;
  if (!token) {
    upstreamUrl = baseUrl;
    lastSessionToken = null;
    return upstreamUrl;
  }
  upstreamUrl = withSession(baseUrl, token);
  lastSessionToken = token;
  return upstreamUrl;
}

function getLocalUrl()    { return server ? `http://127.0.0.1:${serverPort}` : null; }
function getUpstreamUrl() { return upstreamUrl; }
function getBaseUrl()     { return baseUrl; }
function getSessionToken(){ return lastSessionToken; }

async function stop() {
  if (server) {
    try { await server.close(true); } catch {}
    server = null;
    serverPort = null;
  }
  baseUrl = null;
  upstreamUrl = null;
  lastSessionToken = null;
}

async function testProxy({ url, timeoutMs = 12000 } = {}) {
  const target = url ? await start({ url }) : getLocalUrl();
  if (!target) throw new Error('No proxy URL configured');
  const agent = new HttpsProxyAgent(target);
  const res = await fetch('https://api.ipify.org?format=json', { agent, timeout: timeoutMs });
  if (!res.ok) throw new Error(`ipify HTTP ${res.status}`);
  const json = await res.json();
  return { ip: json.ip, via: target, upstream: upstreamUrl };
}

process.on('exit',    () => { try { stop(); } catch {} });
process.on('SIGINT',  () => { try { stop(); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { try { stop(); } catch {}; process.exit(0); });

module.exports = {
  start, stop,
  getLocalUrl, getUpstreamUrl, getBaseUrl, getSessionToken,
  parseUrl, withSession, setSessionToken, testProxy,
};
