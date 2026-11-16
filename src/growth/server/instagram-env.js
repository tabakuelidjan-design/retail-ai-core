// The real Instagram reader, only when the operator has provided a token and a Graph version in the environment (names from docs/runbooks/social-go-live.md); otherwise null and the import file is used.
// The token is read here and handed to the loader as a function: it is never logged, never in a payload. Follower snapshots go to a local file (data/local/marketing/instagram-followers.json): our own readings, nothing written to Instagram.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInstagramInsightsLoader, fetchHttp } from './instagram-insights.js';

export const SNAPSHOT_FILE = 'data/local/marketing/instagram-followers.json';
export const fileSnapshots = (path = SNAPSHOT_FILE) => ({
  read: async () => { try { const j = JSON.parse(await readFile(path, 'utf8')); return Array.isArray(j) ? j.filter((x) => x && typeof x.date === 'string' && Number.isFinite(x.total)) : []; } catch { return []; } },
  write: async (list) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(list)); },
});
export function instagramLoaderFromEnv(env, { http = fetchHttp() } = {}) {
  const token = env.SOCIAL_INSTAGRAM_TOKEN; const graphVersion = env.INSTAGRAM_GRAPH_API_VERSION;
  if (!token || !graphVersion) return null;
  return createInstagramInsightsLoader({ http, getToken: () => token, graphVersion, snapshots: fileSnapshots() });
}
