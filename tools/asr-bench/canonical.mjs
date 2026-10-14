// The CANONICAL recording of the benchmark: ONE audio session, accepted once, immutable, hashed. Every provider receives audio derived from THIS sample (deriveForProvider), never a new voice sample.
// Layout (under data/local/voice-bench/, excluded from git):  canonical/<session>/{ canonical-native.wav, meta.json, markers.json, script.json, references.json (editable until frozen), SHA256SUMS }
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deriveForProvider, durationSec, sha256Hex, parseWav } from './audio.mjs';
import { windowsOf } from './score.mjs';

export const FILES = Object.freeze({ audio: 'canonical-native.wav', meta: 'meta.json', markers: 'markers.json', script: 'script.json', references: 'references.json', sums: 'SHA256SUMS' });
export const sessionDir = (root, session) => join(root, 'canonical', String(session).replace(/[^A-Za-z0-9_.-]/g, '_'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Stores an accepted recording. Refuses to overwrite: a canonical recording is immutable. @returns {{ dir: string, sha256: string, derived: object }} */
export function storeCanonical(root, session, { wav, markers, script, device = {}, browserAudioProcessing = {}, acceptedAt = new Date().toISOString(), clientSha256 = null }) {
  const dir = sessionDir(root, session); if (existsSync(join(dir, FILES.audio))) { const e = new Error(`canonical recording already exists for ${session}: it is immutable`); e.code = 'EXISTS'; throw e; }
  const sha = sha256Hex(wav); if (clientSha256 && clientSha256 !== sha) { const e = new Error('SHA-256 computed by the browser does not match the received file'); e.code = 'HASH_MISMATCH'; throw e; }
  const w = parseWav(wav); const derived = deriveForProvider(wav, { sampleRate: 16000 }); mkdirSync(dir, { recursive: true });
  const meta = { session, acceptedAt, audio: { file: FILES.audio, format: `WAVE ${w.format}`, sampleRate: w.sampleRate, channels: w.channels, bitsPerSample: w.bitsPerSample, frames: w.frames, durationSec: Math.round((w.frames / w.sampleRate) * 1000) / 1000, sha256: sha, lossless: 'raw PCM captured by the browser, written without compression' }, device, browserAudioProcessing, derivedForProviders: { sampleRate: 16000, sha256: derived.sha256, durationSec: durationSec(derived.pcm16, 16000), transformation: derived.transformation }, scriptVersion: script.version, scriptItems: script.items.length, immutable: true };
  writeFileSync(join(dir, FILES.audio), wav); writeFileSync(join(dir, FILES.meta), JSON.stringify(meta, null, 1)); writeFileSync(join(dir, FILES.markers), JSON.stringify(markers, null, 1)); writeFileSync(join(dir, FILES.script), JSON.stringify(script, null, 1));
  const sums = [FILES.audio, FILES.meta, FILES.markers, FILES.script].map((f) => `${sha256Hex(readFileSync(join(dir, f)))}  ${f}`).join('\n') + '\n'; writeFileSync(join(dir, FILES.sums), sums);
  for (const f of [FILES.audio, FILES.meta, FILES.markers, FILES.script, FILES.sums]) { try { chmodSync(join(dir, f), 0o444); } catch { /* best effort on Windows */ } }
  return { dir, sha256: sha, derived: meta.derivedForProviders };
}
/** The references (what the owner really said in the natural sections, and corrections of controlled items) are editable until the benchmark is scored; they are NOT part of the audio hash. */
export function saveReferences(root, session, references) { const dir = sessionDir(root, session); if (!existsSync(join(dir, FILES.audio))) throw new Error('no canonical recording for this session'); writeFileSync(join(dir, FILES.references), JSON.stringify({ updatedAt: new Date().toISOString(), references }, null, 1)); }
export const loadReferences = (dir) => (existsSync(join(dir, FILES.references)) ? readJson(join(dir, FILES.references)).references : {});

/** Re-hashes every immutable file and the derivation. Throws nothing: returns what is wrong. */
export function verifyCanonical(dir) {
  const bad = []; const sums = readFileSync(join(dir, FILES.sums), 'utf8').trim().split('\n').map((l) => l.split(/\s{2}/));
  for (const [sha, f] of sums) { if (!existsSync(join(dir, f))) bad.push(`${f}: missing`); else if (sha256Hex(readFileSync(join(dir, f))) !== sha) bad.push(`${f}: hash changed`); }
  const meta = readJson(join(dir, FILES.meta)); if (!bad.length) { const d = deriveForProvider(readFileSync(join(dir, FILES.audio)), { sampleRate: 16000 }); if (d.sha256 !== meta.derivedForProviders.sha256) bad.push('derived 16 kHz audio differs from the recorded derivation'); }
  return { ok: bad.length === 0, problems: bad, sha256: meta.audio.sha256, derivedSha256: meta.derivedForProviders.sha256 };
}
/** Everything a run needs, after verification. Refuses a canonical recording that no longer matches its hashes. */
export function loadCanonical(dir) {
  const v = verifyCanonical(dir); if (!v.ok) throw new Error(`the canonical recording is not intact: ${v.problems.join('; ')}`);
  const meta = readJson(join(dir, FILES.meta)); const script = readJson(join(dir, FILES.script)); const markers = readJson(join(dir, FILES.markers)); const wav = readFileSync(join(dir, FILES.audio)); const d = deriveForProvider(wav, { sampleRate: 16000 });
  const audio = { pcm16: d.pcm16, sampleRate: 16000, sha256: meta.audio.sha256, derivedSha256: d.sha256, durationSec: durationSec(d.pcm16, 16000), transformation: d.transformation };
  return { dir, meta, script, markers, audio, windows: windowsOf(markers.items, markers.stopSec ?? audio.durationSec), references: loadReferences(dir) };
}
export const listSessions = (root) => (existsSync(join(root, 'canonical')) ? readdirSync(join(root, 'canonical')) : []);
