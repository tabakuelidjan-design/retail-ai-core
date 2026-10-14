// Qwen3-ASR-1.7B, LOCAL / self-hosted candidate, through the C port antirez/qwen-asr (MIT; model Apache-2.0): https://github.com/antirez/qwen-asr (read 2026-10-07).
//   ./qwen_asr -d <model dir> -i <file.wav> --silent [--prompt "vocabulary..."] [--language English]    -> text on stdout (no timestamps)
// Because the port prints no timestamps, the audio is transcribed WINDOW BY WINDOW (the item windows of the canonical session, padded by 0.3 s). That is OFFLINE and gives the engine the item boundaries (a
// favourable condition the cloud streams do not get): the report says so. Audio never leaves the machine. Nothing here downloads a model or builds the binary: that needs the owner's approval (see the runbook).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_META, validateResult } from '../provider.mjs';
import { writeWav16 } from '../audio.mjs';

export const toWslPath = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
/** PURE: the command that would run for one window (the prompt is the Pass B context). */
export function buildCommand({ bin, prefix = '', modelDir, wavPath, prompt = null, language = 'English', wsl = false }) {
  const args = ['-d', wsl ? toWslPath(modelDir) : modelDir, '-i', wsl ? toWslPath(wavPath) : wavPath, '--silent', '--language', language, ...(prompt ? ['--prompt', prompt] : [])];
  const pre = prefix.split(/\s+/).filter(Boolean); return { cmd: pre[0] ?? bin, args: pre.length ? [...pre.slice(1), bin, ...args] : args };
}
export function buildRequest({ context, env = process.env } = {}) { return { local: true, bin: env.QWEN_ASR_BIN ?? '<QWEN_ASR_BIN>', modelDir: env.QWEN_ASR_MODEL_DIR ?? '<QWEN_ASR_MODEL_DIR>', mode: 'window-by-window offline (no timestamps from the port)', contextApplied: { mechanism: context?.mechanism ?? 'none', payload: context?.payload ?? {} } }; }
const run = (cmd, args) => new Promise((res, rej) => { const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; }); p.on('error', rej); p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`qwen_asr exited ${code}: ${err.slice(0, 300)}`)))); });

export default {
  id: 'qwen3', model: 'Qwen3-ASR-1.7B', meta: PROVIDER_META.qwen3, buildRequest,
  async transcribe(audio, { pass, context, windows, env = process.env } = {}) {
    if (!env.QWEN_ASR_BIN || !env.QWEN_ASR_MODEL_DIR) throw new Error('QWEN_ASR_BIN and QWEN_ASR_MODEL_DIR are not set (the model is not downloaded without the owner\'s approval)');
    if (!windows?.length) throw new Error('the local candidate needs the item windows of the canonical session');
    const startedAt = new Date().toISOString(); const t0 = performance.now(); const dir = mkdtempSync(join(tmpdir(), 'qwen-asr-')); const segs = []; const errors = []; const wsl = /^wsl/i.test(env.QWEN_ASR_PREFIX ?? '');
    try {
      for (const w of windows) {
        const a = Math.max(0, Math.floor((w.startSec - 0.3) * audio.sampleRate)); const b = Math.min(audio.pcm16.length, Math.ceil((w.endSec + 0.3) * audio.sampleRate)); if (b - a < audio.sampleRate * 0.3) continue;
        const wavPath = join(dir, `${w.id}.wav`); writeFileSync(wavPath, writeWav16([audio.pcm16.subarray(a, b)], audio.sampleRate)); const c = buildCommand({ bin: env.QWEN_ASR_BIN, prefix: env.QWEN_ASR_PREFIX ?? '', modelDir: env.QWEN_ASR_MODEL_DIR, wavPath, prompt: context?.payload?.prompt ?? null, wsl });
        const w0 = performance.now(); try { const text = (await run(c.cmd, c.args)).replace(/\s+/g, ' ').trim(); if (text) segs.push({ text, startSec: w.startSec, endSec: w.endSec, isFinal: true, windowId: w.id, lagMs: Math.round(performance.now() - w0) }); } catch (e) { errors.push({ window: w.id, message: String(e.message ?? e) }); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const finishedAt = new Date().toISOString();
    return validateResult({ provider: 'qwen3', model: 'Qwen3-ASR-1.7B', mode: 'offline-windowed', pass, audioSha256: audio.sha256, startedAt, finishedAt, wallMs: Math.round(performance.now() - t0), audioSec: audio.durationSec, pace: 0, rawTranscript: segs.map((x) => x.text).join(' '), segments: segs, contextApplied: buildRequest({ context, env }).contextApplied, providerMeta: { offline: true, windows: windows.length, note: 'item windows were given to the engine (favourable condition, not a continuous stream)' }, events: { windows: segs.length }, errors });
  },
};
