#!/usr/bin/env node
// Finance Operations CLI. Prepares, validates, calculates, produces PDFs. Approval and sending are MERCHANT actions:
// they require FINANCE_ACTOR=merchant:<name> in the environment (the default actor is the agent, which cannot approve).
// Nothing is ever transmitted externally. Output is JSON on stdout; files go to reports/finance/ (gitignored).
//
//   node --env-file=.env src/finance/cli.js <command> [options]      (see `help`)

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { addDays } from '../metrics/windows.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { buildAccountantPack } from './accountant-pack.js';
import { createCompanyLookup, createViesProvider, ManualProvider, normalizeBelgianNumber } from './company.js';
import { orderTotalsFromLedger } from './linking.js';
import { renderDocumentPdf } from './pdf.js';
import { prepareTransmission } from './peppol.js';
import { buildReceivables } from './receivables.js';
import { loadDocsForReports, writePackFiles } from './reports.js';
import { createFinanceService } from './service.js';
import { createSupabaseFinanceStore } from './supabase-store.js';
import { formatCents } from './money.js';

const CONFIG_PATH = 'data/local/finance/merchant.json';
const OUT_DIR = 'reports/finance';

export const TEMPLATE = {
  _README: 'Merchant-local finance configuration. Fill every null. Never commit this file (data/local/ is gitignored).',
  seller: { name: null, vatNumber: null, enterpriseNumber: null, iban: null, bic: null, email: null, address: { street: null, postalCode: null, city: null, countryCode: 'BE' } },
  vat: { allowedRatesBp: [], _note: 'OWNER_DECISION_REQUIRED: the VAT rates (in basis points, e.g. 2100 = 21%) you allow on domestic documents. Empty = nothing can be issued.' },
  defaults: { currency: 'EUR', language: 'fr', paymentTermsDays: 30, paymentTerms: null },
  numbering: { invoice: { prefix: 'INV', pad: 4 }, credit_note: { prefix: 'CN', pad: 4 }, quote: { prefix: 'QT', pad: 4 }, format: '{prefix}-{year}-{seq}' },
  branding: { logoPath: null, footer: null, accent: '#183247', structuredCommunication: true, paymentInstructions: null },
  companyLookup: { provider: 'manual', _note: "'manual' (default) or 'vies' (official EU VAT service, free; contacted only when you run `company lookup`)" },
  peppol: { defaultBuyerReference: 'document_number' },
  linking: { dupWindowDays: 3, toleranceCents: 1 },
};

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];
const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? (args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1]) : undefined; };
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));

function actor() {
  const raw = process.env.FINANCE_ACTOR ?? '';
  const [type, id] = raw.split(':');
  return type === 'merchant' && id ? { type: 'merchant', id } : { type: 'agent', id: 'finance-agent' };
}
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function boot() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`${CONFIG_PATH} not found. Run: finance init-config`);
  const local = await readJson(CONFIG_PATH);
  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  if (!merchant) throw new Error('No merchant found - run the sync first.');
  const retailConfig = mergeConfig(existsSync('data/local/marketing-policy.json') ? await readJson('data/local/marketing-policy.json') : {});
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const store = createSupabaseFinanceStore(supabase, { merchantId: merchant.id });
  let cache = null;
  const loadRetail = async (sinceDate) => {
    if (cache) return cache;
    const since = new Date(`${sinceDate ?? addDays(new Date().toISOString().slice(0, 10), -400)}T00:00:00Z`);
    const data = await loadDataset(supabase, merchant.id, { since });
    cache = { data, ledger: buildLedger(data, { config: retailConfig }) };
    return cache;
  };
  const config = { merchantId: merchant.id, seller: local.seller, vat: local.vat, defaults: local.defaults, numbering: local.numbering, linking: local.linking };
  const svc = createFinanceService({ store, config, ledgerProvider: async () => (await loadRetail()).ledger });
  return { local, store, svc, config, retailConfig, timeZone, loadRetail, merchant };
}

