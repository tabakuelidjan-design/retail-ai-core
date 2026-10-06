// ISOLATED voice-benchmark server. It is NOT the Nordla server: no token, no case, no Nordla route. It serves static files with the cross-origin-isolation headers the WebAssembly engines
// need (COOP/COEP, only here), the downloaded models from data/local/voice-bench/, the Nordla pure modules READ-ONLY (so the bench measures the real extractor/topics/context), and one
// POST endpoint that stores a JSON result under data/local/voice-bench/results/. Nothing in src/ or any Nordla configuration is changed.   node tools/voice-bench/server.mjs [port]
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); const REPO = resolve(HERE, '../..'); const DATA = join(REPO, 'data/local/voice-bench');
const MAPS = [['/vendor/', join(DATA, 'vendor')], ['/models/', join(DATA, 'models')], ['/corpus-audio/', join(DATA, 'corpus')], ['/nordla/', join(REPO, 'src/sourcing/core')], ['/bench/', join(HERE, 'corpus')], ['/', join(HERE, 'web')]];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.wav': 'audio/wav', '.ort': 'application/octet-stream', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.css': 'text/css' };
const H = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store' };
const port = Number(process.argv[2] || 8801);
http.createServer((q, s) => {
  const url = new URL(q.url, 'http://x'); let p = decodeURIComponent(url.pathname);
  if (q.method === 'POST' && p === '/api/result') { let b = ''; q.on('data', (d) => { b += d; if (b.length > 20e6) q.destroy(); }); q.on('end', () => { try { const j = JSON.parse(b); mkdirSync(join(DATA, 'results'), { recursive: true }); const name = String(url.searchParams.get('name') || 'result').replace(/[^A-Za-z0-9_.-]/g, '_'); writeFileSync(join(DATA, 'results', `${name}.json`), JSON.stringify(j, null, 1)); s.writeHead(200, H); s.end('ok'); } catch (e) { s.writeHead(400, H); s.end(String(e.message)); } }); return; }
  if (q.method !== 'GET' && q.method !== 'HEAD') { s.writeHead(405, H); return s.end(); }
  if (p.endsWith('/')) p += 'index.html'; let f = null;
  for (const [pre, dir] of MAPS) { if (p.startsWith(pre)) { const cand = normalize(join(dir, p.slice(pre.length))); if (cand.startsWith(normalize(dir)) && existsSync(cand) && statSync(cand).isFile()) { f = cand; break; } } }
  if (!f) { s.writeHead(404, H); return s.end('not found'); }
  s.writeHead(200, { ...H, 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'content-length': statSync(f).size }); s.end(q.method === 'HEAD' ? undefined : readFileSync(f));
}).listen(port, '127.0.0.1', () => console.log(`voice-bench on http://127.0.0.1:${port}`));
