// The results table shared by Verdict and Money (extracted from app.js, no change).
import { esc, money, quoteOf } from './dom.js';

export function numbersInner(A, c) {
  const q = quoteOf(c); const L = A.landed; const E = A.economics; const mp = A.maxPurchasePrice; const sl = c.sale ?? {};
  const unknown = (L.unknown ?? []).map((u) => u.replace(/^costs\./, ''));
  return `<table>
    <tr><td>Supplier price now</td><td class="n"><b>${esc(q.unitPrice ?? '-')} ${esc(q.currency ?? '')}</b>${q.moq ? ` <span class="muted small">MOQ ${esc(q.moq)}</span>` : ''}${q.qty ? ` <span class="muted small">you buy ${esc(q.qty)}</span>` : ''}</td></tr>
    <tr><td>Landed cost / unit</td><td class="n"><b>${esc(L.status === 'INFORMATION_INSUFFICIENT' ? 'UNKNOWN' : money(L.totals.landedPerUnitEurMinor))}</b> <span class="muted small">${esc(L.status.replace(/_/g, ' '))}</span></td></tr>
    <tr><td>Selling price (${esc(E.priceBasis ?? sl.priceBasis ?? 'TARGET')})</td><td class="n">${esc(E.sellingPriceGrossMinor != null ? money(E.sellingPriceGrossMinor) : '-')}${E.vatRatePct != null ? ` <span class="muted small">incl. ${esc(E.vatRatePct)}% VAT</span>` : ''}</td></tr>
    <tr><td>Profit / unit (before your own costs)</td><td class="n"><b>${esc(E.contributionMinor != null ? money(E.contributionMinor) : 'UNKNOWN')}</b>${E.contributionPct != null ? ` <span class="muted small">${(E.contributionPct * 100).toFixed(1)}%${E.contributionIsUpperBound ? ' upper bound' : ''}</span>` : ''}</td></tr>
    <tr><td>Your target margin</td><td class="n">${esc(sl.targetContributionPct != null && sl.targetContributionPct !== '' ? `${sl.targetContributionPct}%` : 'not set')}</td></tr>
    <tr><td><b>Maximum purchase price</b></td><td class="n"><b>${esc(mp?.maxUnitPriceMinor != null ? mp.display ?? money(mp.maxUnitPriceMinor, mp.currency) : 'UNKNOWN')}</b>${mp?.upperBound ? ' <span class="muted small">upper bound</span>' : ''}</td></tr>
  </table>${unknown.length ? `<p class="small"><b>Still unknown:</b> ${esc(unknown.join(', '))}</p>` : ''}${L.status === 'INFORMATION_INSUFFICIENT' ? `<p class="warn small">Cannot be calculated yet: ${esc((L.criticalUnknown ?? []).join(', '))}</p>` : ''}`;
}
