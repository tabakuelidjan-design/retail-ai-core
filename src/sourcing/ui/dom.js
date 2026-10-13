// Small DOM/format helpers shared by the screens (extracted from app.js, no change). Pure string builders: nothing here touches state.
import { fmt } from '/core/money.js';
import { effectiveQuote } from '/core/offers.js';
import { expertQuote } from '/core/case-facts.js';

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const chip = (label, value, cls = value) => `<span class="chip t-${esc(cls)}">${esc(label)} <b>${esc(String(value).replace(/_/g, ' '))}</b></span>`;
/** The rulebook does not speak for this product: a red banner, never a green tick. "No applicable rule" is not "nothing applies". */
export const coverageBanner = (A) => { const c = A?.coverage; if (!c || c.status === 'COVERED') return ''; const stale = A.safety?.stale === true ? '<p class="warn small"><b>Safety Gate : résultat périmé</b> (' + (A.safety.ageDays === null || A.safety.ageDays === undefined ? 'âge inconnu' : A.safety.ageDays + ' jours') + ') - ne pas le considérer comme actuel. Revérifier en ligne.</p>' : ''; if (c.status === 'PARTIAL') return `<p class="note small">${esc(c.notes.join(' '))}</p>${stale}`; return `<div class="warn"><strong>${esc(c.banner)}</strong><p class="small">${esc((c.reasonsFr?.length ? c.reasonsFr : c.reasons).join(' '))}</p><p class="small">L'absence de règle applicable ne veut pas dire que rien ne s'applique.</p></div>${stale}`; };
export const money = (m, cur = 'EUR') => (m === null || m === undefined ? '-' : fmt(m, cur));
export const list = (xs) => (xs.length ? `<ul class="tight">${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="muted small">none</p>');
export const VERDICT_TEXT = { GO: ['Yes - continue', 'Oui, continuer'], CONDITIONAL_GO: ['Continue, but only on conditions', 'Continuer, sous conditions'], NO_GO: ['No - not on these terms', 'Non, pas dans ces conditions'], INSUFFICIENT_INFORMATION: ['Not enough information yet', 'Pas assez d\'informations'] };
export const field = (name, label, val = '', attrs = '') => `<label>${esc(label)}<input name="${name}" value="${esc(val)}" ${attrs}></label>`;
export const selectOf = (name, label, opts, val = '') => `<label>${esc(label)}<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
export const seg = (act, key, current, opts = [[true, 'Yes'], [false, 'No']]) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" data-act="${act}" data-key="${esc(key)}" data-val="${esc(JSON.stringify(v))}" aria-pressed="${current === v}">${l}</button>`).join('')}</div>`;
export const quoteOf = (c) => expertQuote(c); // read through CaseFacts: Expert shows the same facts as Terrain and Salon (effectiveQuote is applied inside) // with price tiers: the unit price for the quantity considered (a V0 quote is returned untouched)
