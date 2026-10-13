// Persistence of the field workspace (see core/field/workspace.js). One JSON file written atomically (temp file + rename), exactly like the case store, and revision-safe in a way that cannot lose
// data: a save whose base revision is stale is MERGED with what is stored (the merge is a union, so neither copy loses anything) instead of being refused or overwriting.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeWorkspaces, newWorkspace } from '../core/field/workspace.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
function saver(read, write) {
  let chain = Promise.resolve(); // saves are serialised: two requests cannot interleave a read and a write
  return {
    async get() { return (await read()) ?? newWorkspace(); },
    save(incoming) {
      const run = chain.then(async () => {
        const stored = await read(); const merged = stored ? mergeWorkspaces(stored, incoming) : mergeWorkspaces(newWorkspace(new Date(incoming.createdAt ?? Date.now())), incoming);
        const next = { ...merged, rev: (stored?.rev ?? 0) + 1 }; await write(next); return clone(next);
      });
      chain = run.catch(() => {}); return run;
    },
  };
}
export function createMemoryWorkspaceStore() { let v = null; return saver(async () => (v ? clone(v) : null), async (x) => { v = clone(x); }); }
export function createFileWorkspaceStore(dir) {
  const sub = join(dir, 'workspace'); const file = join(sub, 'field.json'); // a sub-folder: the case store lists every *.json directly in its folder and must never meet this file
  return saver(async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async (x) => { await mkdir(sub, { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(x, null, 1)); await rename(tmp, file); });
}
