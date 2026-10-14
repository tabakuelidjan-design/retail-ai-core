#!/usr/bin/env node
// TEMPORARY, ISOLATED phone capability probe server. It is NOT part of China Sourcing: it imports nothing from src/sourcing, shares no storage, no token and no origin with it.
//   node tools/phone-probe/server.js --results <file> [--tunnel] [--minutes 120] [--port 0]
// What it serves: the static probe page (HTML/JS/service worker) and two small endpoints:
//   GET  /ping    -> {ok:true}                       (lets the page know whether this server is reachable; no data)
//   POST /report  -> appends ONE JSON line to the results file (needs the probe token; max 64 KB; max 500 reports)
// What crosses the tunnel when --tunnel is used: the page files going TO the phone, and small JSON reports FROM the phone (capability flags, sizes, timings, event names, the browser's
// user-agent string). NO AUDIO, no recording content, no case data, nothing from Nordla. The recordings stay inside the phone browser's own storage (IndexedDB).
// Safety: loopback only; Host header must be the tunnel's own name; the token travels in the URL fragment (never sent to a server) and is required for /report; the server and the
// tunnel stop by themselves after --minutes. The token is never printed except inside the pairing link, and never written to the results file.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = { '/': ['probe.html', 'text/html; charset=utf-8'], '/index.html': ['probe.html', 'text/html; charset=utf-8'], '/probe.js': ['probe.js', 'text/javascript; charset=utf-8'], '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'] };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const WINDOWS_DEFAULT = 'C:/Program Files (x86)/cloudflared/cloudflared.exe';

export async function startProbe({ resultsFile, token = randomBytes(16).toString('hex'), port = 0, minutes = 120, log = console.log } = {}) {
  if (!resultsFile) throw new Error('resultsFile is required');
  const allowedHosts = []; let reports = 0; let child = null; let timer = null;
  const tokenOk = (given) => { const a = Buffer.from(String(given ?? '')); const b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  const hostOk = (req) => { const h = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''); return h === '127.0.0.1' || h === 'localhost' || allowedHosts.includes(h); };
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP, ...extra }); res.end(body); };
    if (!hostOk(req)) return send(421, '{"error":"HOST_NOT_ALLOWED"}');
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && FILES[path]) { const [f, type] = FILES[path]; return send(200, readFileSync(join(HERE, f)), type, path === '/sw.js' ? { 'service-worker-allowed': '/' } : {}); }
    if (req.method === 'GET' && path === '/ping') return send(200, '{"ok":true}');
    if (req.method === 'POST' && path === '/report') {
      if (!tokenOk(req.headers['x-probe-token'])) return send(401, '{"error":"TOKEN"}');
      if (reports >= 500) return send(429, '{"error":"TOO_MANY_REPORTS"}');
      let size = 0; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); } else parts.push(c); });
      req.on('end', () => {
        try { const body = JSON.parse(Buffer.concat(parts).toString('utf8')); reports += 1; appendFileSync(resultsFile, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...body })}\n`); log(`report #${reports}: ${String(body.step ?? '?').slice(0, 40)}`); send(200, '{"ok":true}'); }
        catch { send(400, '{"error":"BAD_JSON"}'); }
      });
      return undefined;
    }
    return send(404, '{"error":"NOT_FOUND"}');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const localPort = server.address().port;
  const stop = async () => { clearTimeout(timer); try { child?.kill(); } catch { /* gone */ } server.closeAllConnections?.(); await new Promise((r) => server.close(r)); };
  timer = setTimeout(() => { log(`probe time limit (${minutes} min) reached: stopping server and tunnel`); stop().then(() => process.exit(0)); }, minutes * 60000); timer.unref?.();
  const openTunnel = async ({ cloudflared = process.env.CLOUDFLARED || (existsSync(WINDOWS_DEFAULT) ? WINDOWS_DEFAULT : 'cloudflared'), timeoutMs = 45000 } = {}) => {
    child = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const found = await new Promise((resolve) => {
      let done = false; const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } }; const t = setTimeout(() => finish({ error: 'no tunnel address in time' }), timeoutMs);
      const onData = (b) => { const m = TUNNEL_URL.exec(b.toString()); if (m) finish({ url: m[0] }); };
      child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', (e) => finish({ error: String(e.code ?? e.message) })); child.on('exit', (c) => finish({ error: `cloudflared stopped (${c})` }));
    });
    if (!found.url) { try { child.kill(); } catch { /* gone */ } return { error: found.error }; }
    allowedHosts.push(new URL(found.url).hostname.toLowerCase());
    return { url: found.url, link: `${found.url}/#t=${token}` };
  };
  return { port: localPort, localLink: `http://127.0.0.1:${localPort}/#t=${token}`, token, stop, openTunnel, get reports() { return reports; } };
}

if (import.meta.url === new URL(`file:///${String(process.argv[1] ?? '').replace(/\\/g, '/').replace(/^\//, '')}`).href) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const resultsFile = arg('results'); if (!resultsFile) { console.log('usage: node tools/phone-probe/server.js --results <file> [--tunnel] [--minutes 120] [--port 0]'); process.exit(2); }
  const p = await startProbe({ resultsFile, port: Number(arg('port', 0)), minutes: Number(arg('minutes', 120)) });
  console.log(`probe server on 127.0.0.1:${p.port} (loopback only). Results file: ${resultsFile}`);
  if (process.argv.includes('--tunnel')) {
    const t = await p.openTunnel();
    if (t.error) { console.log(`NO TUNNEL: ${t.error}. Nothing is exposed.`); await p.stop(); process.exit(1); }
    console.log(`\nOpen this link ON THE PHONE (Firefox). The part after # is the probe token; do not share the link:\n\n  ${t.link}\n\nIt stops by itself after ${arg('minutes', 120)} minutes, or press Ctrl+C.`);
  } else console.log(`local link (this computer only): ${p.localLink}`);
  process.on('SIGINT', async () => { await p.stop(); process.exit(0); });
}
