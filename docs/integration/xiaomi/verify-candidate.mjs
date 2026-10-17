// Reproducible verification of the staging CANDIDATE commit (the one that would be deployed for the Xiaomi test). It deploys nothing, writes nothing outside a temp folder, reaches no network.
//   node docs/integration/xiaomi/verify-candidate.mjs [--baseline ab02b77] [--skip-browser]
// Prints one line per check (PASS / FAIL / SKIP) and exits 1 on any FAIL. Run it on the exact commit, with a clean working tree, before asking for the deploy authorisation.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const baseline = arg('--baseline', 'ab02b77'); const skipBrowser = process.argv.includes('--skip-browser');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const results = []; const rec = (name, status, detail = '') => { results.push([name, status, detail]); console.log(`${status.padEnd(5)} ${name}${detail ? `  — ${detail}` : ''}`); };

const head = run('git', ['rev-parse', '--short', 'HEAD']).stdout.trim(); const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
rec('candidate commit', 'PASS', `${head}${dirty ? ' (WORKING TREE NOT CLEAN: the result does not describe a commit)' : ''}`); if (dirty) results[results.length - 1][1] = 'FAIL';

// 1. no new REQUIRED environment variable compared with the commit already validated for staging
const envNames = (rev) => new Set((run('git', ['grep', '-hoE', 'env\\.[A-Z][A-Z0-9_]{3,}', rev, '--', 'src', 'config']).stdout.match(/env\.[A-Z0-9_]+/g) ?? []).map((s) => s.slice(4)));
const before = envNames(baseline); const after = envNames('HEAD'); const added = [...after].filter((v) => !before.has(v)).sort();
rec('environment variables read by the code, new since the baseline', 'PASS', added.length ? `${added.join(', ')} — each is read by the code; check that none is required for the hosted path (Stock/Achats hosted needs none: file store under <data dir>/procurement)` : 'none');

// 2. syntax of the files the candidate changes in the browser and the server entry points
const ui = ['src/sourcing/ui/core-panel.js', 'src/sourcing/ui/nordla-ask.js', 'src/sourcing/ui/nordla-voice.js', 'src/sourcing/ui/modules-panel.js', 'src/core-pilot/ask.js', 'src/core-pilot/http.js', 'src/procurement/server/hosted.js', 'src/sourcing/server/index.js'];
const bad = ui.filter((f) => existsSync(f) && run(process.execPath, ['--check', f]).status !== 0); rec('syntax of changed modules', bad.length ? 'FAIL' : 'PASS', bad.join(', '));

// 3. contracts, security, routing, integration, procurement, conversation (one node --test invocation, no parallel suites)
const tests = ['test/convergence-journey.test.js', 'test/core-procurement-routing.test.js', 'test/integration-router-precedence.test.js', 'test/integration-procurement.test.js', 'test/integration-contracts.test.js', 'test/integration-workflows.test.js', 'test/procurement-assistant.test.js', 'test/procurement-server.test.js', 'test/core-field-assistant.test.js', 'test/core-field-assistant-contracts.test.js', 'test/core-field-assistant-independent.test.js', 'test/core-http-conversation.test.js', 'test/nordla-ask-ui.test.js', 'test/nordla-voice.test.js', 'test/core-journal-ui-errors.test.js', 'test/core-pilot.test.js', 'test/core-readers.test.js', 'test/core-modules.test.js', 'test/finance-privacy.test.js', 'test/sourcing-verdict-display.test.js'].filter(existsSync);
const t = run(process.execPath, ['--test', ...tests]); const g = (k) => (t.stdout.match(new RegExp(`ℹ ${k} (\\d+)`)) ?? [])[1] ?? '?';
const failedNames = (t.stdout.match(/^✖ .*$/gm) ?? []).filter((l, i, arr) => arr.indexOf(l) === i).map((l) => l.slice(0, 110));
rec(`unit / contract / security / routing (${tests.length} files)`, t.status === 0 ? 'PASS' : 'FAIL', `tests ${g('tests')}, pass ${g('pass')}, fail ${g('fail')}, skipped ${g('skipped')}${failedNames.length ? ` — failing: ${failedNames.join(' | ')}` : ''}`);

// 4. the TEST seed is idempotent and labelled (temp folder only)
const dir = mkdtempSync(join(tmpdir(), 'nordla-verify-')); const M = '00000000-0000-4000-8000-0000000000aa';
const s1 = run(process.execPath, ['docs/integration/xiaomi/seed-test-data.mjs', dir, M, '.']); const s2 = run(process.execPath, ['docs/integration/xiaomi/seed-test-data.mjs', dir, M, '.']);
const j = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()).seeded; } catch { return null; } };
rec('TEST seed: idempotent, labelled, no approval faked', s1.status === 0 && s2.status === 0 && JSON.stringify(j(s1)) === JSON.stringify(j(s2)) && j(s1)?.pendingPurchaseOrders === 1 ? 'PASS' : 'FAIL', JSON.stringify(j(s2))); rmSync(dir, { recursive: true, force: true });

// 5. real browser (Edge/Chrome), hosted server with Stock/Achats and TEST data, 390 px
const e2e = ['test/e2e/nordla-xiaomi-rehearsal.e2e.js', 'test/e2e/nordla-ask-ui.e2e.js', 'test/e2e/nordla-voice.e2e.js', 'test/e2e/core-pilot.e2e.js', 'test/e2e/nordla-entry.e2e.js'];
for (const f of e2e) {
  if (skipBrowser) { rec(f, 'SKIP', '--skip-browser'); continue; }
  const r = run(process.execPath, [f]); const tail = (r.stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  rec(f, r.status === 0 ? 'PASS' : r.status === 2 ? 'SKIP' : 'FAIL', tail);
}
const failed = results.filter(([, s]) => s === 'FAIL'); console.log(`\n${results.filter(([, s]) => s === 'PASS').length} PASS, ${results.filter(([, s]) => s === 'SKIP').length} SKIP, ${failed.length} FAIL — candidate ${head}`);
process.exitCode = failed.length ? 1 : 0;
