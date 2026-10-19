// A child process for the multi-process tests of Social Publishing (not a test file: the glob test/social-*.test.js does not pick it up).
// It is one whole "Nordla process" over a shared data folder: file store, key ring, publisher, and a FAKE platform that records every creating call in a shared log file.
//
//   node test/social-worker.js '<json options>'
//     dir        shared data folder        keyDir    shared key folder (outside `dir`)     log     file receiving one line per creating call
//     nowMs      the clock of the process  goAt      epoch ms: spin until then so that several workers start together
//     crashAfterCall   kill -9 myself right after the creating call was sent (the answer never comes back)
//     hangInCall       the creating call never answers (the parent kills the worker)
//     passes     how many runDue() passes to run (default 1)
//     approve    { id }: instead of publishing, approve one post as the owner and log APPROVED / REFUSED:<code>
//     annotate   { id, n }: instead of publishing, apply n system 'annotate' updates to one post (a writer that is not the publisher)
import { appendFileSync } from 'node:fs';
import { createFileStore } from '../src/social/store.js';
import { createSocialService } from '../src/social/service.js';
import { createPublisher } from '../src/social/publisher.js';
import { createInstagramPublisher } from '../src/social/providers/meta.js';
import { createFileKeyring } from '../src/social/integrity.js';
import { createFakeHttp, credentials, igRoutes, media, ok } from './social-fixtures.js';

const o = JSON.parse(process.argv[2]);
const note = (line) => appendFileSync(o.log, `${line}\n`);
const http = createFakeHttp(igRoutes({
  'POST /media_publish': () => {
    note('PUBLISH_CALL');
    if (o.crashAfterCall) process.kill(process.pid, 'SIGKILL');
    if (o.hangInCall) return new Promise(() => {});
    return ok({ id: 'media-1' });
  },
}));
const publishers = { instagram: createInstagramPublisher({ http, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 30_000, sleep: async () => {}, settleWaitMs: 0 }) };
const clock = () => o.nowMs;
const integrity = createFileKeyring({ keyDir: o.keyDir, dataDir: o.dir });
const service = createSocialService({ store: createFileStore(o.dir, { lock: { waitMs: 60_000 } }), publishers, clock, integrity });
const publisher = createPublisher({ service, publishers, media: media(), clock, logger: () => {}, config: o.config ?? {} });
while (Date.now() < (o.goAt ?? 0)) { /* start barrier */ }
if (o.annotate) {
  const { transition } = await import('../src/social/workflow.js');
  const { SYSTEM_ACTOR } = await import('../src/social/service.js');
  for (let i = 0; i < o.annotate.n; i += 1) await service.store.update(o.annotate.id, (p) => transition(p, 'annotate', SYSTEM_ACTOR, { now: new Date(o.nowMs).toISOString(), note: `w${process.pid}-${i}` }));
  note('WORKER_DONE');
  process.exit(0);
}
if (o.approve) { // the owner's phone approving one post, from another process
  const hash = service.contentHashOf(await service.get(o.approve.id));
  try { await service.act(o.approve.id, 'approve', { id: 'owner:habb', role: 'owner' }, { expected_hash: hash }); note(`APPROVED:${o.approve.id}`); } catch (e) { note(`REFUSED:${e.code}`); }
  process.exit(0);
}
for (let i = 0; i < (o.passes ?? 1); i += 1) await publisher.runDue();
note('WORKER_DONE');
