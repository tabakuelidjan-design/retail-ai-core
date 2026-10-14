#!/usr/bin/env node
// ASR physical benchmark runner (LAB). Sub-commands:
//   requirements                         what every candidate needs (accounts, keys, downloads, cost) - prints, touches nothing
//   plan  --session S                    the EXACT requests and context each provider/pass WOULD send (no network, no key needed)
//   run   --provider P --pass A|B --session S [--pace 1] [--language ..] --approve-send P
//                                       sends the canonical OWNER audio to provider P. Without --approve-send=<P> nothing is sent. Keys come from the environment and are never written anywhere.
// Nothing here is Nordla production code. Owner audio only; never supplier audio.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadProvider, PROVIDERS, REQUIREMENTS, PROVIDER_META } from './provider.mjs';
import { buildContext } from './context.mjs';
import { loadCanonical, sessionDir } from './canonical.mjs';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); const ROOT = process.env.VOICE_BENCH_DATA ? resolve(process.env.VOICE_BENCH_DATA) : resolve(HERE, '../../data/local/voice-bench');
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); if (i >= 0) return process.argv[i + 1]; const m = process.argv.find((a) => a.startsWith(`--${n}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const cmd = process.argv[2];
const redact = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/key|token|authorization/i.test(k) && typeof v === 'string' && !v.startsWith('<') ? '<redacted>' : v)));

export function requirementsReport(env = process.env) {
  return PROVIDERS.map((p) => { const r = REQUIREMENTS[p]; return { provider: p, name: PROVIDER_META[p].name, missingEnv: r.env.filter((k) => !env[k]), presentEnv: r.env.filter((k) => !!env[k]), optionalEnv: r.optionalEnv, accounts: r.accounts, downloads: r.downloads, paid: r.paid }; });
}
export async function planFor(session, owner = {}) {
  const c = loadCanonical(sessionDir(ROOT, session)); const out = [];
  for (const p of PROVIDERS) { const prov = await loadProvider(p); for (const pass of ['A', 'B']) { const ctx = buildContext(p, pass, owner); out.push({ provider: p, pass, request: redact(prov.buildRequest({ context: ctx })), audio: { sha256: c.audio.sha256, derivedSha256: c.audio.derivedSha256, durationSec: c.audio.durationSec, sampleRate: c.audio.sampleRate } }); } }
  return out;
}

async function main() {
  if (cmd === 'requirements') { console.log(JSON.stringify(requirementsReport(), null, 2)); return; }
  const session = arg('session'); if (!session) throw new Error('--session is required');
  if (cmd === 'plan') { console.log(JSON.stringify(await planFor(session), null, 2)); console.log('\nDRY RUN: nothing was sent.'); return; }
  if (cmd !== 'run') { console.log('usage: run.mjs requirements | plan --session S | run --provider P --pass A|B --session S --approve-send P'); process.exitCode = 2; return; }
  const provider = arg('provider'); const pass = arg('pass'); if (!PROVIDERS.includes(provider) || !['A', 'B'].includes(pass)) throw new Error(`--provider ${PROVIDERS.join('|')} and --pass A|B are required`);
  const prov = await loadProvider(provider); const c = loadCanonical(sessionDir(ROOT, session)); const owner = (() => { try { return JSON.parse(readOwner(session)); } catch { return {}; } })(); const ctx = buildContext(provider, pass, owner); const pace = Number(arg('pace', provider === 'qwen3' ? 0 : 1)); const language = arg('language');
  const need = REQUIREMENTS[provider].env.filter((k) => !process.env[k]);
  if (arg('approve-send') !== provider) { console.log(JSON.stringify(redact(prov.buildRequest({ context: ctx })), null, 2)); console.log(`\nDRY RUN: no audio was sent. To send the owner's canonical recording (sha256 ${c.audio.sha256.slice(0, 16)}…) to ${provider}, re-run with --approve-send=${provider}${need.length ? ` after setting: ${need.join(', ')}` : ''}.`); process.exitCode = 3; return; }
  if (need.length) { console.log(`MISSING: ${need.join(', ')} (owner action: see the runbook). Nothing was sent.`); process.exitCode = 4; return; }
  const opts = { pass, context: ctx, pace, ...(language ? { language: provider === 'speechmatics' ? language : [language] } : {}), windows: c.windows };
  const res = await prov.transcribe(c.audio, opts);
  const dir = join(ROOT, 'asr-results', session); mkdirSync(dir, { recursive: true }); const file = join(dir, `${provider}-pass${pass}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
  writeFileSync(file, JSON.stringify({ ...res, canonical: { session, sha256: c.audio.sha256, derivedSha256: c.audio.derivedSha256, transformation: c.audio.transformation }, providerRecord: PROVIDER_META[provider], executionLocation: PROVIDER_META[provider].executionLocation }, null, 1));
  console.log(`done: ${file}\nsegments: ${res.segments.length}  wall: ${res.wallMs} ms  errors: ${res.errors.length}`);
}
import { readFileSync } from 'node:fs';
const readOwner = (session) => readFileSync(join(sessionDir(ROOT, session), 'nordla-context.json'), 'utf8');
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('asr-bench/run.mjs')) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
