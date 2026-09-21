import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Repository-wide privacy/secret scan. It covers every file that is tracked OR untracked-but-not-ignored (i.e. everything that
// could be committed next), so a leak is caught before it is committed. Patterns are assembled from parts so this file does not
// match its own rules.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' });
const files = git('ls-files --cached --others --exclude-standard').split('\n').filter(Boolean);
const textFiles = files.filter((f) => !/\.(png|jpe?g|pdf|xlsx|ico|woff2?)$/i.test(f) && !f.endsWith('package-lock.json'));
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const contents = new Map(textFiles.map((f) => [f, read(f)]));

const PATTERNS = {
  'a 64-character hex string (hash or key)': /\b[0-9a-f]{64}\b/,
  'a Shopify token': new RegExp(`shp${'(at|ca|ss)'}_[A-Za-z0-9]{16,}`),
  'a live payment key': new RegExp(`sk_${'live'}_`),
  'a private key block': new RegExp(`-----${'BEGIN'} [A-Z ]*PRIVATE KEY`),
  'a JWT': /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
};

test('no secrets, keys, tokens or hashes anywhere that could be committed', () => {
  for (const [label, rx] of Object.entries(PATTERNS)) {
    const hits = [...contents.entries()].filter(([, t]) => rx.test(t)).map(([f]) => f);
    assert.deepEqual(hits, [], `${label} found in: ${hits.join(', ')}`);
  }
});

test('the only emails, company numbers and IBANs in the repository are synthetic', () => {
  const emailOk = (e) => /(\.example|@example\.com|users\.noreply\.github\.com)$/i.test(e);
  const vatOk = (v) => /^BE ?0000000\d{3}$/.test(v) || v === 'BE0123456789';
  const entOk = (v) => /^0000\.000\.\d{3}$/.test(v) || v === '0123.456.789';
  const ibanOk = (v) => ['BE00 0000 0000 0000', 'BE68 5390 0754 7034', 'BE68539007547034'].includes(v) || vatOk(v.replace(/\s/g, ''));
  const bad = [];
  for (const [f, t] of contents) {
    for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!emailOk(m[0])) bad.push(`${f}: email ${m[0]}`);
    for (const m of t.matchAll(/\bBE ?0?\d{9,10}\b/g)) if (!vatOk(m[0])) bad.push(`${f}: VAT number ${m[0]}`);
    for (const m of t.matchAll(/\b[01]\d{3}\.\d{3}\.\d{3}\b/g)) if (!entOk(m[0])) bad.push(`${f}: enterprise number ${m[0]}`);
    for (const m of t.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}\b/g)) if (!ibanOk(m[0])) bad.push(`${f}: IBAN ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('no real invoice, company, customer or local finance configuration is committable', () => {
  const forbidden = files.filter((f) => /(^|\/)\.env$/.test(f) || /^data\/local\//.test(f) || /^reports\//.test(f) || /\.(pdf|xlsx)$/i.test(f) || /\.ubl\.xml$/i.test(f) || /(^|\/)merchant(\.[a-z]+)?\.json(\.bak|\.tmp)?$/.test(f) || /sync-coverage\.json/.test(f) || /audit\.log/.test(f) || /(^|\/)logo\.(png|jpe?g)$/i.test(f));
  assert.deepEqual(forbidden, []);
  for (const p of ['data/local/finance/merchant.json', 'data/local/finance/merchant.json.bak', 'data/local/finance/logo.png', 'data/local/finance/audit.log', 'data/local/sync-coverage.json', 'reports/finance/invoice.pdf', 'reports/finance/x.xlsx', '.env']) {
    assert.doesNotThrow(() => git(`check-ignore -q ${p}`), `${p} must be gitignored`);
  }
});

test('.env.example documents secret names but never carries a value', () => {
  const lines = read('.env.example').split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
  const secretish = lines.filter((l) => /(SECRET|KEY|TOKEN|PASSWORD)/.test(l.split('=')[0]));
  assert.ok(secretish.length >= 3);
  for (const l of secretish) assert.equal(l.split('=').slice(1).join('='), '', `${l.split('=')[0]} must be empty in .env.example`);
  for (const name of ['CUSTOMER_HASH_KEY', 'FINANCE_DASHBOARD_TOKEN']) assert.ok(lines.some((l) => l.startsWith(`${name}=`)), `${name} is documented`);
});

test('the dashboard never sends a secret to the browser: token is only compared server-side, settings hold no secret fields', () => {
  const ui = contents.get('src/finance/ui/app.js');
  assert.ok(!/FINANCE_DASHBOARD_TOKEN|process\.env|CUSTOMER_HASH_KEY|SERVICE_ROLE|client_secret/i.test(ui.replace(/\/\/.*$/gm, '').replace(/'[^']*FINANCE_DASHBOARD_TOKEN[^']*'/g, '')));
  const settings = contents.get('src/finance/settings.js');
  assert.ok(!/(TOKEN|SECRET|PASSWORD)\s*:/i.test(settings.replace(/\/\/.*$/gm, '')));
  const app = contents.get('src/finance/server/app.js');
  assert.ok(!/console\.(log|info)\(.*token/i.test(app));
});
