// Small DOM/format helpers shared by the screens (extracted from app.js, no change). Pure string builders: nothing here touches state.
import { fmt } from '/core/money.js';
import { effectiveQuote } from '/core/offers.js';

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const chip = (label, value, cls = value) => `<span class="chip t-${esc(cls)}">${esc(label)} <b>${esc(String(value).replace(/_/g, ' '))}</b></span>`;
export const money = (m, cur = 'EUR') => (m === null || m === undefined ? '-' : fmt(m, cur));
export const list = (xs) => (xs.length ? `<ul class="tight">${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="muted small">none</p>');
export const VERDICT_TEXT = { GO: ['Yes - continue', 'Oui, continuer'], CONDITIONAL_GO: ['Continue, but only on conditions', 'Continuer, sous conditions'], NO_GO: ['No - not on these terms', 'Non, pas dans ces conditions'], INSUFFICIENT_INFORMATION: ['Not enough information yet', 'Pas assez d\'informations'] };
export const field = (name, label, val = '', attrs = '') => `<label>${esc(label)}<input name="${name}" value="${esc(val)}" ${attrs}></label>`;
export const selectOf = (name, label, opts, val = '') => `<label>${esc(label)}<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
export const seg = (act, key, current, opts = [[true, 'Yes'], [false, 'No']]) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" data-act="${act}" data-key="${esc(key)}" data-val="${esc(JSON.stringify(v))}" aria-pressed="${current === v}">${l}</button>`).join('')}</div>`;
export const quoteOf = (c) => effectiveQuote(c.quotes.at(-1) ?? {}); // with price tiers: the unit price for the quantity considered (a V0 quote is returned untouched)
