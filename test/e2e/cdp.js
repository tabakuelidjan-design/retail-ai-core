// Minimal Chrome DevTools Protocol driver (no dependency): launches a REAL Chromium-family browser (Edge or Chrome) headless with its own profile, so Service Workers, the Cache
// Storage and IndexedDB behave exactly as in a phone browser engine. It is NOT a physical phone: it proves the engine-level offline behaviour, not touch, camera or install UI.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const CANDIDATES = [process.env.SOURCING_E2E_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
export const findBrowser = () => CANDIDATES.find((p) => existsSync(p)) ?? null;
export const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Browser {
  constructor(exe, profile = null) { this.exe = exe; this.profile = profile ?? mkdtempSync(join(tmpdir(), 'nordla-e2e-')); this.id = 0; this.pending = new Map(); this.listeners = []; }
  async launch() {
    this.port = await freePort();
    this.proc = spawn(this.exe, ['--headless=new', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
    let ver = null; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); } catch { await sleep(250); } }
    if (!ver) throw new Error('browser did not start');
    this.version = ver.Browser; this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const { res, rej } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(`${d.error.message}`)) : res(d.result); } else if (d.method) this.listeners.forEach((l) => l(d)); };
    return this;
  }
  send(method, params = {}, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 30000); }); }
  /** Opens a tab with a phone-sized viewport. */
  async tab(url = 'about:blank', { width = 390, height = 844 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const t = { targetId, sessionId, b: this };
    await this.send('Page.enable', {}, sessionId); await this.send('Runtime.enable', {}, sessionId); await this.send('Network.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true }, sessionId);
    t.goto = async (u) => { await this.send('Page.navigate', { url: u }, sessionId); await sleep(300); };
    t.eval = async (expression) => { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 25000 }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
    // run(): a block of statements (await allowed); it returns whatever the block `return`s
    t.run = (code) => t.eval(`(async () => { ${code}
})()`);
    t.waitFor = async (expression, ms = 15000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { last = await t.eval(expression); if (last) return last; } catch (e) { last = e.message; } await sleep(200); } throw new Error(`waitFor timed out: ${expression} (last: ${JSON.stringify(last)})`); };
    t.offline = (offline) => this.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    t.resize = (width, height) => this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true }, sessionId);
    t.close = () => this.send('Target.closeTarget', { targetId }).catch(() => {});
    if (url !== 'about:blank') await t.goto(url);
    return t;
  }
  async close({ keepProfile = false } = {}) {
    try { await this.send('Browser.close'); } catch { /* already closing */ }
    await new Promise((r) => { const to = setTimeout(r, 4000); this.proc?.once('exit', () => { clearTimeout(to); r(); }); }); try { this.proc?.kill(); } catch { /* gone */ }
    if (!keepProfile) { await sleep(300); try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* locked: temp dir */ } }
  }
}
