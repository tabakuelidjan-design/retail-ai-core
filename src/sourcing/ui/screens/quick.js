// quick screen (extracted from app.js, no behaviour change).
import { esc, chip, money, list, field, selectOf, seg, quoteOf, VERDICT_TEXT } from '../dom.js';
import { S } from '../state.js';
import { CATEGORIES } from '/core/taxonomy.js';
import { effective } from '/core/identity.js';
import { suggestCategories } from '/core/case.js';
import { ls } from '../storage.js';

export const QUICK_TRAITS = [['battery.present', 'Has a battery?'], ['radio.present', 'Bluetooth / Wi-Fi?'], ['electrical.present', 'Electrical / electronic?'], ['childrenUse', 'For children?'], ['foodContact', 'Touches food or drink?']];
export function quickScreen(A, c) {
  const id = c.identity; const q = quoteOf(c); const sl = c.sale ?? {}; const cat = effective(id, 'category'); const sugg = suggestCategories(id.workingName); const co = c.costs.costs ?? {}; const fx = c.costs.fx ?? {};
  const lastFx = ls.get('nordla.sourcing.lastFx', null);
  const dest = c.context.channels.includes('amazon') ? (c.context.channels.includes('own_site') ? 'both' : 'amazon') : 'own';
  const gotAnswer = c.quotes.length > 0;
  return `<div class="card"><h2>QUICK ANSWER (stand in front of the supplier)</h2><p class="small muted">Six fields, one answer. It uses the same engine and the same case: you deepen it later (documents, rules). Nothing here is guessed: what you leave blank stays UNKNOWN.</p>
  <form data-form="quick">${field('name', '1. What is it? (name or what the label says)', id.workingName, 'autocomplete="off"')}
    ${selectOf('category', '2. Category (you confirm)', [['', cat.known ? `(keep: ${CATEGORIES[cat.value]?.label ?? cat.value})` : '- choose -'], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])], '')}
    ${sugg.length ? `<p class="small muted">Probably: ${sugg.map((x) => esc(x.label)).join(' / ')}</p>` : ''}
    <div class="row">${field('unitPrice', '3. Supplier price', q.unitPrice ?? '', 'inputmode="decimal"')}${selectOf('currency', 'Currency', [['USD', 'USD'], ['CNY', 'CNY'], ['EUR', 'EUR']], q.currency ?? 'USD')}</div>
    <div class="row">${field('moq', '4. MOQ', q.moq ?? '', 'inputmode="numeric"')}${field('qty', 'I would buy', q.qty ?? '', 'inputmode="numeric"')}</div>
    <div class="row">${field('price', '5. Selling price I target (incl. VAT)', sl.sellingPriceGross ?? '', 'inputmode="decimal"')}${field('target', 'Margin I want %', sl.targetContributionPct ?? 30, 'inputmode="decimal"')}</div>
    ${selectOf('dest', '6. Where will it be sold?', [['own', 'My shop / Belgium'], ['amazon', 'Amazon'], ['both', 'Both']], dest)}
    <div class="row">${field('freight', 'Freight total EUR (if known)', co.freight?.total ?? '', 'inputmode="decimal"')}${field('duty', 'Duty % (broker; if known)', c.customs?.duty?.ratePct ?? '', 'inputmode="decimal"')}</div>
    <div class="row">${field('fxRate', 'EUR per 1 unit of currency', fx.rate ?? lastFx ?? '', 'inputmode="decimal"')}${field('incoterm', 'Incoterm (FOB, EXW...)', q.incoterm ?? '')}</div>
    <button class="btn" style="margin-top:12px">Get the preliminary answer</button></form></div>
  <div class="card"><h2>KEY QUESTIONS</h2><p class="small muted">Tap what you can see or were told. Unknown stays unknown.</p>${QUICK_TRAITS.map(([t, l]) => `<div class="trait"><div class="nm">${esc(l)}</div>${seg('trait', t, effective(id, t).known && effective(id, t).level !== 'PROBABLE' && effective(id, t).level !== 'AI_SUGGESTED' ? effective(id, t).value : null)}</div>`).join('')}
    <div class="trait"><div class="nm">Sold under MY name / brand?</div>${seg('place', 'underOwnNameOrBrand', c.placing.underOwnNameOrBrand ?? null)}</div>
    <div class="trait"><div class="nm">Manufacturer is in the EU?</div>${seg('place', 'manufacturerEstablishedInEU', c.placing.manufacturerEstablishedInEU ?? null)}</div></div>
  ${gotAnswer ? `<div class="verdict v-${A.decision.verdict}"><p class="q">PRELIMINARY ANSWER</p><div class="v">${esc(A.decision.verdict.replace(/_/g, ' '))}</div><p style="margin:0">${esc(A.decision.nextAction)}</p><p class="small" style="margin:8px 0 0">Max purchase price: <b>${esc(A.maxPurchasePrice?.maxUnitPriceMinor != null ? A.maxPurchasePrice.display : 'UNKNOWN')}</b> - landed ${esc(A.landed.status === 'INFORMATION_INSUFFICIENT' ? 'UNKNOWN' : money(A.landed.totals.landedPerUnitEurMinor))}</p><button type="button" class="btn sec" data-act="tab" data-key="decision" style="margin-top:8px">See the full verdict</button></div>` : ''}`;
}
