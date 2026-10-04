#!/usr/bin/env node
// Phone mode:  npm run sourcing:phone
// Starts the sourcing server (loopback only) AND, if the `cloudflared` program is installed on this computer, a Cloudflare "quick tunnel" that gives the phone an HTTPS address
// (HTTPS is what lets the phone keep the app for offline use). A quick tunnel needs no account and no secret. Safety of this path:
//   - the server itself stays on 127.0.0.1; only the tunnel reaches it;
//   - every /api call needs the access token; 8 wrong tokens per minute lock the sender out (the real sender, read from the proxy's header);
//   - the Host header must be the tunnel's own name (anything else is refused);
//   - the pairing link carries the token in the URL FRAGMENT (after the #): browsers never send a fragment to any server, and the app removes it from the address bar at once;
//   - nothing is stored in this repository: no token, no URL; the web address changes each time the tunnel starts.
// The link is as sensitive as a password: send it only to yourself. Stop the tunnel (Ctrl+C) when you do not need it. If cloudflared is missing nothing is exposed: the server stays local.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startSourcingServer } from './index.js';

const TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
export const parseTunnelUrl = (text) => TUNNEL_URL.exec(String(text))?.[0] ?? null;
export const pairingLink = (url, token) => `${url.replace(/\/+$/, '')}/#t=${token}`;
const WINDOWS_DEFAULT = 'C:/Program Files (x86)/cloudflared/cloudflared.exe';

/** @returns {{ localUrl: string, tunnel: null | { url: string, link: string, stop: () => void }, reason?: string, stop: () => Promise<void> }} */
export async function startPhoneMode({ env = process.env, log = console.log, spawnImpl = spawn, cloudflared = env.CLOUDFLARED || (existsSync(WINDOWS_DEFAULT) ? WINDOWS_DEFAULT : 'cloudflared'), startServer = startSourcingServer, tunnelTimeoutMs = 45000, port } = {}) {
  const allowedHosts = []; // live list: the tunnel's host name is added when it is known
  const srv = await startServer({ env, log, allowedHosts, ...(port !== undefined ? { port } : {}) });
  const localUrl = `http://127.0.0.1:${srv.port}`;
  let child = null;
  const stop = async () => { try { child?.kill(); } catch { /* gone */ } await new Promise((r) => srv.server.close(r)); };
  try { child = spawnImpl(cloudflared, ['tunnel', '--url', localUrl, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return { localUrl, tunnel: null, reason: `cloudflared could not be started (${e.code ?? e.message})`, stop }; }
  const found = await new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish({ error: 'no tunnel address appeared in time' }), tunnelTimeoutMs);
    const onData = (buf) => { const u = parseTunnelUrl(buf.toString()); if (u) finish({ url: u }); };
    child.stdout?.on('data', onData); child.stderr?.on('data', onData);
    child.on('error', (e) => finish({ error: `cloudflared is not installed or not runnable (${e.code ?? e.message})` }));
    child.on('exit', (c) => finish({ error: `cloudflared stopped (code ${c})` }));
  });
  if (!found.url) { try { child.kill(); } catch { /* gone */ } return { localUrl, tunnel: null, reason: found.error, stop }; }
  allowedHosts.push(new URL(found.url).hostname.toLowerCase());
  return { localUrl, tunnel: { url: found.url, link: pairingLink(found.url, srv.token), stop: () => child.kill() }, stop };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await startPhoneMode();
  if (!r.tunnel) {
    console.log(`\nPHONE ACCESS NOT STARTED: ${r.reason}.\nThe server runs only on this computer (${r.localUrl}); nothing is exposed.\nTo reach it from a phone you need an HTTPS address. Install cloudflared (free, no account for a quick tunnel) and run this command again, or see docs/sourcing-phone-rehearsal.md.`);
  } else {
    console.log(`\nPHONE ACCESS IS ON (public HTTPS address, protected by your access token).\n\n  Open this link ON THE PHONE (it contains your access token: treat it like a password, send it only to yourself):\n\n  ${r.tunnel.link}\n\nWhen it opens, tap "Add to Home Screen". Leave this window open while you use it; press Ctrl+C to switch phone access off.`);
  }
  process.on('SIGINT', async () => { await r.stop(); process.exit(0); });
}
