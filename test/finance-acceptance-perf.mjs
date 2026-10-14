// Measurement (not a pass/fail test): node test/finance-acceptance-perf.mjs   (memory store; the PostgreSQL measurement is a control in test/pg/90-acceptance.pg.test.js)
import { accWorld, MERCHANT_ACTOR } from './finance-acceptance-world.js';

export async function measure(w, n = 20) {
  const t = async (fn) => { const a = performance.now(); const r = await fn(); return [performance.now() - a, r]; }; const ms = (x) => Math.round(x);
  const issue = []; const invs = []; for (let i = 0; i < n; i++) { const [d, inv] = await t(() => w.invoice1000()); issue.push(d); invs.push(inv); }
  const pay = []; for (const inv of invs) pay.push((await t(() => w.receive(40000, [[inv.id, 40000]])))[0]);
  const [treasury] = await t(() => w.treasury().model()); const [exportMeta] = await t(() => w.pkg()); const [exportDocs] = await t(() => w.pkg(undefined, { includeDocuments: true }));
  const doc = await w.st.getDocument(invs[0].id); const [queue] = await t(() => w.peppol.queue(doc, { actor: MERCHANT_ACTOR }));
  const sorted = [...issue].sort((a, b) => a - b); const p = (q) => ms(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return { invoices: n, issueMs: { p50: p(0.5), p95: p(0.95), max: ms(sorted.at(-1)) }, paymentMsAvg: ms(pay.reduce((s, x) => s + x, 0) / pay.length), treasuryModelMs: ms(treasury), exportMetadataMs: ms(exportMeta), exportWithDocumentsMs: ms(exportDocs), peppolQueueMs: ms(queue) };
}
if (process.argv[1]?.endsWith('finance-acceptance-perf.mjs')) console.log(JSON.stringify(await measure(accWorld()), null, 1));
