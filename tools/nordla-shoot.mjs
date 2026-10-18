// Full-page screenshots with the real Chromium-family browser of this machine (same CDP driver as the e2e tests). Local pages only.
//   node tools/nordla-shoot.mjs <url> <out.png> [width=1440] [height=900] [waitMs=600]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Browser, findBrowser } from '../test/e2e/cdp.js';

const [url, out, width = '1440', height = '900', waitMs = '600'] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node tools/nordla-shoot.mjs <url> <out.png> [width] [height] [waitMs]'); process.exit(2); }
const exe = findBrowser(); if (!exe) { console.error('no Chromium-family browser found'); process.exit(3); }
const b = new Browser(exe); await b.launch();
try {
  const t = await b.tab('about:blank', { width: Number(width), height: Number(height) });
  await t.goto(url); await new Promise((r) => setTimeout(r, Number(waitMs)));
  const r = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, t.sessionId);
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, Buffer.from(r.data, 'base64')); console.log('saved', out);
} finally { await b.close(); }
