// Durable post store. Two implementations, one contract: memory (tests) and atomic files (the phone app, the 2-week trip).
//
//   create(post) · get(id) · list() · update(id, fn)   fn(post, ctx) -> new post; ctx.list() returns every post as it is INSIDE the same atomic step (for rules that look at other posts)
//                                                      the write is serialized per store, rev-checked, and for the file store ATOMIC BETWEEN PROCESSES (lock.js)
//   audit(): every history event of every post, append-only (audit.jsonl), written AFTER the post file
//
// Nothing secret is ever persisted: every write is scanned (activation's guard) and refused if it looks like a token or a signed URL.
// The permalink of a published post is the only URL allowed to carry a query string (Facebook permalinks do), and it is checked for tokens.

import {
  appendFile, mkdir, readFile, readdir, rename, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { findSecretLeaks } from '../activation/validation.js';
import { SOCIAL_ERROR as E, fail } from './constants.js';
import { retryTransient, withDirLock } from './lock.js';

const TOKEN_IN_URL = /(access_token|token|secret|signature|sig)=/i;
function assertPersistable(post) {
  const copy = structuredClone(post);
  for (const key of ['publication', 'verification']) {
    const section = copy[key];
    if (section?.permalink) {
      if (TOKEN_IN_URL.test(section.permalink)) fail(E.INVALID, `${key}.permalink carries a credential-looking parameter`, { field: `${key}.permalink` });
      delete section.permalink;
    }
  }
  const leaks = findSecretLeaks(copy);
  if (leaks.length) fail(E.INVALID, 'a post must not contain a secret, a token or a signed URL', { paths: leaks });
}

function newEventsOf(before, after) {
  return after.history.slice(before ? before.history.length : 0).map((event) => ({ post_id: after.id, ...event }));
}

function createSerializer() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

export function createMemoryStore() {
  const posts = new Map();
  const events = [];
  const serial = createSerializer();
  return {
    kind: 'memory',
    async create(post) {
      return serial(async () => {
        assertPersistable(post);
        if (posts.has(post.id)) fail(E.CONFLICT, 'a post with this id already exists', { id: post.id });
        posts.set(post.id, structuredClone(post));
        events.push(...newEventsOf(null, post));
        return structuredClone(post);
      });
    },
    async get(id) {
      const p = posts.get(id);
      return p ? structuredClone(p) : null;
    },
    async list() { return [...posts.values()].map((p) => structuredClone(p)).sort((a, b) => a.created_at.localeCompare(b.created_at)); },
    async update(id, fn) {
      return serial(async () => {
        const current = posts.get(id);
        if (!current) fail(E.NOT_FOUND, 'post not found', { id });
        const next = await fn(structuredClone(current), { list: async () => [...posts.values()].map((p) => structuredClone(p)) });
        if (next === current) return structuredClone(current);
        if (next.id !== current.id) fail(E.INVALID, 'a post id never changes');
        if (next.rev <= current.rev) return structuredClone(current); // nothing changed
        assertPersistable(next);
        posts.set(id, structuredClone(next));
        events.push(...newEventsOf(current, next));
        return structuredClone(next);
      });
    },
    async audit() { return structuredClone(events); },
  };
}

const safeId = (id) => (/^post_[A-Za-z0-9-]{8,64}$/.test(id) ? id : fail(E.INVALID, 'invalid post id', { field: 'id' }));

export function createFileStore(dir, { lock = {} } = {}) {
  const postsDir = join(dir, 'posts');
  const auditFile = join(dir, 'audit.jsonl');
  const serial = createSerializer();
  const lockPath = join(dir, '.store.lock'); // a file (lock.js)
  // every read-modify-write runs under the in-process serializer AND the cross-process lock: two processes can never both act on the same version of a post
  const exclusive = (task) => serial(() => withDirLock(lockPath, task, lock));
  let ready;
  const init = () => (ready ??= mkdir(postsDir, { recursive: true }));
  const fileOf = (id) => join(postsDir, `${safeId(id)}.json`);
  const read = async (id) => {
    try { return JSON.parse(await retryTransient(() => readFile(fileOf(id), 'utf8'))); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const write = async (post) => {
    const file = fileOf(post.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(post, null, 2)}\n`, 'utf8');
    await retryTransient(() => rename(tmp, file)); // atomic replace: a crash leaves the old or the new file, never half of one
  };
  const logEvents = async (events) => {
    if (events.length) await appendFile(auditFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  };
  const listUnlocked = async () => {
    const names = (await readdir(postsDir)).filter((n) => n.endsWith('.json'));
    const posts = [];
    for (const n of names) posts.push(JSON.parse(await retryTransient(() => readFile(join(postsDir, n), 'utf8'))));
    return posts.sort((a, b) => a.created_at.localeCompare(b.created_at));
  };
  return {
    kind: 'file',
    dir,
    async create(post) {
      await init();
      return exclusive(async () => {
        assertPersistable(post);
        if (await read(post.id)) fail(E.CONFLICT, 'a post with this id already exists', { id: post.id });
        await write(post);
        await logEvents(newEventsOf(null, post));
        return structuredClone(post);
      });
    },
    async get(id) { await init(); return read(id); },
    async list() { await init(); return listUnlocked(); },
    async update(id, fn) {
      await init();
      return exclusive(async () => {
        const current = await read(id);
        if (!current) fail(E.NOT_FOUND, 'post not found', { id });
        const next = await fn(structuredClone(current), { list: listUnlocked });
        if (next.id !== current.id) fail(E.INVALID, 'a post id never changes');
        if (next.rev <= current.rev) return current;
        assertPersistable(next);
        await write(next);
        await logEvents(newEventsOf(current, next));
        return next;
      });
    },
    async audit() {
      await init();
      try { return (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
  };
}
