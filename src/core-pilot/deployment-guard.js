// What the Core journal's guarantees REQUIRE of the place it runs (docs/integration/core-journal-reliability.md, "Deployment requirements").
//
// Two guarantees come from the platform, not from the code, and the code refuses to run without the one it can check:
//   durability   : on Railway the container disk is erased at every deploy. The journal is durable only on an attached VOLUME
//                  (RAILWAY_VOLUME_MOUNT_PATH, documented by Railway). A data directory outside it is refused: the Core would "record" decisions it will lose.
//   one writer   : Railway documents that "Replicas cannot be used with volumes" and that it prevents several deployments from being mounted on the same service,
//                  so one service has one writer. The code cannot see a SECOND service that someone attaches to the same files; the journal then detects it
//                  (stale head, lock) but does not prevent it. That limit is stated in the runbook.
// Off Railway (a PC, another host) the operator carries both guarantees; nothing is refused here.
import { resolve, sep } from 'node:path';

const onRailway = (env) => Boolean(String(env.RAILWAY_SERVICE_ID ?? env.RAILWAY_ENVIRONMENT_ID ?? env.RAILWAY_PROJECT_ID ?? '').trim());
const inside = (dir, root) => { const d = resolve(dir); const r = resolve(root); return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep); };

/** @returns {{ ok: true, platform: string } | { ok: false, code: string, reason: string }} */
export function checkJournalDeployment({ env = process.env, dir }) {
  if (!onRailway(env)) return { ok: true, platform: 'OTHER_HOST_OPERATOR_CARRIES_THE_GUARANTEES' };
  const mount = String(env.RAILWAY_VOLUME_MOUNT_PATH ?? '').trim();
  if (!mount) return { ok: false, code: 'JOURNAL_NOT_ON_A_VOLUME', reason: 'Railway service without a volume: the container disk is erased at every deploy, so decisions would be recorded and then lost. Attach a volume and point SOURCING_DATA_DIR into it.' };
  if (!inside(dir, mount)) return { ok: false, code: 'JOURNAL_NOT_ON_A_VOLUME', reason: `the data directory (${dir}) is outside the attached volume (${mount}): it would not survive a deploy` };
  return { ok: true, platform: 'RAILWAY_VOLUME' };
}
