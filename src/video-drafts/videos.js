// Video drafts: an MP4 exported from CapCut, dropped in Nordla, with ONE caption per network (TikTok, Instagram), kept as DRAFTS. Nothing here talks to TikTok or Instagram: no account access is used or needed.
//
// Layout under <dataDir>/video-drafts/<merchant>/ : index.json (records, atomic write) and files/<id>.mp4 (the video as uploaded, streamed to disk, never held in memory).
// A draft has a state (DRAFT only in this version: no approval, no publication) and the two captions are edited independently.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const NETWORKS = Object.freeze(['tiktok', 'instagram']);
export const LIMITS = Object.freeze({ CAPTION_MAX: 2200, TITLE_MAX: 120, VIDEO_MAX_BYTES: 250 * 1024 * 1024 });
export class VideoError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

const cleanText = (v, max, field) => { if (v == null) return ''; if (typeof v !== 'string') throw new VideoError(`${field.toUpperCase()}_INVALID`); const t = v.replace(/\r\n/g, '\n').trim(); if (t.length > max) throw new VideoError(`${field.toUpperCase()}_TOO_LONG`); return t; };
/** ISO base media file: bytes 4..8 are "ftyp" (MP4 / MOV from CapCut). A renamed image or document is refused. */
export const looksLikeMp4 = (head) => head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp';
const safeName = (n) => String(n ?? 'video.mp4').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || 'video.mp4';

export function createVideoStore({ dataDir, merchantId, now = () => new Date() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(merchantId))) throw new TypeError('invalid merchant id');
  const base = resolve(dataDir, 'video-drafts', String(merchantId)); const index = join(base, 'index.json'); const filesDir = join(base, 'files');
  if (!(base + sep).startsWith(resolve(dataDir) + sep)) throw new TypeError('invalid data dir');
  let chain = Promise.resolve();
  const read = async () => { try { const j = JSON.parse(await readFile(index, 'utf8')); return Array.isArray(j.videos) ? j.videos : []; } catch { return []; } };
  const write = async (videos) => { await mkdir(base, { recursive: true }); const tmp = `${index}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify({ version: 1, videos }, null, 1)); await rename(tmp, index); };
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const filePath = (id) => join(filesDir, `${id}.mp4`);
  const emptyCaptions = () => ({ tiktok: { text: '', updatedAt: null, updatedBy: null }, instagram: { text: '', updatedAt: null, updatedBy: null } });
  return Object.freeze({
    list: async () => (await read()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: async (id) => (await read()).find((v) => v.id === id) ?? null,
    filePath,
    /** Streams the request body to disk (size capped, sha-256 computed on the way), checks it is an MP4, then records the draft. */
    async add({ stream, filename, title, by }) {
      const id = `VID-${randomUUID().slice(0, 8)}`; await mkdir(filesDir, { recursive: true }); const tmp = join(filesDir, `${id}.part`); const hash = createHash('sha256');
      let size = 0; let head = Buffer.alloc(0); const out = createWriteStream(tmp);
      try {
        await new Promise((ok, ko) => {
          out.on('error', ko); out.on('finish', ok);
          stream.on('error', ko); stream.on('aborted', () => ko(new VideoError('UPLOAD_ABORTED')));
          stream.on('data', (c) => { size += c.length; if (size > LIMITS.VIDEO_MAX_BYTES) { stream.destroy(); out.destroy(); return ko(new VideoError('VIDEO_TOO_LARGE', 413)); } if (head.length < 12) head = Buffer.concat([head, c]).subarray(0, 12); hash.update(c); if (!out.write(c)) { stream.pause(); out.once('drain', () => stream.resume()); } });
          stream.on('end', () => out.end());
        });
        if (size === 0) throw new VideoError('VIDEO_EMPTY');
        if (!looksLikeMp4(head)) throw new VideoError('NOT_AN_MP4', 415);
        await rename(tmp, filePath(id));
      } catch (e) { out.destroy(); await rm(tmp, { force: true }); throw e; }
      const record = { id, title: cleanText(title, LIMITS.TITLE_MAX, 'title') || safeName(filename).replace(/\.[^.]+$/, ''), filename: safeName(filename), size, sha256: hash.digest('hex'), state: 'DRAFT', createdAt: now().toISOString(), createdBy: by, captions: emptyCaptions() };
      await serial(async () => { const v = await read(); v.push(record); await write(v); });
      return record;
    },
    /** Edits the title and/or ONE OR BOTH captions; each network keeps its own text. */
    update: (id, { title, tiktok, instagram }, by) => serial(async () => {
      const v = await read(); const r = v.find((x) => x.id === id); if (!r) throw new VideoError('NOT_FOUND', 404); const at = now().toISOString();
      if (title !== undefined) r.title = cleanText(title, LIMITS.TITLE_MAX, 'title') || r.title;
      for (const [net, text] of [['tiktok', tiktok], ['instagram', instagram]]) if (text !== undefined) r.captions[net] = { text: cleanText(text, LIMITS.CAPTION_MAX, `${net}_caption`), updatedAt: at, updatedBy: by };
      await write(v); return r;
    }),
    remove: (id) => serial(async () => { const v = await read(); const i = v.findIndex((x) => x.id === id); if (i < 0) throw new VideoError('NOT_FOUND', 404); v.splice(i, 1); await write(v); await rm(filePath(id), { force: true }); }),
    /** For playback (Range requests): size and a stream over [start, end]. */
    async open(id) { const st = await stat(filePath(id)); return { size: st.size, stream: (start, end) => createReadStream(filePath(id), { start, end }) }; },
  });
}
