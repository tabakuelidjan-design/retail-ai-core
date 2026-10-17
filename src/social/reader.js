// A READ-ONLY view of Social Publishing for the Nordla Core screen. It reads the posts directory of the Social Publishing app (the one `npm run social` writes) and returns
// counts by state - never a caption, a token, a key or an approval. It imports no publisher, no credential port and no store: it cannot approve, schedule or publish, and it
// writes nothing. Social Publishing keeps running as its own app (its owner approval is a signed record made in that app); this only tells the truth about it on the shared screen.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {{ dir: string, mode?: string }} cfg  dir = the Social Publishing data directory (SOCIAL_DATA_DIR); mode = SOCIAL_MODE (none | simulate | live)
 * @returns {{ summary(): Promise<{ configured: boolean, mode: string, total: number, by_state: Record<string, number>, awaiting_owner: number, next_due: string|null, error: string|null }> }}
 */
export function createSocialReader({ dir, mode = 'none' }) {
  return {
    async summary() {
      const base = { configured: true, mode: mode || 'none', total: 0, by_state: {}, awaiting_owner: 0, next_due: null, error: null };
      let names;
      try { names = (await readdir(join(dir, 'posts'))).filter((n) => n.endsWith('.json')); } catch (e) {
        if (e.code === 'ENOENT') return base; // the app was never started: nothing to show, said as zero posts
        return { ...base, error: 'POSTS_UNREADABLE' };
      }
      let next = null;
      for (const n of names) {
        let p; try { p = JSON.parse(await readFile(join(dir, 'posts', n), 'utf8')); } catch { base.error = 'SOME_POSTS_UNREADABLE'; continue; }
        const state = typeof p.state === 'string' ? p.state : 'UNKNOWN';
        base.total += 1; base.by_state[state] = (base.by_state[state] ?? 0) + 1;
        if (state === 'READY_FOR_REVIEW') base.awaiting_owner += 1;
        if (state === 'SCHEDULED' && typeof p.publish_at === 'string' && (next === null || p.publish_at < next)) next = p.publish_at;
      }
      base.next_due = next;
      return base;
    },
  };
}
