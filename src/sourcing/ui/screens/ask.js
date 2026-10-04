// ask screen (extracted from app.js, no behaviour change).
import { esc, chip, money, list, field, selectOf, seg, quoteOf, VERDICT_TEXT } from '../dom.js';
import { S } from '../state.js';

export function askScreen(A) {
  const qs = A.questions;
  return `<div class="card"><h2>ASK THE SUPPLIER NOW</h2><p class="small muted">Prioritised from what is still missing. ${qs.filter((q) => q.priority === 'P1').length} are P1 (they block the decision).</p><div class="row"><button class="btn" data-act="show-sup">Show to supplier (EN + 中文)</button><button class="btn sec" data-act="copy-sup">Copy</button></div></div>
  <div class="card">${qs.map((q) => `<div class="q-item"><span class="pri ${q.priority}">${q.priority}</span><b>${esc(q.topic)}</b><div>${esc(q.en)}</div><div class="zh" lang="zh-Hans">${esc(q.zh)}</div><div class="small muted">${esc(q.why)}</div></div>`).join('')}</div>
  <p class="note">${esc(A.supplierSheet.note.en)}</p><div class="card"><h2>NEGOTIATION BRIEF</h2>${negotiation(A)}</div>`;
}
export function negotiation(A) {
  const n = A.negotiation;
  return `<table><tr><td>Walk-away price</td><td class="n"><b>${esc(n.walkAwayUnitPrice?.display ?? 'INFORMATION INSUFFICIENT')}</b></td></tr><tr><td>Target price</td><td class="n">${esc(n.targetUnitPrice?.display ?? '-')}</td></tr><tr><td>Quoted</td><td class="n">${esc(n.quotedUnitPrice ?? '-')}</td></tr><tr><td>MOQ</td><td class="n">${esc(n.moq ?? '-')}</td></tr><tr><td>Incoterm</td><td class="n">${esc(n.incoterm ?? '-')}</td></tr></table>
  ${n.moqNote ? `<p class="warn">${esc(n.moqNote)}</p>` : ''}${n.ownBrandWarning ? `<p class="warn">${esc(n.ownBrandWarning)}</p>` : ''}<h3>Documents before any deposit</h3>${list(n.documentsBeforeDeposit.map(esc))}<ul class="tight"><li>${esc(n.sample)}</li><li>${esc(n.inspection)}</li><li>${esc(n.incotermAdvice)}</li></ul><p class="small muted">${esc(n.targetUnitPrice?.basis ?? '')}. ${esc(n.nothingPredicted)}</p>`;
}