async function main() {
  if (!cmd || cmd === 'help') return out({ commands: ['init-config', 'config-check', 'company lookup --vat <n>', 'company add --file f.json', 'orders [--days 30]', 'doc create --file f.json', 'doc check <id>', 'doc submit <id>', 'doc decide <id> --approve|--modify|--reject [--note t]', 'doc mark-sent <id>', 'doc show <id>', 'doc list [--type t]', 'doc pdf <id>', 'doc ubl <id>', 'quote send <id>', 'quote accept <id>', 'quote reject <id>', 'quote convert <id>', 'credit-note create <invoiceId> --reason t [--file lines.json]', 'payment add <invoiceId> --amount 12.34 --date YYYY-MM-DD [--method m] [--ref r]', 'receivables', 'pack --from YYYY-MM-DD --to YYYY-MM-DD [--delimiter ;]'], approvalNote: 'approve/send need FINANCE_ACTOR=merchant:<name>' });

  if (cmd === 'init-config') {
    if (existsSync(CONFIG_PATH)) return out({ status: 'EXISTS', path: CONFIG_PATH, note: 'not overwritten' });
    await mkdir('data/local/finance', { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(TEMPLATE, null, 2));
    return out({ status: 'CREATED', path: CONFIG_PATH, next: 'fill the null values (seller details, IBAN, allowed VAT rates)' });
  }

  const ctx = await boot();
  const { svc, store, local } = ctx;
  const me = actor();
  const id = args[2];

  if (cmd === 'config-check') {
    const missing = [];
    for (const k of ['name', 'vatNumber', 'enterpriseNumber', 'iban', 'email']) if (!local.seller?.[k]) missing.push(`seller.${k}`);
    for (const k of ['street', 'postalCode', 'city', 'countryCode']) if (!local.seller?.address?.[k]) missing.push(`seller.address.${k}`);
    if (!local.vat?.allowedRatesBp?.length) missing.push('vat.allowedRatesBp (OWNER_DECISION_REQUIRED)');
    if (local.seller?.vatNumber && !normalizeBelgianNumber(local.seller.vatNumber).ok) missing.push('seller.vatNumber (checksum invalid)');
    return out({ ready: missing.length === 0, missing });
  }

  if (cmd === 'company') {
    if (sub === 'lookup') {
      const lookup = createCompanyLookup(local.companyLookup?.provider === 'vies' ? [createViesProvider(), ManualProvider] : [ManualProvider]);
      const r = await lookup.lookup({ vatNumber: flag('vat'), enterpriseNumber: flag('enterprise'), name: flag('name') });
      return out(r);
    }
    if (sub === 'add') { const c = await readJson(flag('file')); return out(await store.saveCompany({ ...c, merchantId: ctx.merchant.id })); }
  }

  if (cmd === 'orders') {
    const { ledger } = await ctx.loadRetail();
    const days = Number(flag('days') ?? 30);
    const cutoff = Date.now() - days * 86400000;
    const totals = orderTotalsFromLedger(ledger);
    return out([...totals.values()].filter((t) => t.at.getTime() >= cutoff).sort((a, b) => b.at - a.at).map((t) => ({ sourceOrderId: t.orderId, date: t.at.toISOString().slice(0, 10), total_incl_tax: formatCents(t.grossCents), refunded: formatCents(t.refundedCents) })));
  }

  if (cmd === 'doc') {
    if (sub === 'create') {
      const input = await readJson(flag('file'));
      if (input.customerCompanyId) { const c = await store.getCompany(input.customerCompanyId); if (c) input.customer = { ...c, companyId: c.id }; }
      const doc = await svc.create(input, me);
      return out({ id: doc.id, status: doc.status, totals: doc.totals && { net: formatCents(doc.totals.netCents), vat: formatCents(doc.totals.vatCents), gross: formatCents(doc.totals.grossCents) }, readiness: await svc.readiness(doc) });
    }
    if (sub === 'check') return out(await svc.readiness(await svc.get(id)));
    if (sub === 'submit') return out(brief(await svc.submit(id, me)));
    if (sub === 'decide') {
      const decision = flag('approve') ? 'APPROVE' : flag('modify') ? 'MODIFY' : flag('reject') ? 'REJECT' : null;
      if (!decision) throw new Error('choose --approve, --modify or --reject');
      return out(brief(await svc.decide(id, decision, me, typeof flag('note') === 'string' ? flag('note') : undefined)));
    }
    if (sub === 'mark-sent') return out(brief(await svc.markSent(id, me, typeof flag('channel') === 'string' ? flag('channel') : 'manual')));
    if (sub === 'show') { const v = await svc.view(id); return out({ ...v, events: await svc.events(id) }); }
    if (sub === 'list') {
      const docs = await store.listDocuments({ merchantId: ctx.merchant.id, type: typeof flag('type') === 'string' ? flag('type') : undefined });
      return out(docs.map((d) => ({ id: d.id, type: d.type, number: d.number, status: d.status, customer: d.customer.name, issueDate: d.issueDate, gross: d.totals ? formatCents(d.totals.grossCents) : null })));
    }
    if (sub === 'pdf') {
      const v = await svc.view(id);
      const original = v.doc.type === 'credit_note' && v.doc.relatedDocumentId ? (await store.getDocument(v.doc.relatedDocumentId))?.number : null;
      await mkdir(OUT_DIR, { recursive: true });
      const file = join(OUT_DIR, `${v.doc.type}_${v.doc.number ?? `draft-${id.slice(0, 8)}`}.pdf`);
      await writeFile(file, await renderDocumentPdf(v.doc, { settlement: v.settlement ?? null, originalNumber: original, branding: local.branding ?? {} }));
      return out({ file, draft: !v.doc.lockedAt });
    }
    if (sub === 'ubl') {
      const doc = await svc.get(id);
      const original = doc.type === 'credit_note' && doc.relatedDocumentId ? (await store.getDocument(doc.relatedDocumentId))?.number : null;
      const r = prepareTransmission(doc, { originalNumber: original, defaultBuyerReference: local.peppol?.defaultBuyerReference ?? null });
      if (r.payloadXml) { await mkdir(OUT_DIR, { recursive: true }); r.file = join(OUT_DIR, `${doc.number}.ubl.xml`); await writeFile(r.file, r.payloadXml); delete r.payloadXml; }
      return out(r);
    }
  }

  if (cmd === 'quote') {
    if (sub === 'send') return out(brief(await svc.sendQuote(id, me)));
    if (sub === 'accept') return out(brief(await svc.acceptQuote(id, me)));
    if (sub === 'reject') return out(brief(await svc.rejectQuote(id, me)));
    if (sub === 'convert') { const inv = await svc.convertQuote(id, me, { revenueBasis: typeof flag('basis') === 'string' ? flag('basis') : 'standalone_b2b', sourceOrderId: typeof flag('source-order') === 'string' ? flag('source-order') : null }); return out({ invoiceId: inv.id, status: inv.status, readiness: await svc.readiness(inv) }); }
  }

  if (cmd === 'credit-note' && sub === 'create') {
    const lines = flag('file') ? (await readJson(flag('file'))).lines : undefined;
    const cn = await svc.createCreditNote(id, { reason: flag('reason'), lines }, me);
    return out({ creditNoteId: cn.id, totals: { net: formatCents(cn.totals.netCents), vat: formatCents(cn.totals.vatCents), gross: formatCents(cn.totals.grossCents) }, readiness: await svc.readiness(cn) });
  }

  if (cmd === 'payment' && sub === 'add') {
    const p = await svc.recordPayment(id, { amount: flag('amount'), paidOn: flag('date'), method: typeof flag('method') === 'string' ? flag('method') : undefined, reference: typeof flag('ref') === 'string' ? flag('ref') : undefined }, me);
    return out({ recorded: { amount: formatCents(p.amountCents), paidOn: p.paidOn }, invoice: (await svc.view(id)).effectiveStatus });
  }

  if (cmd === 'receivables') {
    const today = new Date().toISOString().slice(0, 10);
    return out(buildReceivables(await loadDocsForReports(store, ctx.merchant.id), { today }));
  }

  if (cmd === 'pack') {
    const period = { start: flag('from'), end: flag('to') };
    const { data, ledger } = await ctx.loadRetail(period.start);
    const docs = await loadDocsForReports(store, ctx.merchant.id);
    const pack = buildAccountantPack({ ledger, rawOrders: data.orders, docs, period, timeZone: ctx.timeZone, now: new Date(), config: { ...ctx.retailConfig, finance: { linking: local.linking } }, today: new Date().toISOString().slice(0, 10) });
    const files = await writePackFiles(pack, OUT_DIR, { delimiter: typeof flag('delimiter') === 'string' ? flag('delimiter') : ',', branding: local.branding ?? {}, merchantName: local.seller?.name ?? '' });
    return out({ completeness: pack.completeness, reconciliation: pack.reconciliation, totals: Object.fromEntries(Object.entries(pack.totals).map(([k, v]) => [k, formatCents(v)])), anomalies: pack.anomalies.length, files: files.map((f) => join(OUT_DIR, f)) });
  }

  throw new Error(`unknown command: ${args.join(' ')}. Try: help`);
}

const brief = (d) => ({ id: d.id, type: d.type, number: d.number, status: d.status, gross: d.totals ? formatCents(d.totals.grossCents) : null, locked: !!d.lockedAt });

main().catch((e) => { console.error(JSON.stringify({ error: e.code ?? 'ERROR', message: e.message })); process.exitCode = 1; });
