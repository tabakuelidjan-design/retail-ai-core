#!/usr/bin/env node
// Runs ONE real supplier quote (a text file) through the Field V1 pipeline and prints what the app will show: extracted facts with provenance, what is UNKNOWN, conflicts, and - with the numbers YOU pass -
// deal, evidence completeness, questions to ask, negotiation. Nothing is invented: a number you do not pass stays UNKNOWN. Read-only: no case is saved, no network, no provider.
//   node tools/real-quote-check.mjs quote.txt [--source quote|chat] [--supplier "Name"] [--product "Name"] [--qty 1000] [--price 19.9 --vat 21 --target 55] [--freight 620] [--duty 2.7] [--fx 0.92] [--merchant habb]
import { readFileSync } from 'node:fs';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { offerDraft } from '../src/sourcing/core/field/offer-import.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { loadMerchantProfile } from '../src/sourcing/server/merchant-profile.js';
const [file, ...rest] = process.argv.slice(2); if (!file) { console.log('usage: node tools/real-quote-check.mjs quote.txt [options]'); process.exit(2); }
const o = {}; for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, '')] = rest[i + 1];
const now = new Date(); const text = readFileSync(file, 'utf8'); const root = new URL('..', import.meta.url).pathname;
const { profile } = await loadMerchantProfile(o.merchant ? { SOURCING_MERCHANT_ID: o.merchant } : process.env, root);
let c = newCase({ id: 'real-quote', name: o.product ?? '', now }); const ev = [];
if (o.supplier) ev.push({ type: 'SUPPLIER', supplier: { name: o.supplier } }); if (o.qty) ev.push({ type: 'PLAN_QTY', qty: Number(o.qty) });
if (o.price) ev.push({ type: 'SALE', sale: { sellingPriceGross: o.price, vatRatePct: o.vat ?? 21, ...(o.target ? { targetContributionPct: o.target } : {}), priceBasis: 'TARGET' } });
if (o.freight || o.fx) ev.push({ type: 'COSTS', costs: { ...(o.fx ? { fx: { rate: o.fx, date: now.toISOString().slice(0, 10), source: 'USER_ENTERED' } } : {}), costs: o.freight ? { freight: { total: o.freight, status: 'ESTIMATED' } } : {} } });
if (o.duty) ev.push({ type: 'CUSTOMS', customs: { duty: { ratePct: o.duty, kind: 'USER_ENTERED', source: 'owner' } } });
for (const e of ev) c = dispatch(c, e, now);
c = dispatch(c, { type: 'OFFER_IMPORT', source: o.source === 'chat' ? 'CHAT' : 'PASTED_QUOTE', text, meNames: ['Me', 'Moi'] }, now);
const d = offerDraft(c, c.offers[0].id); const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
console.log(`\n== EXTRACTED (${d.fields.length} facts; all SUPPLIER_CLAIM, none reviewed) ==`); for (const f of d.fields) console.log(`${f.needsCorrection ? '!' : ' '} ${f.key.padEnd(24)} ${show(f.value ?? '(needs correction)').padEnd(34)} « ${f.rawText} » [${f.status}${f.speaker !== 'supplier' ? `, speaker ${f.speaker}` : ''}${f.flags.length ? `, ${f.flags.join('/')}` : ''}]`);
console.log(`\n== UNKNOWN (not in the quote) ==\n${d.unknown.map((u) => u.key).join(', ') || '-'}\n== NOT UNDERSTOOD ==\n${d.unparsed.join(' | ') || '-'}`);
for (const f of d.fields) if (f.review.state === 'PENDING' && !f.needsCorrection && f.speaker === 'supplier') { try { c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: f.id }, now); } catch { /* left pending */ } }
const e = createFieldEngine({ profile, externals: () => ({}), now: () => now }); const v = e.caseView(c);
console.log(`\n== AFTER CONFIRMING THE CLEAN FACTS (a person must still review; ambiguous ones stay pending) ==\nconflicts: ${c.conflicts.filter((x) => x.state === 'OPEN').map((x) => x.key).join(', ') || 'none'}; still pending: ${c.candidates.filter((x) => x.state === 'PROPOSED').length}`);
console.log(`landed: ${v.deal.landed.display ?? `UNKNOWN (${v.deal.landed.reason})`}; max purchase price: ${v.deal.maxPurchasePrice.display ?? `UNKNOWN (${v.deal.maxPurchasePrice.reason})`}; target: ${v.deal.targetPurchasePrice.display ?? v.deal.targetPurchasePrice.status}; margin: ${v.deal.margin.pct === null ? 'UNKNOWN' : `${(v.deal.margin.pct * 100).toFixed(1)}%`}`);
console.log(`evidence completeness: ${v.evidenceStatus.evidenceCompleteness}; blocking: ${v.evidenceStatus.blocking.join(' | ') || 'none'}`);
console.log(`recommendation (this offer alone, pending approval): ${v.recommendation.value} - ${v.recommendation.why}`);
console.log(`\n== ASK NEXT ==\n${v.askNow.items.map((i) => `${i.rank}. [${i.kind}] ${i.en}`).join('\n') || '-'}`);
console.log(`\n== NEGOTIATION (${v.negotiation.status}) ==\n${v.negotiation.askNow.map((l) => `- ${l.ask}`).join('\n') || '-'}${v.negotiation.missingForTarget.length ? `\nmissing for a target: ${v.negotiation.missingForTarget.join(', ')}` : ''}`);
console.log(`\nfit: ${v.merchantFit.label} (${v.merchantFit.counts.supported} yes, ${v.merchantFit.counts.partial} partly, ${v.merchantFit.counts.unknown} unknown)${profile ? '' : ' - no merchant profile loaded'}`);
