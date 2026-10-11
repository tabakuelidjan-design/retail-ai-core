import {
  appendFile, mkdir, readFile, stat, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { takeLiveCallLock } from '../marketing-creative/alibaba/live-call-lock.js';

// The private store of a benchmark: a directory OUTSIDE the repository, files written with mode 0600, a live lock that code never releases. The in-memory store has the same interface for tests.

const NAME = /^[A-Za-z0-9._-]+$/;
const assertName = (name) => { if (!NAME.test(name)) throw new Error('a store file name is a plain file name'); return name; };

export function createFileStore(dir) {
  const file = (name) => path.join(dir, assertName(name));
  return Object.freeze({
    dir,
    async exists(name) { try { await stat(file(name)); return true; } catch { return false; } },
    async probeWritable() {
      try { await mkdir(dir, { recursive: true }); const probe = file('.write-probe'); await writeFile(probe, 'x', { mode: 0o600 }); await unlink(probe); return true; } catch { return false; }
    },
    async writeJson(name, value) { await mkdir(dir, { recursive: true }); await writeFile(file(name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); },
    async writeBytes(name, bytes) { await mkdir(dir, { recursive: true }); await writeFile(file(name), bytes, { mode: 0o600 }); },
    async readJson(name) { try { return JSON.parse(await readFile(file(name), 'utf8')); } catch { return null; } },
    async readEvents() { const text = await readFile(file('provider-calls.jsonl'), 'utf8').catch(() => ''); return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
    async takeLock() { await takeLiveCallLock(file('live-run-001.lock')); },
    async appendLine(name, line) { await mkdir(dir, { recursive: true }); await appendFile(file(name), `${line}\n`, { mode: 0o600 }); },
  });
}

export function createMemoryStore(dir = '/private/memory/creative-brain-benchmark-001') {
  const files = new Map(); let locked = false; let writable = true;
  return {
    dir,
    files,
    setWritable(value) { writable = value; },
    async exists(name) { return files.has(assertName(name)) || (name === 'live-run-001.lock' && locked); },
    async probeWritable() { return writable; },
    async writeJson(name, value) { files.set(assertName(name), JSON.parse(JSON.stringify(value))); },
    async writeBytes(name, bytes) { files.set(assertName(name), new Uint8Array(bytes)); },
    async readJson(name) { const v = files.get(assertName(name)); return v === undefined || v instanceof Uint8Array ? null : JSON.parse(JSON.stringify(v)); },
    async readEvents() { return files.get('provider-calls.jsonl') ?? []; },
    async takeLock() { if (locked) throw Object.assign(new Error('LIVE_CALL_ALREADY_ATTEMPTED'), { code: 'LIVE_CALL_ALREADY_ATTEMPTED' }); locked = true; },
  };
}
