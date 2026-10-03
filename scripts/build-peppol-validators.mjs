// Build step (run by a developer when a new official release is adopted): ISO Schematron (.sch, from docs.peppol.eu) -> XSLT -> Saxon-JS SEF.
// The business rules are the OFFICIAL ones (CEN EN 16931 + Peppol BIS Billing 3.0.x); nothing is re-implemented here.
//   node scripts/build-peppol-validators.mjs
// Inputs : vendor/peppol-bis-<version>/src/*.sch   (official Schematron)   vendor/iso-schematron/*.xsl (ISO Schematron reference implementation)
// Outputs: vendor/peppol-bis-<version>/*.sef.json (compiled validators) and vendor/peppol-bis-<version>/ARTIFACTS.json (SHA-256 of sources and outputs)
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifiedArtifacts } from '../src/finance/validation-artifacts.js';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const SaxonJS = require('saxon-js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.argv[2] ?? '3.0.21'; const dir = join(root, 'vendor', `peppol-bis-${VERSION}`); const iso = join(root, 'vendor', 'iso-schematron'); const tmp = join(root, '.tmp-build');
const sha = (b) => createHash('sha256').update(b).digest('hex');
// FAIL CLOSED: the official sources this build starts from are verified against the pinned manifest first (a modified or missing source stops the build).
verifiedArtifacts({ vendorDir: join(root, 'vendor') + '/', version: VERSION });
mkdirSync(tmp, { recursive: true });
const xslt3 = (xsl, out) => { const r = spawnSync(process.execPath, [require.resolve('xslt3'), `-xsl:${xsl}`, `-export:${out}`, '-nogo'], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`xslt3 failed for ${xsl}: ${r.stderr || r.stdout}`); };
const run = (sef, sourceFileName) => SaxonJS.transform({ stylesheetFileName: sef, sourceFileName, destination: 'serialized' }, 'sync').principalResult;

const STEPS = ['iso_dsdl_include', 'iso_abstract_expand', 'iso_svrl_for_xslt2']; const compiled = Object.fromEntries(STEPS.map((n) => { const out = join(tmp, `${n}.sef.json`); xslt3(join(iso, `${n}.xsl`), out); return [n, out]; }));
const outputs = {}; const sources = {};
for (const f of readdirSync(join(dir, 'src')).filter((x) => x.endsWith('.sch'))) {
  const name = f.replace(/\.sch$/, ''); let current = join(dir, 'src', f); sources[f] = sha(readFileSync(current));
  // iso_dsdl_include only resolves <include>/<extends> references: the official files use none (checked), and Saxon-JS overflows its stack on the 300 KB CEN file, so the step is skipped when there is nothing to include.
  const needsInclude = /<(?:sch:)?include|xi:include|<(?:sch:)?extends/.test(readFileSync(current, 'utf8'));
  STEPS.filter((n) => needsInclude || n !== 'iso_dsdl_include').forEach((n, i) => { const xml = run(compiled[n], current); current = join(tmp, `${name}.${i}.xml`); writeFileSync(current, xml); });
  const finalSef = join(dir, `${name}.sef.json`); xslt3(current, finalSef); outputs[`${name}.sef.json`] = sha(readFileSync(finalSef));
}
// The compiled stylesheets are NOT byte-reproducible (Saxon embeds build-specific data): the committed bytes are what is pinned. After a deliberate rebuild run scripts/pin-validation-artifacts.mjs
// and update PINNED_MANIFEST_SHA256 in src/finance/validation-artifacts.js in the same commit.
void sources; void outputs;
rmSync(tmp, { recursive: true, force: true });
console.log('built', Object.keys(outputs).join(', '));
