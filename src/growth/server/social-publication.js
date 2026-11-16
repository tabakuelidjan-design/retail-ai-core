// Growth > Abonnés: READ-ONLY view of the posts Publication sociale holds for this merchant's tests (data/local/social/posts/*.json, or the injected `list`). It writes nothing, approves
// nothing, schedules nothing, publishes nothing and returns no caption, token or approval: only the state, the dates, the ids and the versions (src/growth/social/publication.js).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { publicationForTest } from '../social/publication.js';

export const filePosts = (dir = 'data/local/social') => async () => {
  let names; try { names = (await readdir(join(dir, 'posts'))).filter((n) => n.endsWith('.json')); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  const out = []; for (const n of names) { try { out.push(JSON.parse(await readFile(join(dir, 'posts', n), 'utf8'))); } catch { /* one unreadable post never hides the others */ } }
  return out;
};

/** @param {{ list: () => Promise<object[]>, merchantId?: string|null, acceptSimulated?: boolean, appUrl?: string|null }} p */
export function createPublicationSource({ list, merchantId = null, acceptSimulated = false, appUrl = null }) {
  const merchantRef = merchantId ? createHash('sha256').update(String(merchantId)).digest('hex') : null;
  return async function forItems(items) {
    let posts; try { posts = await list(); } catch { return new Map([...items].map((i) => [i.id, { stage: 'unavailable' }])); }
    const out = new Map();
    for (const i of items) {
      const pub = publicationForTest(posts, { merchantRef, testId: i.id, network: i.evidence.network, accountId: i.evidence.accountId }, { acceptSimulated });
      if (pub) out.set(i.id, appUrl && pub.socialPostId ? { ...pub, openUrl: appUrl } : pub); // the app has no link to one post (its address carries the owner's token in the fragment: never added here): the link opens its calendar
    }
    return out;
  };
}
