// Google Business Profile post drafts, their approval and their (manual) publication record. PURE data + a small append-only store: nothing here talks to Google.
//
// A draft's VERSION is the sha-256 of its text, its call to action and its image bytes. An approval is bound to ONE version: any change to the text, the button or the image
// gives another version, and the approval no longer applies (it must be given again). The state of a draft is derived from its events, never stored.
//   À examiner   no approval for the current version
//   Approuvé     the owner approved THIS version
//   Publié       the owner attested that he published this approved version himself (copy / paste into his listing): Nordla cannot post to Google (no API access)
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE = Object.freeze({ REVIEW: 'REVIEW', APPROVED: 'APPROVED', PUBLISHED: 'PUBLISHED' });
export const STATE_FR = Object.freeze({ REVIEW: 'À examiner', APPROVED: 'Approuvé', PUBLISHED: 'Publié (attesté par vous)' });
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** @param {{ dir: URL|string }} o dir = the folder holding drafts.json and the images */
export async function loadDrafts({ dir }) {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir);
  const cfg = JSON.parse(await readFile(join(root, 'drafts.json'), 'utf8'));
  const out = [];
  for (const d of cfg.drafts) {
    const imageBytes = await readFile(join(root, d.image));
    out.push({ ...d, imageSha: sha(imageBytes), imageBytes, version: sha(JSON.stringify({ text: d.text, cta: d.cta?.label ?? null, image: sha(imageBytes) })) });
  }
  return { network: cfg.network, listing: cfg.listing, source: cfg.source, drafts: out };
}

const EVENTS = new Set(['approve', 'revoke', 'published']);
export const stateOf = (events, draft) => {
  let state = STATE.REVIEW; let info = {};
  for (const e of events.filter((x) => x.draft === draft.id)) {
    if (e.type === 'approve' && e.version === draft.version) { state = STATE.APPROVED; info = { approvedAt: e.at, approvedBy: e.by, publishedAt: null, publishedUrl: null }; }
    else if (e.type === 'revoke') { state = STATE.REVIEW; info = {}; }
    else if (e.type === 'published' && state === STATE.APPROVED && e.version === draft.version) { state = STATE.PUBLISHED; info = { ...info, publishedAt: e.at, publishedBy: e.by, publishedUrl: e.url ?? null }; }
  }
  return { state, ...info };
};

/** Append-only JSON store under <dataDir>/gbp-drafts/<merchant>/events.json (atomic write). */
export function createDraftStore({ dataDir, merchantId }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(merchantId))) throw new TypeError('invalid merchant id');
  const base = resolve(dataDir, 'gbp-drafts', String(merchantId)); const file = join(base, 'events.json');
  if (!(base + sep).startsWith(resolve(dataDir) + sep)) throw new TypeError('invalid data dir');
  let chain = Promise.resolve();
  const read = async () => { try { const j = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(j.events) ? j.events : []; } catch { return []; } };
  return Object.freeze({
    list: read,
    /** Appends one event (serialised: two clicks never interleave). */
    append(event) {
      if (!EVENTS.has(event.type)) throw new TypeError('unknown event');
      const run = chain.then(async () => {
        const events = await read(); const e = { id: randomUUID(), ...event, at: event.at ?? new Date().toISOString() }; events.push(e);
        await mkdir(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify({ version: 1, events }, null, 1)); await rename(tmp, file); return e;
      });
      chain = run.catch(() => {}); return run;
    },
  });
}
