#!/usr/bin/env node
// Controlled recovery of the Core decision journal (docs/integration/core-journal-reliability.md). A PERSON runs this, with the service STOPPED.
//
//   node tools/core-journal-recover.mjs diagnose <journal.jsonl> [merchantId]                   read-only: OK | TORN_TAIL | CORRUPT | MISSING, with the exact line and offset
//   node tools/core-journal-recover.mjs prepare  <journal.jsonl> <merchantId> <newOutDir>        copies the original, quarantines the torn tail, writes a verified candidate + manifest
//   node tools/core-journal-recover.mjs verify   <outDir> <merchantId>                           re-checks hashes, chain and prefix; prints the confirmation code
//   node tools/core-journal-recover.mjs apply    <journal.jsonl> <outDir> <merchantId> --confirm <code>
//                                                keeps `<journal>.replaced-<time>`, then replaces the journal by the candidate with one atomic rename
//
// Nothing is repaired, truncated or deleted by the Core itself. Only a torn last line can be prepared; any other damage needs a human investigation.
import { applyRecovery, diagnoseJournal, prepareRecovery, verifyRecovery } from '../src/core-pilot/journal-recovery.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const print = (o) => console.log(JSON.stringify(o, null, 2));
const usage = () => { console.error('usage: diagnose <journal> [merchant] | prepare <journal> <merchant> <outDir> | verify <outDir> <merchant> | apply <journal> <outDir> <merchant> --confirm <code>'); process.exit(2); };

try {
  if (cmd === 'diagnose' && args[0]) { const d = await diagnoseJournal(args[0], args[1] ?? null); print(d); process.exit(d.status === 'OK' ? 0 : 1); }
  else if (cmd === 'prepare' && args.length >= 3) { const m = await prepareRecovery({ file: args[0], merchantId: args[1], outDir: args[2] }); print({ prepared: true, outDir: args[2], events_kept: m.candidate.events, quarantined_bytes: m.quarantined_tail.bytes, next: 'run verify, stop the service, then apply with the confirmation code' }); }
  else if (cmd === 'verify' && args.length >= 2) { const v = await verifyRecovery({ outDir: args[0], merchantId: args[1] }); print({ ok: v.ok, events: v.events, head: v.head, quarantined_bytes: v.quarantined_bytes, confirmation_code: v.confirmation_code }); }
  else if (cmd === 'apply' && args.length >= 3 && flag('--confirm')) { print(await applyRecovery({ file: args[0], outDir: args[1], merchantId: args[2], confirm: flag('--confirm') })); }
  else usage();
} catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exit(1); }
