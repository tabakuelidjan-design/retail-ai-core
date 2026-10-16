#!/usr/bin/env node
// Phone access:  npm run procurement:phone
// Starts the procurement server (loopback only) and, if `cloudflared` is installed, a Cloudflare quick tunnel that gives the phone an HTTPS address (HTTPS is what
// lets the phone install the app and keep its screens). Same safety model as the Sourcing phone mode:
//   - the server itself stays on 127.0.0.1; only the tunnel reaches it, and only for its own host name (anything else is refused);
//   - every call needs a personal token; 8 wrong tokens a minute lock the sender out;
//   - the link carries the token in the URL FRAGMENT (after #): browsers never send it to a server and the app removes it from the address bar;
//   - nothing is stored in this repository; the address changes each time the tunnel starts. The link is as sensitive as a password.
// If cloudflared is missing nothing is exposed: the server stays on this computer.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startProcurementServer } from './index.js';

const TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
export const parseTunnelUrl = (text) => TUNNEL_URL.exec(String(text))?.[0] ?? null;
export const pairingLink = (url, token) => `${url.replace(/\/+$/, '')}/#t=${token}`;
const WINDOWS_DEFAULT = 'C:/Program Files (x86)/cloudflared/cloudflared.exe';

export async function startPhoneMode({ env = process.env, spawnImpl = spawn, cloudflared = env.CLOUDFLARED || (existsSync(WINDOWS_DEFAULT) ? WINDOWS_DEFAULT : 'cloudflared'), tunnelTimeoutMs = 45_000, port } = {}) {
  const allowedHosts = []; // live list: the tunnel's own host name is added once known
  const srv = await startProcurementServer({ env, allowedHosts, ...(port !== undefined ? { port } : {}) });
  const localUrl = `http://127.0.0.1:${srv.port}`;
  let child = null;
  const stop = async () => { try { child?.kill(); } catch { /* gone */ } await srv.stop(); };
  try { child = spawnImpl(cloudflared, ['tunnel', '--url', localUrl, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return { localUrl, tunnel: null, reason: `cloudflared could not be started (${e.code ?? e.message})`, srv, stop }; }
  const found = await new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish({ error: 'no tunnel address appeared in time' }), tunnelTimeoutMs);
    const onData = (buf) => { const u = parseTunnelUrl(buf.toString()); if (u) finish({ url: u }); };
    child.stdout?.on('data', onData); child.stderr?.on('data', onData);
    child.on('error', (e) => finish({ error: `cloudflared is not installed or not runnable (${e.code ?? e.message})` }));
    child.on('exit', (c) => finish({ error: `cloudflared stopped (code ${c})` }));
  });
  if (!found.url) { try { child.kill(); } catch { /* gone */ } return { localUrl, tunnel: null, reason: found.error, srv, stop }; }
  allowedHosts.push(new URL(found.url).hostname.toLowerCase());
  return { localUrl, tunnel: { url: found.url, links: srv.users.map((u) => ({ user: u.name ?? u.id, canApprove: Boolean(u.canApprove), link: pairingLink(found.url, u.token) })) }, srv, stop };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await startPhoneMode();
  if (!r.tunnel) console.log(`\nPHONE ACCESS NOT STARTED: ${r.reason}.\nThe server runs only on this computer (${r.localUrl}); nothing is exposed.\nInstall cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run this again.`);
  else console.log(`\nPHONE ACCESS IS ON (public HTTPS address, protected by your personal token).\n\n${r.tunnel.links.map((l) => `  ${l.user}${l.canApprove ? ' (can approve)' : ''}:\n  ${l.link}\n`).join('\n')}\nOpen YOUR link ON THE PHONE. Treat it like a password. Ctrl+C stops the tunnel.`);
  process.on('SIGINT', async () => { await r.stop(); process.exit(0); });
}
