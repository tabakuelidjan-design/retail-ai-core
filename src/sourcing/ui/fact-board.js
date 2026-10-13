// The Expert screens' view of what the supplier said and where each fact stands: confirmed, to confirm, ambiguous, missing. It reads the SAME board (core/case-facts.js factStatusBoard) as Terrain and Salon.
// Nothing is confirmed here by itself: a proposed fact has a Confirm button, an ambiguous one has a field where the owner types the right value.
import { esc } from './dom.js';
import { factStatusBoard } from '/core/case-facts.js';

const STATE = { CONFIRMED: ['confirmed', 'ok'], PROPOSED: ['TO CONFIRM (said by the supplier)', 'warn'], AMBIGUOUS: ['AMBIGUOUS: type the right value', 'warn'], MISSING: ['missing', 'muted'] };
const SHOWN = ['PRICE', 'CURRENCY', 'MOQ', 'MODEL', 'POWER', 'CAPACITY', 'OUTPUT_COUNT', 'COLOURS', 'STOCK_STATUS', 'LEAD_TIME', 'INCOTERM'];
const SRC = { SUPPLIER_CLAIM: 'supplier claim', USER_PROVIDED: 'typed or corrected by you', IMAGE_OBSERVED: 'read on a photo', DOCUMENT_OBSERVED: 'read in a document', UNATTRIBUTED_LEGACY: 'origin not tracked' };
export function factBoardCard(c) {
  const rows = factStatusBoard(c, { locale: 'en', types: SHOWN }).filter((r) => r.state !== 'MISSING' || ['PRICE', 'MOQ', 'MODEL'].includes(r.fact_type));
  const row = (r) => { const [tag, kind] = STATE[r.state];
    const value = r.state === 'CONFIRMED' ? r.valueText : r.state === 'MISSING' ? '-' : r.proposedValueText;
    const act = r.state === 'PROPOSED' && r.canConfirm ? `<button type="button" class="btn sec" data-act="cand-confirm" data-key="${esc(r.candidateId)}">Confirm</button>` : r.state === 'AMBIGUOUS' ? `<form data-form="cand-correct" data-id="${esc(r.candidateId)}" class="row"><input name="value" placeholder="e.g. 10000 mAh" autocomplete="off"><button class="btn sec">Correct</button></form>` : '';
    return `<div class="trait"><div class="nm">${esc(r.label)}: <b>${esc(value)}</b> <span class="chip ${kind}">${esc(tag)}</span>${r.source_type && r.state === 'CONFIRMED' ? ` <span class="small muted">${esc(SRC[r.source_type] ?? r.source_type)}</span>` : ''}${r.rawText && r.state !== 'CONFIRMED' ? ` <span class="small muted">"${esc(r.rawText)}"</span>` : ''}</div>${act}</div>`; };
  return `<div class="card"><h2>FACTS - where each one stands</h2><p class="small muted">What the supplier said stays a claim until you confirm it. Nothing below is confirmed for you.</p>${rows.map(row).join('')}</div>`;
}
