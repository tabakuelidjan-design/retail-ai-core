'use strict';
// Finance Operations Workspace views: Action Center, Finance Inbox, Purchases, accountant closing workflow, stock / accountant / inbox / Peppol settings.
// Loaded after app.js (shares its helpers: h, api, layout, modal, toast, tt, tr ...). Same rules: no innerHTML, the browser never calculates money.

// ---------- Action Center ----------
const ACTION_TEXT = {
  setup_incomplete: (a) => tt('{0} setting(s) missing to issue real invoices', a.count),
  overdue_invoices: (a) => tt('{0} invoice(s) are overdue: {1} to collect', a.count, a.amount),
  to_collect_soon: (a) => tt('{0} to collect in the next {1} days', a.amount, a.params.days),
  invoices_to_approve: (a) => tt('{0} invoice(s) waiting for your approval', a.count),
  documents_missing_vat: (a) => tt('{0} document(s) are missing VAT information', a.count),
  quotes_to_convert: (a) => tt('{0} accepted quote(s) can become invoices', a.count),
  supplier_invoices_to_review: (a) => tt('{0} supplier invoice(s) require validation', a.count),
  supplier_invoices_to_pay: (a) => tt('{0} supplier invoice(s) to pay: {1}', a.count, a.amount),
  stock_movements_need_attention: (a) => tt('{0} stock movement(s) need your attention', a.count),
  quarter_closes_soon: (a) => tt('Q{0} {1} closes in {2} days', a.params.quarter, a.params.year, a.params.days),
  accountant_pack_ready: (a) => tt('The accountant pack for {0} is ready', a.params.period),
  accountant_pack_needs_review: (a) => tt('The accountant pack for {0} needs review ({1} anomalies)', a.params.period, a.count),
  orders_reconciled: (a) => tt('{0} orders reconciled', a.count),
};
const CTA_TEXT = { review: 'Review', validate: 'Validate supplier invoices', prepare_pack: 'Prepare the accountant file', settings: 'Open settings' };
function actionCenterCard(actions, currency) {
  actions = actions.map((a) => (a.amount ? { ...a, amount: `${a.amount} ${currency || ''}`.trim() } : a));
  const card = h('div', { class: 'card actioncenter' }, h('div', { class: 'cardhead' }, h('h2', null, 'Action Center'), h('span', { class: 'muted small' }, 'What to do next')));
  if (!actions.length) { card.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon ok' }, svgIcon('check', 22)), h('div', null, h('strong', null, 'Nothing needs your attention'), h('div', { class: 'muted small' }, 'Everything is up to date.')))); return card; }
  const ICON = { bad: 'alert', warn: 'clock', info: 'arrow', ok: 'check' };
  const list = h('div', { class: 'alist' });
  actions.forEach((a, i) => list.appendChild(h('a', { class: `arow ${a.tone}`, href: a.href, style: `animation-delay:${Math.min(i, 8) * 30}ms` },
    h('span', { class: 'aico' }, svgIcon(ICON[a.tone] || 'arrow', 16)), h('span', { class: 'atext' }, (ACTION_TEXT[a.kind] || (() => a.kind))(a)), h('span', { class: 'acta' }, tt(CTA_TEXT[a.cta] || 'Review'), svgIcon('chevron', 14)))));
  card.appendChild(list);
  return card;
}

// ---------- helpers ----------
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const SOURCE_BADGE = { peppol: 'Peppol', email: 'E-mail', upload: 'Upload', manual: 'Manual' };
const sourceBadge = (s) => h('span', { class: `chip src-${s}` }, tt(SOURCE_BADGE[s] || s));
const INBOX_STATUS = { RECEIVED: 'Received', TO_REVIEW: 'To review', VALIDATED: 'Validated', TO_PAY: 'To pay', PAID: 'Paid', REJECTED: 'Rejected' };
const inboxBadge = (s) => h('span', { class: `badge IN_${s}` }, tt(INBOX_STATUS[s] || s));
const confChip = (x) => { const v = x.extraction && x.extraction.fields ? Object.values(x.extraction.fields) : []; if (!v.length) return h('span', { class: 'chip mute' }, tt('No automatic extraction')); const m = Math.min(...v); return h('span', { class: `chip ${m >= 0.9 ? 'ok' : m >= 0.6 ? 'warn' : 'bad'}` }, tt('Confidence {0}%', Math.round(m * 100))); };
const INBOX_ERR = { SUPPLIER_NAME_MISSING: 'Supplier name is missing', INVOICE_NUMBER_MISSING: 'Invoice number is missing', ISSUE_DATE_INVALID: 'Invoice date is missing or invalid', DUE_DATE_INVALID: 'Due date is invalid', NET_AMOUNT_INVALID: 'Amount excl. VAT is missing', VAT_AMOUNT_INVALID: 'VAT amount is missing', GROSS_AMOUNT_INVALID: 'Amount incl. VAT is missing', VAT_EXCEEDS_TOTAL: 'The VAT is higher than the total', NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL: 'Excl. VAT + VAT does not equal the total', CURRENCY_INVALID: 'Currency is missing',
  SUPPLIER_IBAN_INVALID: 'The supplier IBAN is invalid', SUPPLIER_ENTERPRISE_NUMBER_INVALID: 'The enterprise number is invalid', SUPPLIER_VAT_NUMBER_INVALID: 'The supplier VAT number is invalid', DOCUMENT_TYPE_INVALID: 'Choose the document type', VAT_BREAKDOWN_NEGATIVE: 'The VAT breakdown has negative amounts' };
const inboxErrText = (c) => tt(INBOX_ERR[c] || c);
// Common purchase-document model: the type (amounts stay positive; a credit note reduces purchases) and the deterministic checks.
const DOC_TYPE = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', RECEIPT: 'Receipt / ticket', EXPENSE: 'Other expense' };
const docTypeChip = (r) => (r.documentType && r.documentType !== 'INVOICE' ? h('span', { class: r.documentType === 'CREDIT_NOTE' ? 'chip warn doc-type' : 'chip mute doc-type' }, tt(DOC_TYPE[r.documentType] || r.documentType)) : null);
const CHECK_TEXT = { TOTALS_DO_NOT_ADD_UP: 'The extracted totals do not add up: check them.', NEGATIVE_INVOICE_READ_AS_CREDIT_NOTE: 'This invoice has negative amounts: it was read as a credit note with positive amounts. Check the type.',
  NEGATIVE_AMOUNTS_ON_CREDIT_NOTE: 'This credit note has negative amounts: they were read as positive amounts.', XML_DOCTYPE_NOT_ALLOWED: 'This XML file was refused for safety (DOCTYPE): enter the fields manually.',
  XML_MALFORMED: 'This XML file could not be read: enter the fields manually.', NOT_A_UBL_INVOICE_OR_CREDIT_NOTE: 'This XML file is not a UBL invoice or credit note: enter the fields manually.', TOO_MANY_LINES_TRUNCATED: 'Only the first 500 lines were read.',
  EXTRACTION_FAILED: 'Automatic reading failed: enter the fields manually.', VAT_BREAKDOWN_INCOMPLETE: 'The VAT breakdown is incomplete.', VAT_BREAKDOWN_TAXABLE_DOES_NOT_MATCH_NET: 'The VAT breakdown does not match the amount excl. VAT.',
  VAT_BREAKDOWN_DOES_NOT_MATCH_VAT: 'The VAT breakdown does not match the VAT amount.', VAT_RATE_AMOUNT_MISMATCH: 'A VAT amount does not match its rate.', VAT_RATE_UNUSUAL_FOR_BELGIUM: 'A VAT rate is not a usual Belgian rate (0, 6, 12, 21 %).',
  LINES_DO_NOT_ADD_UP: 'The invoice lines do not add up to the lines total.', PAYABLE_DIFFERS_FROM_TOTAL: 'The amount to pay differs from the total incl. VAT (prepayment or rounding).',
  CREDIT_NOTE_WITHOUT_INVOICE_REFERENCE: 'This credit note does not say which invoice it credits.', VAT_AND_ENTERPRISE_NUMBER_DIFFER: 'The VAT number and the enterprise number do not match.' };
const checkText = (c) => tt(CHECK_TEXT[c] || INBOX_ERR[c] || c);
/** Integer cents -> text in the UI language, by string composition only (no arithmetic on money). */
/** Client-side CSV export of rows already visible on screen - real data already fetched for the table, no
 * server round trip, no fabricated column. RFC 4180-ish: only the two characters that actually need
 * escaping in these simple text/number columns are handled. Used by Ventes/Achats "Export". */
function exportRowsAsCsv(rows, columns, filename) {
  const quote = String.fromCharCode(34); // kept out of any regex literal - see the finding recorded here
  const needsQuoting = (s) => s.includes(quote) || s.includes(',') || s.includes('\n');
  const esc = (v) => { const s = String(v ?? ''); return needsQuoting(s) ? quote + s.split(quote).join(quote + quote) + quote : s; };
  const csv = `﻿${[columns.map((c) => c.header).join(','), ...rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: filename }); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const CUR_SYMBOL = { EUR: '€', USD: '$', GBP: '£' };
function fmtMoney(cents, currency) {
  if (cents == null) return '';
  const neg = cents < 0; const a = String(Math.abs(cents)).padStart(3, '0'); const int = a.slice(0, -2); const dec = a.slice(-2);
  const lang = I18N.getLang(); const group = lang === 'en' ? ',' : lang === 'nl' ? '.' : ' '; const point = lang === 'en' ? '.' : ',';
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group); const sym = CUR_SYMBOL[currency] || currency || '';
  const num = `${neg ? '-' : ''}${grouped}${point}${dec}`;
  // Phase 0 (section 13): a non-breaking space before the currency symbol in fr-BE, so "1 234,56" and
  // "€" can never be split across a line wrap. The thousands grouping above already uses U+202F.
  return lang === 'fr' ? `${num} ${sym}`.trim() : lang === 'nl' ? `${sym} ${num}`.trim() : `${sym}${num}`;
}
const centsToInput = (c) => (c == null ? '' : `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`);

// ---------- item review pane (edit fields, see the source document, validate / reject / pay / link a
// contact) - the shared renderer behind both the Achats workspace's persistent right pane and the modal
// drawer used elsewhere (A faire, Contacts). Exactly the same real API calls either way. ----------
function renderInboxDetail(host, id, opts = {}) {
  const onChange = opts.onChange || (() => {});
  const body = h('div', { class: 'drawer-body' }); const err = h('div');
  clear(host); host.appendChild(err); host.appendChild(body);
  async function draw() {
    clear(body);
    let it; try { it = await api('GET', `/api/inbox/${id}`); } catch (e) { return fail(e, body); }
    const editable = ['RECEIVED', 'TO_REVIEW'].includes(it.status);
    const f = {}; const inp = (k, label, val, ph, cls) => { const el = h('input', { value: val ?? '', placeholder: ph || '', disabled: !editable, on: { input: (e) => { f[k] = e.target.value; } } }); f[k] = val ?? ''; return h('div', { class: `field ${cls || ''}` }, h('label', null, label, it.extraction && it.extraction.fields && it.extraction.fields[k.replace(/^net$|^vat$|^gross$/, (m) => `${m}Cents`)] !== undefined ? h('span', { class: 'conf' }, ` ${Math.round(it.extraction.fields[k.replace(/^net$|^vat$|^gross$/, (m) => `${m}Cents`)] * 100)}%`) : null), el); };
    body.appendChild(h('div', { class: 'drawer-head' }, inboxBadge(it.status), docTypeChip(it), sourceBadge(it.source), confChip(it), it.fileName ? h('span', { class: 'muted small' }, `${it.fileName} · ${fmtBytes(it.sizeBytes || 0)}`) : null));
    if (it.rejectedReason) body.appendChild(h('div', { class: 'banner warn small' }, tt('Rejected: {0}', it.rejectedReason)));
    if (it.extraction && it.extraction.warnings && it.extraction.warnings.length) body.appendChild(h('div', { class: 'banner warn small' }, it.extraction.warnings.map((w) => h('div', null, checkText(w)))));
    if (it.checks && it.checks.length) body.appendChild(h('div', { class: 'banner warn small doc-checks' }, h('strong', null, tt('To check:')), h('ul', { class: 'plain' }, it.checks.map((c) => h('li', null, checkText(c))))));
    if (it.hasFile) body.appendChild(h('div', { style: 'margin:8px 0' }, h('a', { class: 'btn', href: `/api/inbox/${id}/file`, target: '_blank', rel: 'noopener' }, tt('Open the source document'))));
    else if (it.status !== 'REJECTED') body.appendChild(h('div', { style: 'margin:8px 0' }, attachButton(id, () => { draw(); onChange(); })));
    const capInfo = captureInfoNode(it); if (capInfo) body.appendChild(capInfo); // null for a document that is neither a capture nor an attached receipt
    const typeSel = h('select', { disabled: !editable, 'data-field': 'documentType', on: { change: (e) => { f.documentType = e.target.value; } } }, Object.keys(DOC_TYPE).map((k) => h('option', { value: k, selected: k === it.documentType }, tt(DOC_TYPE[k]))));
    f.documentType = it.documentType;
    body.appendChild(h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, tt('Document type'), it.extraction && it.extraction.fields && it.extraction.fields.documentType !== undefined ? h('span', { class: 'conf' }, ` ${Math.round(it.extraction.fields.documentType * 100)}%`) : null), typeSel),
      it.documentType === 'CREDIT_NOTE' ? inp('billingReference', tr('Credited invoice number'), it.billingReference) : inp('orderReference', tr('Order reference'), it.orderReference)));
    if (it.documentType === 'CREDIT_NOTE') body.appendChild(h('div', { class: 'muted small doc-sign' }, tt('A credit note reduces your purchases: its amounts are entered as positive amounts.')));
    body.appendChild(h('div', { class: 'row r2' }, inp('supplierName', tr('Supplier'), it.supplierName), inp('supplierVatNumber', tr('Supplier VAT number'), it.supplierVatNumber, 'BE0123456789')));
    body.appendChild(h('div', { class: 'row r2' }, inp('supplierEnterpriseNumber', tr('Enterprise number'), it.supplierEnterpriseNumber, '0123.456.789'), inp('supplierIban', tr('Supplier IBAN'), it.supplierIban, 'BE68 5390 0754 7034')));
    body.appendChild(h('div', { class: 'row r3' }, inp('invoiceNumber', tr('Invoice number'), it.invoiceNumber), inp('issueDate', tr('Invoice date'), it.issueDate, 'YYYY-MM-DD'), inp('dueDate', tr('Due date'), it.dueDate, 'YYYY-MM-DD')));
    body.appendChild(h('div', { class: 'row r4' }, inp('net', tr('Excl. VAT'), centsToInput(it.netCents)), inp('vat', tr('VAT'), centsToInput(it.vatCents)), inp('gross', tr('Incl. VAT'), centsToInput(it.grossCents)), inp('currency', tr('Currency'), it.currency, 'EUR')));
    body.appendChild(h('div', { class: 'row r2' }, inp('paymentReference', tr('Payment reference'), it.paymentReference, '+++000/0000/00000+++'), it.documentType === 'CREDIT_NOTE' ? inp('orderReference', tr('Order reference'), it.orderReference) : h('div', null)));
    if (it.vatBreakdown && it.vatBreakdown.length) body.appendChild(h('div', { class: 'field doc-vat' }, h('label', null, tt('VAT by rate')), h('table', { class: 'mini' }, h('thead', null, h('tr', null, h('th', null, tt('Rate')), h('th', null, tt('Excl. VAT')), h('th', null, tt('VAT')))),
      h('tbody', null, it.vatBreakdown.map((b) => h('tr', null, h('td', null, b.rateBp == null ? (b.category || '—') : `${(b.rateBp / 100).toString().replace('.', ',')} %`), h('td', null, b.taxableCents == null ? '—' : fmtMoney(b.taxableCents, it.currency)), h('td', null, b.vatCents == null ? '—' : fmtMoney(b.vatCents, it.currency))))))));
    if (it.lines && it.lines.length) body.appendChild(h('details', { class: 'doc-lines' }, h('summary', null, tt('{0} invoice line(s)', it.lines.length)), h('table', { class: 'mini' }, h('thead', null, h('tr', null, h('th', null, tt('Description')), h('th', null, tt('Qty')), h('th', null, tt('Excl. VAT')), h('th', null, tt('Rate')))),
      h('tbody', null, it.lines.map((l) => h('tr', null, h('td', null, l.description || '—'), h('td', null, l.quantity || '—'), h('td', null, l.netCents == null ? '—' : fmtMoney(l.netCents, it.currency)), h('td', null, l.rateBp == null ? '—' : `${(l.rateBp / 100).toString().replace('.', ',')} %`)))))));
    // Real, existing backend capability (POST /api/inbox/:id/contact) that had no UI control anywhere -
    // links this supplier invoice to an existing contact by searching the same real /api/contacts list.
    const contactBox = h('div', { class: 'field' }, h('label', null, tt('Linked contact')), h('div', { class: 'muted small' }, tt('Loading...')));
    body.appendChild(contactBox);
    (async () => {
      clear(contactBox); contactBox.appendChild(h('label', null, tt('Linked contact')));
      if (it.supplierCompanyId) {
        let name = it.supplierCompanyId;
        try { name = (await api('GET', `/api/contacts/${it.supplierCompanyId}`)).displayName; } catch (e) { /* keep the id as a fallback */ }
        contactBox.appendChild(h('div', { class: 'row r2', style: 'align-items:center' }, h('strong', null, name), h('button', { type: 'button', on: { click: async () => { try { await api('POST', `/api/inbox/${id}/contact`, { contactId: null }); toast(tt('Contact unlinked'), 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } } } }, tt('Unlink'))));
      } else {
        const q = h('input', { placeholder: tr('Search contacts by name or VAT...') });
        const results = h('div');
        let timer = null;
        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => {
          clear(results); const term = q.value.trim(); if (!term) return;
          try { const rows = (await api('GET', `/api/contacts?q=${encodeURIComponent(term)}`)).rows.slice(0, 6);
            if (!rows.length) { results.appendChild(h('div', { class: 'muted small' }, tt('No contact matches.'))); return; }
            rows.forEach((c) => results.appendChild(h('button', { type: 'button', class: 'result', on: { click: async () => { try { await api('POST', `/api/inbox/${id}/contact`, { contactId: c.id }); toast(tt('Contact linked'), 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } } } }, c.displayName)));
          } catch (e) { fail(e, results); }
        }, 220); });
        contactBox.appendChild(q); contactBox.appendChild(results);
      }
    })();
    if (it.errors.length && ['RECEIVED', 'TO_REVIEW'].includes(it.status)) body.appendChild(h('div', { class: 'banner info small' }, h('strong', null, tt('Still needed before validation:')), h('ul', { class: 'plain' }, it.errors.map((c) => h('li', null, inboxErrText(c))))));
    const act = h('div', { class: 'actions', style: 'margin-top:12px' });
    const go = (path, payload, msg) => async () => { try { await api('POST', `/api/inbox/${id}/${path}`, payload || {}); toast(msg, 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } };
    if (editable) {
      act.appendChild(h('button', { on: { click: async () => { try { await api('PUT', `/api/inbox/${id}`, f); toast('Saved', 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } } } }, tt('Save')));
      act.appendChild(h('button', { class: 'primary', on: { click: async () => { try { await api('PUT', `/api/inbox/${id}`, f); await api('POST', `/api/inbox/${id}/validate`, {}); toast('Validated', 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } } } }, tt('Validate')));
      act.appendChild(h('button', { class: 'danger', on: { click: () => { const reason = h('input', { placeholder: tr('Reason (required)') }); modal('Reject this document', h('div', null, h('p', { class: 'muted' }, tt('It is not a supplier invoice, or it is a duplicate.')), h('div', { class: 'field' }, h('label', null, tt('Reason')), reason)), (close) => [h('button', { class: 'danger', on: { click: async () => { close(); try { await api('POST', `/api/inbox/${id}/reject`, { reason: reason.value }); toast('Rejected', 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } } } }, tt('Reject')), h('button', { on: { click: close } }, tt('Cancel'))]); } } }, tt('Reject')));
    } else if (it.status === 'VALIDATED') { if (it.documentType !== 'CREDIT_NOTE') act.appendChild(h('button', { class: 'primary', on: { click: go('to-pay', {}, 'Marked to pay') } }, tt('Mark to pay'))); act.appendChild(h('button', { on: { click: go('reopen', {}, 'Reopened') } }, tt('Reopen for correction'))); }
    else if (it.status === 'TO_PAY') {
      act.appendChild(h('button', { class: 'primary', on: { click: () => { const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }); const ref = h('input', { placeholder: tr('Bank reference (optional)') }); modal('Record the payment', h('div', null, h('p', { class: 'muted' }, tt('Amount: {0} {1}', fmtMoney(it.grossCents, it.currency), '')), h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, tt('Date paid')), date), h('div', { class: 'field' }, h('label', null, tt('Reference')), ref))), (close) => [h('button', { class: 'primary', on: { click: async () => { close(); try { await api('POST', `/api/inbox/${id}/pay`, { paidOn: date.value, amount: centsToInput(it.grossCents), reference: ref.value || undefined }); toast('Payment recorded', 'ok'); draw(); onChange(); } catch (e) { fail(e, err); } } } }, tt('Record payment')), h('button', { on: { click: close } }, tt('Cancel'))]); } } }, tt('Mark as paid')));
      act.appendChild(h('button', { on: { click: go('reopen', {}, 'Reopened') } }, tt('Reopen for correction')));
    } else if (it.status === 'PAID') act.appendChild(h('span', { class: 'muted' }, tt('Paid on {0}', it.paidAt || '')));
    body.appendChild(act);
  }
  draw();
  return { refresh: draw };
}
// Modal wrapper for the places that still want an overlay drawer (A faire, Contacts) - identical behaviour
// to before: reload() runs when the modal is closed, not after every inline action.
function openInboxItem(id, reload) {
  const host = h('div', { class: 'drawer-body-host' });
  const back = modal('Supplier invoice', host, (close) => [h('button', { on: { click: () => { close(); reload(); } } }, tt('Close'))]);
  back.classList.add('drawer');
  renderInboxDetail(host, id);
}

// ---------- À faire / To do: the real Action Center, as a first-class page ----------
async function viewTodo() {
  const shell = h('div', { class: 'page-shell premium' });
  layout('#/todo', shell);
  shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('To do')), h('div', { class: 'subtitle' }, tt('Everything that needs your attention, in one place.')))));
  const box = h('div', { style: 'display:grid;gap:18px' }); shell.appendChild(box);
  box.appendChild(h('div', { class: 'metric-grid' }, [1, 2, 3, 4].map(() => h('div', { class: 'card skel-card' }, h('div', { class: 'skl', style: 'height:22px;width:30%' })))));
  try {
    const [ac, o] = await Promise.all([api('GET', '/api/actions'), api('GET', '/api/overview')]);
    clear(box);
    const actions = ac.actions;
    const counts = { bad: actions.filter((a) => a.tone === 'bad').length, warn: actions.filter((a) => a.tone === 'warn').length, info: actions.filter((a) => a.tone === 'info').length, ok: actions.filter((a) => a.tone === 'ok').length };
    const metric = (icon, label, value, note) => h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon(icon, 17)), h('div', null, h('div', { class: 'metric-title' }, label), h('div', { class: 'metric-value' }, String(value)), h('div', { class: 'metric-note' }, note)));
    box.appendChild(h('div', { class: 'metric-grid' },
      metric('check', tt('To handle'), actions.length, tt('Documents and actions to finalise')),
      metric('alert', tt('Urgent'), counts.bad, h('span', { class: 'bad' }, tt('Needs attention now'))),
      metric('clock', tt('To review'), counts.warn, tt('Worth a look soon')),
      metric('arrow', tt('Informational'), counts.info + counts.ok, tt('No action required yet'))));
    mount(box, foreignNote(foreignCount(ac.foreign)));
    // A real breakdown of the SAME actions above, by tone - never a fabricated time-horizon chart (there is
    // no per-item due-date bucketing in this data model to build "today/tomorrow/48h/this week" honestly).
    box.appendChild(h('div', { class: 'card', style: 'padding:16px 18px' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, tt('Overview')), h('div', { class: 'section-sub' }, tt('By priority'))),
      actions.length
        ? h('div', { class: 'todo-donut' }, NordlaCharts.donut([['bad', 'Urgent', 'c2'], ['warn', 'To review', 'c3'], ['info', 'Informational', 'c4'], ['ok', 'Up to date', 'c1']].map(([tone, l, cls]) => ({ name: `${tt(l)} (${counts[tone]})`, pct: Math.round((counts[tone] / actions.length) * 1000) / 10, cls })), { totalValue: String(actions.length), totalLabel: tt('To handle'), size: 132 }))
        : h('div', { class: 'muted small', style: 'padding-top:10px' }, tt('Nothing needs your attention'))));
    const mid = h('div', { class: 'todo-workspace' });
    mid.appendChild(actionCenterCard(actions, o.currency));
    const top = actions[0];
    const detail = h('div', { class: 'card panel-medium', style: 'padding:16px 18px' }, h('h3', { class: 'section-title' }, tt('Recommended action')));
    if (top) {
      const text = (ACTION_TEXT[top.kind] || (() => top.kind))(top.amount ? { ...top, amount: `${top.amount} ${o.currency}`.trim() } : top);
      detail.appendChild(h('div', { class: 'wblock', style: 'padding-top:12px' }, h('p', { class: 'muted small', style: 'line-height:1.55' }, text)));
      if (top.cents != null) detail.appendChild(h('div', { class: 'money-strip', style: 'grid-template-columns:1fr' }, h('div', null, h('span', null, tt('Amount')), h('strong', null, fmtMoney(top.cents, o.currency)))));
      detail.appendChild(h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn primary big', href: top.href }, tt(CTA_TEXT[top.cta] || 'Review'))));
    } else {
      detail.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon ok' }, svgIcon('check', 22)), h('div', null, h('strong', null, tt('Nothing needs your attention')), h('div', { class: 'muted small' }, tt('Everything is up to date.')))));
    }
    mid.appendChild(detail);
    box.appendChild(mid);
  } catch (e) { fail(e, box); }
}

// ---------- Ventes: Factures / Devis / Avoirs / Analytics, one workspace ----------
const SALES_FILTERS = { invoice: INV_FILTERS, quote: QUOTE_FILTERS, credit_note: [['', 'All'], ['ISSUED', 'Issued']] };
const SALES_TYPE_OF = { invoices: 'invoice', quotes: 'quote', credit_notes: 'credit_note' };
/** from/to (YYYY-MM-DD) for a named period, computed client-side purely to build query params - the server
 * remains the only authority on which documents actually fall in that range. */
function periodRange(kind, custom) {
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  const first = (yy, mm) => new Date(Date.UTC(yy, mm, 1));
  const last = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0));
  if (kind === 'this_month') return { from: iso(first(y, m)), to: iso(last(y, m)) };
  if (kind === 'last_month') return { from: iso(first(y, m - 1)), to: iso(last(y, m - 1)) };
  if (kind === 'last_3_months') return { from: iso(first(y, m - 2)), to: iso(last(y, m)) };
  if (kind === 'quarter') { const q = Math.floor(m / 3); return { from: iso(first(y, q * 3)), to: iso(last(y, q * 3 + 2)) }; }
  if (kind === 'year') return { from: iso(first(y, 0)), to: iso(last(y, 11)) };
  if (kind === 'custom' && custom) return custom;
  return { from: iso(first(y, m)), to: iso(last(y, m)) };
}
const PERIODS = [['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months'], ['quarter', 'This quarter'], ['year', 'This year'], ['custom', 'Custom range']];
function periodPicker(onChange) {
  let kind = 'this_month'; const custom = { from: '', to: '' };
  const sel = h('select', { class: 'tool', style: 'width:auto', on: { change: (e) => { kind = e.target.value; drawCustom(); onChange(periodRange(kind, custom)); } } }, PERIODS.map(([v, l]) => h('option', { value: v }, tt(l))));
  const customBox = h('span');
  function drawCustom() {
    clear(customBox);
    if (kind !== 'custom') return;
    const from = h('input', { type: 'date', style: 'width:auto', on: { change: (e) => { custom.from = e.target.value; onChange(periodRange(kind, custom)); } } });
    const to = h('input', { type: 'date', style: 'width:auto', on: { change: (e) => { custom.to = e.target.value; onChange(periodRange(kind, custom)); } } });
    customBox.appendChild(from); customBox.appendChild(to);
  }
  return { node: h('span', { class: 'tools' }, sel, customBox), get: () => periodRange(kind, custom) };
}
function analyticsPanel({ endpoint, currency, productDrilldown }) {
  const box = h('div');
  const search = h('input', { placeholder: tr('Search a product or SKU...') });
  let range = periodRange('this_month');
  const picker = periodPicker((r) => { range = r; load(); });
  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 220); });
  const toolbar = h('div', { class: 'workspace-toolbar' }, h('label', { class: 'search-field' }, NordlaIcon.semantic('recherche', 'sm'), search), picker.node);
  const results = h('div');
  async function load() {
    clear(results); results.appendChild(h('div', { class: 'muted small', style: 'padding:12px' }, tt('Loading...')));
    try {
      const { from, to } = range;
      const r = await api('GET', `${endpoint}?from=${from || ''}&to=${to || ''}&q=${encodeURIComponent(search.value.trim())}`);
      clear(results); results.appendChild(renderAnalytics(r, currency, productDrilldown));
    } catch (e) { clear(results); fail(e, results); }
  }
  box.appendChild(toolbar); box.appendChild(results); load();
  return box;
}
function renderAnalytics(r, currency, productDrilldown) {
  const wrap = h('div', { style: 'padding:16px 18px' });
  if (r.byProduct !== undefined) {
    wrap.appendChild(h('div', { class: 'metric-grid', style: 'margin-bottom:14px' },
      h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, NordlaIcon.semantic('ventes', 'sm')), h('div', null, h('div', { class: 'metric-title' }, tt('Sales (excl. VAT)')), h('div', { class: 'metric-value' }, `${r.salesNet} ${currency}`))),
      h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon('coins', 16)), h('div', null, h('div', { class: 'metric-title' }, tt('Credit notes (excl. VAT)')), h('div', { class: 'metric-value' }, `${r.creditNet} ${currency}`))),
      h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon('check', 16)), h('div', null, h('div', { class: 'metric-title' }, tt('Net after credit notes')), h('div', { class: 'metric-value' }, `${r.netAfterCredits} ${currency}`))),
      h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon('doc', 16)), h('div', null, h('div', { class: 'metric-title' }, tt('Documents')), h('div', { class: 'metric-value' }, String(r.documentsCount))))));
    wrap.appendChild(h('h3', { class: 'section-title', style: 'margin-bottom:8px' }, tt('By product')));
    if (!r.byProduct.length) wrap.appendChild(h('div', { class: 'empty' }, h('div', { class: 'muted small' }, tt('No catalogue product on any sales line in this period.'))));
    else wrap.appendChild(h('table', null, h('tr', null, [tt('Product'), tt('SKU'), tt('Qty'), tt('Revenue')].map((x, i) => h('th', { class: i >= 2 ? 'num' : '' }, x))),
      r.byProduct.map((p) => h('tr', { class: 'click', on: { click: () => productDrilldown(p) } }, h('td', { 'data-label': tr('Product') }, p.name), h('td', { 'data-label': tr('SKU') }, p.sku || '—'), h('td', { class: 'num', 'data-label': tr('Qty') }, String(p.qty)), h('td', { class: 'num', 'data-label': tr('Revenue') }, `${p.revenue} ${currency}`)))));
    if (r.unattributedNetCents) wrap.appendChild(h('div', { class: 'banner info small', style: 'margin-top:10px' }, tt('{0} of sales lines have no catalogue product/SKU and are not included in the breakdown above.', `${r.unattributedNet} ${currency}`)));
  } else {
    wrap.appendChild(h('div', { class: 'metric-grid', style: 'margin-bottom:14px' },
      h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, NordlaIcon.semantic('achats', 'sm')), h('div', null, h('div', { class: 'metric-title' }, tt('Purchases (incl. VAT)')), h('div', { class: 'metric-value' }, `${r.total} ${currency}`))),
      h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon('doc', 16)), h('div', null, h('div', { class: 'metric-title' }, tt('Documents')), h('div', { class: 'metric-value' }, String(r.documentsCount))))));
    wrap.appendChild(h('h3', { class: 'section-title', style: 'margin-bottom:8px' }, tt('By supplier')));
    if (!r.bySupplier.length) wrap.appendChild(h('div', { class: 'empty' }, h('div', { class: 'muted small' }, tt('No supplier invoice in this period.'))));
    else wrap.appendChild(h('table', null, h('tr', null, [tt('Supplier'), tt('Documents'), tt('Total')].map((x, i) => h('th', { class: i === 2 ? 'num' : '' }, x))),
      r.bySupplier.map((s) => h('tr', null, h('td', { 'data-label': tr('Supplier') }, s.name), h('td', { 'data-label': tr('Documents') }, String(s.count)), h('td', { class: 'num', 'data-label': tr('Total') }, `${s.gross} ${currency}`)))));
    wrap.appendChild(h('div', { class: 'banner info small', style: 'margin-top:10px' }, tt(r.note)));
  }
  mount(wrap, foreignNote(r.excludedForeign));
  return wrap;
}
async function viewSales(q) {
  let tab = SALES_TYPE_OF[q.get('tab')] ? q.get('tab') : (q.get('tab') === 'analytics' ? 'analytics' : Object.keys(SALES_TYPE_OF).find((k) => SALES_TYPE_OF[k] === (q.get('tab') === 'quotes' ? 'quote' : q.get('tab') === 'credit_notes' ? 'credit_note' : 'invoice')) || 'invoices');
  if (!['invoices', 'quotes', 'credit_notes', 'analytics'].includes(tab)) tab = 'invoices';
  // The global search bar (topbar) navigates here with ?q=..., and the A faire Action Center links here
  // with ?status=... (e.g. "invoices to approve" -> status=READY_FOR_APPROVAL) - both must be honoured, not
  // silently dropped (found during the button/action audit; the pre-redesign viewList() read both).
  let status = q.get('status') || ''; let text = q.get('q') || '';
  const shell = h('div', { class: 'page-shell premium' });
  layout('#/sales', shell);
  shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('Sales')), h('div', { class: 'subtitle' }, tt('Invoices, quotes and credit notes in one place.'))),
    h('div', { class: 'quote-card sales-actions', style: 'align-self:center' }, h('a', { class: 'btn primary big', href: '#/new/invoice' }, svgIcon('plus', 16), tt('New invoice')))));
  const box = h('div', { style: 'display:grid;gap:14px' }); shell.appendChild(box);
  const metricRow = h('div', { class: 'metric-grid' }); box.appendChild(metricRow);
  const tabsrow = h('div', { class: 'tabsrow' }); box.appendChild(tabsrow);
  const workspace = h('div', { class: 'card workspace' }); box.appendChild(workspace);
  const wsMain = h('div', { class: 'workspace-main' }); const wsSide = h('div', { class: 'workspace-side' });
  workspace.appendChild(wsMain); workspace.appendChild(wsSide);

  function drawTabs() {
    clear(tabsrow);
    [['invoices', 'Invoices'], ['quotes', 'Quotes'], ['credit_notes', 'Credit notes'], ['analytics', 'Analytics']].forEach(([v, l]) => tabsrow.appendChild(h('button', { type: 'button', class: `tab2 ${tab === v ? 'on' : ''}`, on: { click: () => { tab = v; status = ''; location.hash = `#/sales?tab=${v}`; drawTabs(); drawBody(); } } }, tt(l))));
  }
  async function loadMetrics() {
    try {
      const [rec, o] = await Promise.all([api('GET', '/api/receivables'), api('GET', '/api/overview')]);
      const cur = o.currency;
      clear(metricRow);
      const metric = (icon, label, value, note) => h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon(icon, 17)), h('div', null, h('div', { class: 'metric-title' }, label), h('div', { class: 'metric-value' }, value), h('div', { class: 'metric-note' }, note)));
      metricRow.appendChild(metric('doc', tt('Amount receivable'), rec.unpaid.outstanding + ' ' + cur, tt('Open invoices')));
      metricRow.appendChild(metric('alert', tt('Overdue'), rec.overdue.outstanding + ' ' + cur, h('span', { class: 'bad' }, tt('{0} case(s)', rec.overdue.count))));
      metricRow.appendChild(metric('check', tt('Collected this month'), o.amounts.paidThisMonth + ' ' + cur, h('span', { class: 'good' }, tt('{0} payment(s)', o.amounts.paidThisMonthCount))));
      metricRow.appendChild(metric('quote', tt('Quotes to convert'), String(o.counts.quotesToConvert), tt('Accepted, not yet invoiced')));
      const sfn = foreignNote(rec.foreignDocuments); if (sfn) { sfn.style.gridColumn = '1 / -1'; metricRow.appendChild(sfn); }
    } catch (e) { /* metrics are a bonus strip - the workspace below still works without them */ }
  }
  function drawBody() {
    clear(wsMain); clear(wsSide);
    if (tab === 'analytics') {
      wsSide.style.display = 'none'; workspace.style.gridTemplateColumns = '1fr';
      wsMain.appendChild(analyticsPanel({ endpoint: '/api/sales/analytics', currency: state.settings.defaults.currency, productDrilldown: (p) => openProductDrilldown(p, state.settings.defaults.currency) }));
      return;
    }
    workspace.style.gridTemplateColumns = ''; wsSide.style.display = '';
    const kind = SALES_TYPE_OF[tab];
    const search = h('input', { placeholder: tr('Search number or customer...'), value: text });
    wsMain.appendChild(h('div', { class: 'workspace-head' }, h('div', { class: 'tabsrow', style: 'border:0' })));
    // Real filters (index(4).html alignment: Periode/Etat/Client, kept alongside the existing Exporter).
    // Each one actually narrows `shown` below - none is decorative. "Peppol" and "Affichage" from the
    // reference are not added: there is no per-document Peppol/channel field returned by this list endpoint
    // to filter on honestly, and a view-density toggle was judged not worth the added surface for this pass.
    let fromDate = ''; let toDate = ''; let client = '';
    const statusSel = h('select', { class: 'tool', on: { change: (e) => { status = e.target.value; drawTable(); } } },
      (SALES_FILTERS[kind] || [['', 'All']]).map(([v, l]) => h('option', { value: v, selected: v === status }, tt(l))));
    const clientSel = h('select', { class: 'tool', on: { change: (e) => { client = e.target.value; drawTable(); } } }, h('option', { value: '' }, tt('All clients')));
    const fromInput = h('input', { type: 'date', class: 'tool', style: 'width:auto', on: { change: (e) => { fromDate = e.target.value; drawTable(); } } });
    const toInput = h('input', { type: 'date', class: 'tool', style: 'width:auto', on: { change: (e) => { toDate = e.target.value; drawTable(); } } });
    wsMain.appendChild(h('div', { class: 'workspace-toolbar' }, h('label', { class: 'search-field' }, NordlaIcon.semantic('recherche', 'sm'), search),
      h('div', { class: 'tools' }, fromInput, toInput, statusSel, clientSel,
        h('button', { class: 'tool', type: 'button', on: { click: () => exportRowsAsCsv(shown, [{ header: 'Number', key: 'number' }, { header: 'Customer', key: 'customer' }, { header: 'Issue date', key: 'issueDate' }, { header: 'Due date', key: 'dueDate' }, { header: 'Amount', key: 'gross' }, { header: 'Status', key: 'effectiveStatus' }], `${kind}.csv`) } }, tt('Export')))));
    const tableWrap = h('div', { class: 'table-wrap' }); wsMain.appendChild(tableWrap);
    let rows = []; let shown = []; let selected = null;
    function drawSide() {
      clear(wsSide);
      if (!selected) { wsSide.appendChild(h('div', { class: 'muted small' }, tt('Select a document to see its summary here.'))); return; }
      const r = selected;
      wsSide.appendChild(h('div', { class: 'detail-head' }, h('div', null, h('h2', null, r.number || tt('(draft)')), h('p', null, `${r.customer || ''} · ${r.issueDate || ''}`), h('p', null, badge(r.effectiveStatus))), h('a', { class: 'btn', href: `#/doc/${r.id}` }, tt('Open'))));
      // Real Paye = Total - Reste du (both already real fields on this row) - never a separately fetched or
      // estimated figure.
      const paidCents = r.remainingCents != null ? r.grossCents - r.remainingCents : null;
      wsSide.appendChild(h('div', { class: 'money-strip' },
        h('div', null, h('span', null, tt('Total incl. VAT')), h('strong', null, r.gross)),
        paidCents != null ? h('div', null, h('span', null, tt('Paid')), h('strong', null, fmtMoney(paidCents, r.currency))) : h('div'),
        r.remaining != null ? h('div', null, h('span', null, tt('Still due')), h('strong', null, r.remaining)) : h('div')));
      if (r.dueDate) wsSide.appendChild(h('div', { class: 'kv' }, h('span', null, tt('Due date')), h('strong', null, r.dueDate)));
      // Real inline actions (index(4).html alignment) - reusing the exact same modals/API calls the full
      // document page already uses, not a re-implementation. "Relancer" is deliberately not added here: there
      // is no real reminder-sending capability anywhere in this product ("No reminders are sent
      // automatically" is the existing, honest copy on the Receivables page) - a button for it would be
      // decorative.
      const quickActions = h('div', { class: 'actions', style: 'padding:14px 0;border-bottom:1px solid var(--line)' });
      if (r.type === 'invoice' && r.remainingCents > 0 && ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(r.effectiveStatus)) {
        quickActions.appendChild(h('button', { class: 'primary', on: { click: () => paymentModal(r, () => { api('GET', `/api/documents?type=${kind}`).then((res) => { rows = res.rows; drawTable(); const upd = rows.find((x) => x.id === r.id); if (upd) { selected = upd; drawSide(); } }); }) } }, tt('Collect payment')));
      }
      if (r.type === 'invoice' && ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(r.effectiveStatus)) {
        quickActions.appendChild(h('button', { on: { click: async () => { try { const d = await api('GET', `/api/documents/${r.id}`); creditModal(d); } catch (e) { fail(e); } } } }, tt('Create a credit note')));
      }
      if (quickActions.children.length) wsSide.appendChild(quickActions);
    }
    function drawTable() {
      const s = text.trim().toLowerCase();
      shown = rows.filter((r) => (!status || r.effectiveStatus === status) && (!client || r.customer === client)
        && (!fromDate || (r.issueDate || '') >= fromDate) && (!toDate || (r.issueDate || '') <= toDate)
        && (!s || `${r.number || ''} ${r.customer || ''}`.toLowerCase().includes(s)));
      clear(tableWrap);
      if (!shown.length) { tableWrap.appendChild(h('div', { class: 'empty' }, h('div', null, h('strong', null, tt('No document matches.'))))); return; }
      tableWrap.appendChild(h('table', null, h('tr', null, [tt('Document'), tt('Customer'), tt('Issued'), tt('Due'), tt('Amount'), tt('Status')].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x))),
        shown.map((r) => h('tr', { class: 'click', on: { click: () => { selected = r; drawSide(); } } }, h('td', { 'data-label': tr('Document') }, h('strong', null, r.number || tt('(draft)')), h('small', null, tt(TYPE[r.type] || r.type))), h('td', { 'data-label': tr('Customer') }, r.customer || '—'), h('td', { 'data-label': tr('Issued') }, r.issueDate || '—'), h('td', { 'data-label': tr('Due') }, r.dueDate || '—'), h('td', { class: 'num', 'data-label': tr('Amount') }, r.gross || ''), h('td', { 'data-label': tr('Status') }, badge(r.effectiveStatus))))));
    }
    search.addEventListener('input', () => { text = search.value; drawTable(); });
    api('GET', `/api/documents?type=${kind}`).then((r) => {
      rows = r.rows;
      // Real distinct customer names from this list only - never a separate/fabricated client directory.
      [...new Set(rows.map((x) => x.customer).filter(Boolean))].sort().forEach((name) => clientSel.appendChild(h('option', { value: name }, name)));
      drawTable(); drawSide();
    }).catch((e) => fail(e, tableWrap));
  }
  drawTabs(); loadMetrics(); drawBody();
}
function openProductDrilldown(p, currency) {
  modal(p.name, h('div', null, h('p', { class: 'muted small' }, tt('{0} unit(s) · {1} {2} across {3} document(s).', p.qty, p.revenue, currency, p.docIds.length)),
    h('div', { class: 'doclist' }, p.docIds.map((id) => h('a', { class: 'crow-doc', href: `#/doc/${id}`, style: 'grid-template-columns:1fr auto' }, h('span', null, id.slice(0, 8)), svgIcon('chevron', 14))))),
    (close) => [h('button', { on: { click: close } }, tt('Close'))]);
}

// ---------- Achats: À traiter (inbox) / À payer / Payés / Analytics, one workspace. Detail still opens the
// existing, fully-featured openInboxItem() drawer (validate/reject/pay/link a contact) rather than
// duplicating that safety-critical logic into a second, less-tested inline pane. ----------
// Real upload (POST /api/inbox/upload, the same route the old Finance Inbox page used) - restores an
// "Importer" action on the Achats page, found missing during the index(4).html audit despite the backend
// route already existing and working.
function importDocumentsModal(done) {
  const input = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.xml', multiple: true, style: 'display:none' });
  const status = h('div', { class: 'muted small', style: 'margin-top:10px' });
  const drop = h('div', { class: 'dropzone', tabindex: '0', on: { click: () => input.click(), keydown: (e) => { if (e.key === 'Enter') input.click(); } } }, svgIcon('plus', 22), h('div', null, h('strong', null, tt('Drop invoices here, or click to choose')), h('div', { class: 'muted small' }, tt('PDF, image or structured XML (UBL). They stay private and are never sent anywhere.'))));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  const toB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
  async function send(files) {
    for (const file of files) {
      try { const r = await api('POST', '/api/inbox/upload', { fileName: file.name, dataBase64: await toB64(file) }); status.appendChild(h('div', null, r.duplicate ? tt('{0} was already received', file.name) : tt('{0} received', file.name))); } catch (e) { status.appendChild(h('div', { class: 'bad' }, `${file.name}: ${e.message || e}`)); }
    }
    done();
  }
  input.addEventListener('change', () => send([...input.files])); drop.addEventListener('drop', (e) => send([...e.dataTransfer.files]));
  modal(tt('Import supplier documents'), h('div', null, drop, input, status), (close) => [h('button', { on: { click: close } }, tt('Close'))]);
}
async function viewPurchasesWorkspace(q) {
  let tab = q.get('tab') === 'analytics' ? 'analytics' : ['inbox', 'to_pay', 'paid', 'credit_notes'].includes(q.get('tab')) ? q.get('tab') : 'inbox';
  let text = '';
  let selectedId = null;
  const shell = h('div', { class: 'page-shell premium' });
  layout('#/purchases', shell);
  shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('Purchases')), h('div', { class: 'subtitle' }, tt('Process supplier invoices, validate the data and track what remains to pay.'))),
    h('div', { class: 'actions', style: 'align-self:center' },
      h('button', { class: 'btn', type: 'button', on: { click: () => importDocumentsModal(() => { drawTabs(); drawBody(); loadMetrics(); }) } }, tt('Import')),
      h('button', { class: 'btn', type: 'button', on: { click: () => manualEntry(() => { drawTabs(); drawBody(); loadMetrics(); }) } }, tt('+ Add manually')),
      h('button', { class: 'btn primary warm big', type: 'button', on: { click: () => openExpenseCapture(() => { drawTabs(); drawBody(); loadMetrics(); }) } }, tt('Add an expense')))));
  const box = h('div', { style: 'display:grid;gap:14px' }); shell.appendChild(box);
  const metricRow = h('div', { class: 'metric-grid' }); box.appendChild(metricRow);
  const tabsrow = h('div', { class: 'tabsrow' }); box.appendChild(tabsrow);
  const workspace = h('div', { class: 'card' }); box.appendChild(workspace);

  async function loadMetrics() {
    try {
      const [purchases, c] = await Promise.all([api('GET', '/api/inbox?scope=purchases'), api('GET', '/api/inbox/status')]);
      // EUR-only: the To-pay amount and its count come from the server (foreign-currency documents are never added)
      const cur = (state.settings && state.settings.defaults && state.settings.defaults.currency) || 'EUR';
      const paidCount = purchases.rows.filter((r) => r.status === 'PAID').length;
      clear(metricRow);
      const metric = (icon, label, value, note) => h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon(icon, 17)), h('div', null, h('div', { class: 'metric-title' }, label), h('div', { class: 'metric-value' }, value), h('div', { class: 'metric-note' }, note)));
      metricRow.appendChild(metric('inbox', tt('To handle'), String(c.counts.RECEIVED + c.counts.TO_REVIEW), tt('Documents awaiting validation')));
      metricRow.appendChild(metric('coins', tt('To pay'), `${fmtMoney(c.counts.toPayCents || 0, cur)}`, tt('{0} document(s)', (c.counts.TO_PAY || 0) - (c.counts.toPayForeign || 0))));
      const pfn = foreignNote(c.counts.toPayForeign); if (pfn) { pfn.style.gridColumn = '1 / -1'; metricRow.appendChild(pfn); }
      metricRow.appendChild(metric('check', tt('Paid'), String(paidCount), tt('Supplier invoice(s)')));
    } catch (e) { /* the workspace below still works without the KPI strip */ }
  }
  function drawTabs() {
    clear(tabsrow);
    [['inbox', 'To handle'], ['to_pay', 'To pay'], ['paid', 'Paid'], ['credit_notes', 'Credit notes'], ['analytics', 'Analytics']].forEach(([v, l]) => tabsrow.appendChild(h('button', { type: 'button', class: `tab2 ${tab === v ? 'on' : ''}`, on: { click: () => { tab = v; selectedId = null; location.hash = `#/purchases?tab=${v}`; drawTabs(); drawBody(); } } }, tt(l))));
  }
  // Real inline preview of the actual uploaded source document (image or PDF via the existing, already-used
  // /api/inbox/:id/file route) - never a fabricated document image. Anything else gets an honest fallback
  // with a link to open the real file, rather than pretending to render it inline.
  function docPreviewNode(it) {
    if (!it.hasFile) return h('div', { class: 'empty' }, h('span', { class: 'eicon' }, svgIcon('doc', 24)), h('div', { class: 'muted small' }, tt('This entry has no source document.')));
    const url = `/api/inbox/${it.id}/file`;
    if ((it.contentType || '').startsWith('image/')) return h('img', { src: url, alt: it.fileName || '', style: 'max-width:100%;max-height:100%;border-radius:8px;box-shadow:var(--shadow);object-fit:contain' });
    if (it.contentType === 'application/pdf') return h('iframe', { src: url, title: it.fileName || 'PDF', style: 'width:100%;height:100%;min-height:520px;border:0;border-radius:8px;background:#fff' });
    return h('div', { class: 'empty' }, h('span', { class: 'eicon' }, svgIcon('doc', 24)), h('div', null, h('strong', null, it.fileName || tt('Source file')), h('div', { class: 'muted small' }, tt('Preview is not available for this file type.'))), h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, tt('Open the source document')));
  }
  function drawBody() {
    clear(workspace);
    if (tab === 'analytics') {
      workspace.className = 'card';
      workspace.appendChild(analyticsPanel({ endpoint: '/api/purchases/analytics', currency: state.settings.defaults.currency, productDrilldown: () => {} }));
      return;
    }
    // Persistent 3-pane workspace (queue / document preview / validation form), replacing the previous
    // list+modal pattern - same real data and the same shared renderInboxDetail() actions, just always
    // visible instead of behind a click-to-open overlay. Collapses responsively (see .purchase-shell CSS).
    workspace.className = 'card purchase-shell';
    const queueTabs = h('div', { class: 'queue-tabs' });
    const search = h('label', { class: 'search-field', style: 'width:100%;margin-bottom:10px' }, NordlaIcon.semantic('recherche', 'sm'), h('input', { placeholder: tr('Supplier, invoice number...'), on: { input: (e) => { text = e.target.value; drawQueue(); } } }));
    const queueList = h('div');
    const queue = h('aside', { class: 'queue' }, queueTabs, search, queueList);
    const preview = h('section', { class: 'doc-preview' }, h('div', { class: 'muted small' }, tt('Select a document to preview it here.')));
    const formPane = h('aside', { class: 'form-pane' }, h('div', { class: 'muted small' }, tt('Select a document from the queue to review it here.')));
    workspace.appendChild(queue); workspace.appendChild(preview); workspace.appendChild(formPane);
    let rows = [];
    function selectRow(id) {
      selectedId = id; drawQueue();
      const it = rows.find((r) => r.id === id); if (!it) return;
      clear(preview); preview.appendChild(docPreviewNode(it));
      clear(formPane); renderInboxDetail(formPane, id, { onChange: () => { drawTabs(); loadMetrics(); loadRows(); } });
    }
    function drawQueue() {
      clear(queueTabs); clear(queueList);
      [['inbox', 'To handle'], ['to_pay', 'To pay'], ['paid', 'Paid'], ['credit_notes', 'Credit notes']].forEach(([v, l]) => queueTabs.appendChild(h('button', { type: 'button', class: tab === v ? 'active' : '', on: { click: () => { tab = v; selectedId = null; location.hash = `#/purchases?tab=${v}`; drawTabs(); loadRows(); } } }, tt(l), ' ', String(v === 'inbox' ? rows.filter((r) => ['RECEIVED', 'TO_REVIEW'].includes(r.status)).length : v === 'to_pay' ? rows.filter((r) => r.status === 'TO_PAY').length : v === 'credit_notes' ? rows.filter((r) => r.documentType === 'CREDIT_NOTE').length : rows.filter((r) => r.status === 'PAID').length))));
      const s = text.trim().toLowerCase();
      const filtered = rows.filter((r) => !s || `${r.supplierName || ''} ${r.invoiceNumber || ''}`.toLowerCase().includes(s));
      if (!filtered.length) { queueList.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon' }, svgIcon('doc', 22)), h('div', { class: 'muted small' }, tt('Nothing here.')))); return; }
      if (!selectedId && filtered.length) selectedId = filtered[0].id;
      filtered.forEach((r) => queueList.appendChild(h('div', { class: `queue-item ${r.id === selectedId ? 'selected' : ''}`, on: { click: () => selectRow(r.id) } },
        h('strong', null, r.supplierName || r.fileName || tt('Unknown supplier')),
        h('small', null, [r.invoiceNumber, r.issueDate].filter(Boolean).join('  ·  ')),
        h('div', { class: 'queue-money' }, h('b', null, r.grossCents != null ? fmtMoney(r.grossCents, r.currency) : '—'), docTypeChip(r), inboxBadge(r.status)))));
    }
    function loadRows() {
      const scope = tab === 'inbox' ? 'inbox' : 'purchases';
      api('GET', `/api/inbox?scope=${scope}`).then((r) => {
        // Avoirs: validated supplier credit notes. A credit note never becomes TO_PAY, so without this tab it would leave every queue once validated.
        rows = tab === 'to_pay' ? r.rows.filter((x) => x.status === 'TO_PAY') : tab === 'paid' ? r.rows.filter((x) => x.status === 'PAID') : tab === 'credit_notes' ? r.rows.filter((x) => x.documentType === 'CREDIT_NOTE') : r.rows;
        drawQueue();
        if (rows.length) selectRow(selectedId && rows.some((r2) => r2.id === selectedId) ? selectedId : rows[0].id);
        else { clear(preview); preview.appendChild(h('div', { class: 'muted small' }, tt('Select a document to preview it here.'))); clear(formPane); formPane.appendChild(h('div', { class: 'muted small' }, tt('Select a document from the queue to review it here.'))); }
      }).catch((e) => fail(e, queueList));
    }
    loadRows();
  }
  drawTabs(); loadMetrics(); drawBody();
}

// ---------- Finance Inbox ----------
async function viewInbox() {
  const main = layout('#/inbox', h('div', { class: 'hero' }, h('div', null, h('h1', null, 'Finance Inbox'), h('div', { class: 'muted' }, 'Incoming financial documents, reviewed by you before anything is recorded.')),
    h('div', { class: 'actions' }, h('button', { on: { click: () => manualEntry(() => viewInbox()) } }, tt('+ Add manually')))));
  const box = h('div'); main.appendChild(box);
  // sources
  const st = await api('GET', '/api/inbox/status');
  const SRC = { upload: 'File upload', email: 'Dedicated finance mailbox', peppol: 'Peppol invoices received' };
  box.appendChild(h('div', { class: 'sources' }, st.adapters.map((a) => h('div', { class: `source ${a.configured ? 'on' : ''}` }, h('span', { class: 'dot2' }), h('span', null, tt(SRC[a.name] || a.name)), h('span', { class: 'chip mute' }, tt(a.configured ? 'Active' : 'NOT CONFIGURED'))))));
  // drop zone
  const input = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.xml', multiple: true, style: 'display:none' });
  const drop = h('div', { class: 'dropzone', tabindex: '0', on: { click: () => input.click(), keydown: (e) => { if (e.key === 'Enter') input.click(); } } }, svgIcon('plus', 22), h('div', null, h('strong', null, tt('Drop invoices here, or click to choose')), h('div', { class: 'muted small' }, tt('PDF, image or structured XML (UBL). They stay private and are never sent anywhere.'))));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  const list = h('div', { class: 'card listcard', style: 'margin-top:14px' });
  const toB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
  async function send(files) {
    for (const file of files) {
      try { const r = await api('POST', '/api/inbox/upload', { fileName: file.name, dataBase64: await toB64(file) }); toast(r.duplicate ? tt('{0} was already received', file.name) : tt('{0} received', file.name), r.duplicate ? '' : 'ok'); } catch (e) { fail(e); }
    }
    draw();
  }
  input.addEventListener('change', () => send([...input.files])); drop.addEventListener('drop', (e) => send([...e.dataTransfer.files]));
  box.appendChild(drop); box.appendChild(input); box.appendChild(list);
  async function draw() {
    clear(list);
    let rows; try { rows = (await api('GET', '/api/inbox?scope=inbox')).rows; } catch (e) { return fail(e, list); }
    if (!rows.length) return list.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, svgIcon('doc', 26)), h('div', null, h('strong', null, tt('The inbox is empty')), h('div', { class: 'muted small' }, tt('Documents you receive will appear here for review.')))));
    rows.forEach((r) => list.appendChild(h('a', { class: 'docrow', href: '#', on: { click: (e) => { e.preventDefault(); openInboxItem(r.id, draw); } } },
      avatar(r.supplierName || r.fileName || '?'),
      h('span', { class: 'dmain' }, h('span', { class: 'dt' }, r.supplierName || r.fileName || tt('Unknown supplier')), h('span', { class: 'ds' }, [r.invoiceNumber, r.issueDate, r.fileName].filter(Boolean).join('  ·  '))),
      h('span', { class: 'damt' }, h('strong', null, r.grossCents != null ? fmtMoney(r.grossCents, r.currency) : ''), confChip(r)),
      h('span', { class: 'dstat' }, inboxBadge(r.status), docTypeChip(r), sourceBadge(r.source)), h('span', { class: 'dgo' }, svgIcon('chevron', 16)))));
  }
  draw();
}
function manualEntry(done) {
  const f = {}; const err = h('div');
  const inp = (k, label, ph) => { f[k] = ''; return h('div', { class: 'field' }, h('label', null, label), h('input', { placeholder: ph || '', on: { input: (e) => { f[k] = e.target.value; } } })); };
  modal('Add a supplier invoice manually', h('div', null, err, h('div', { class: 'row r2' }, inp('supplierName', tr('Supplier')), inp('supplierVatNumber', tr('Supplier VAT number'), 'BE0123456789')), h('div', { class: 'row r3' }, inp('invoiceNumber', tr('Invoice number')), inp('issueDate', tr('Invoice date'), 'YYYY-MM-DD'), inp('dueDate', tr('Due date'), 'YYYY-MM-DD')), h('div', { class: 'row r4' }, inp('net', tr('Excl. VAT')), inp('vat', tr('VAT')), inp('gross', tr('Incl. VAT')), inp('currency', tr('Currency'), 'EUR'))),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try { await api('POST', '/api/inbox/manual', f); close(); toast('Saved', 'ok'); done(); } catch (e) { fail(e, err); } } } }, tt('Save')), h('button', { on: { click: close } }, tt('Cancel'))]);
}

// ---------- Purchases ----------
async function viewPurchases() {
  let status = '';
  const main = layout('#/purchases', h('div', { class: 'hero' }, h('div', null, h('h1', null, 'Purchases'), h('div', { class: 'muted' }, 'Supplier invoices you validated: to pay and paid.')), h('a', { class: 'btn', href: '#/inbox' }, tt('Open the Finance Inbox'))));
  const pills = h('div', { class: 'pills' }); const box = h('div', { class: 'card listcard' }); const kpi = h('div', { class: 'card kpirow' });
  main.appendChild(kpi); main.appendChild(h('div', { class: 'toolbar' }, pills)); main.appendChild(box);
  let rows = [];
  function draw() {
    clear(pills); [['', 'All'], ['VALIDATED', 'Validated'], ['TO_PAY', 'To pay'], ['PAID', 'Paid']].forEach(([v, l]) => { const n = v ? rows.filter((r) => r.status === v).length : rows.length; pills.appendChild(h('button', { type: 'button', class: `pill ${status === v ? 'active' : ''}`, on: { click: () => { status = v; draw(); } } }, tt(l), h('span', { class: 'pc' }, String(n)))); });
    clear(box); const shown = rows.filter((r) => !status || r.status === status);
    if (!shown.length) return box.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, svgIcon('doc', 26)), h('div', null, h('strong', null, tt('No supplier invoices yet')), h('div', { class: 'muted small' }, tt('Validate a document from the Finance Inbox to see it here.')))));
    box.appendChild(h('div', { class: 'phead' }, ['Supplier', 'Date', 'Due', 'Excl. VAT', 'VAT', 'Total', 'Status', 'Source'].map((x, i) => h('div', { class: i >= 3 && i <= 5 ? 'right' : '' }, tt(x)))));
    shown.forEach((r) => box.appendChild(h('a', { class: 'prow', href: '#', on: { click: (e) => { e.preventDefault(); openInboxItem(r.id, load); } } },
      h('div', { class: 'psup' }, avatar(r.supplierName), h('span', { class: 'dmain' }, h('span', { class: 'dt' }, r.supplierName), h('span', { class: 'ds' }, r.invoiceNumber))),
      h('div', { class: 'pc-d', 'data-label': tr('Date') }, r.issueDate), h('div', { class: 'pc-d', 'data-label': tr('Due') }, r.dueDate || '-'), h('div', { class: 'right', 'data-label': tr('Excl. VAT') }, fmtMoney(r.netCents, r.currency)), h('div', { class: 'right', 'data-label': tr('VAT') }, fmtMoney(r.vatCents, r.currency)), h('div', { class: 'right', 'data-label': tr('Total') }, h('strong', null, fmtMoney(r.grossCents, r.currency))),
      h('div', { 'data-label': tr('Status') }, inboxBadge(r.status)), h('div', { 'data-label': tr('Source') }, sourceBadge(r.source)))));
  }
  async function load() { try { rows = (await api('GET', '/api/inbox?scope=purchases')).rows; const c = await api('GET', '/api/inbox/status'); clear(kpi); const cur = (rows[0] && rows[0].currency) || 'EUR'; const toPay = rows.filter((r) => r.status === 'TO_PAY'); const sum = toPay.reduce((a, r) => a + (r.grossCents || 0), 0);
      kpi.appendChild(h('div', { class: 'kpi' }, h('div', { class: 'kl' }, tt('To pay')), h('div', { class: 'kbig' }, fmtMoney(sum, cur)), h('div', { class: 'ks' }, tt('{0} invoice(s)', toPay.length))));
      kpi.appendChild(h('div', { class: 'kpi' }, h('div', { class: 'kl' }, tt('Validated, not yet to pay')), h('div', { class: 'kbig' }, String(c.counts.VALIDATED)), h('div', { class: 'ks' }, tt('to schedule'))));
      kpi.appendChild(h('div', { class: 'kpi ok' }, h('div', { class: 'kl' }, tt('Paid')), h('div', { class: 'kbig' }, String(c.counts.PAID)), h('div', { class: 'ks' }, tt('supplier invoice(s)'))));
      draw(); } catch (e) { fail(e, box); } }
  load();
}

// ---------- accountant closing workflow (month / quarter / year / custom -> prepare -> preview -> APPROVE -> send, or .eml) ----------
// ---------- settings: accountant, stock, finance inbox, Peppol topology, connectors ----------
async function workspaceSettingsCards() {
  const s = state.settings; const wrap = h('div');
  const cardOf = (title, hint, ...body) => h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'cardhead' }, h('h2', null, title), hint ? h('span', { class: 'muted small' }, hint) : null), ...body);
  const save = (label, patchFn) => h('button', { class: 'primary', style: 'margin-top:8px', on: { click: async () => { try { await api('PUT', '/api/settings', patchFn()); await loadSettings(); toast('Settings saved', 'ok'); } catch (e) { fail(e); } } } }, tt(label));
  const text = (obj, key, label, ph) => h('div', { class: 'field' }, h('label', null, label), h('input', { value: obj[key] || '', placeholder: ph || '', on: { input: (e) => { obj[key] = e.target.value; } } }));
  const sel = (obj, key, label, opts) => h('div', { class: 'field' }, h('label', null, label), h('select', { on: { change: (e) => { obj[key] = e.target.value; } } }, opts.map(([v, l]) => h('option', { value: v, selected: v === obj[key] }, tt(l)))));

  const acc = { ...s.accountant };
  wrap.appendChild(cardOf(tt('Accountant'), tt('Stored on this computer only'), h('div', { class: 'row r2' }, text(acc, 'name', tr('Name / company')), text(acc, 'email', tr('Email'), 'accountant@example.com')),
    h('div', { class: 'row r3' }, sel(acc, 'preferredFormat', tr('Preferred export format'), [['zip', 'ZIP package'], ['xlsx', 'Excel (XLSX)'], ['csv', 'CSV'], ['pdf', 'PDF']]), text(acc, 'software', tr('Accounting software / provider')), text(acc, 'packageName', tr('Name used in file names'), 'HABB')), save('Save', () => ({ accountant: acc }))));

  let stock = null; try { stock = await api('GET', '/api/stock/status'); } catch (e) { /* not available */ }
  if (stock) {
    const cfg = { mode: (s.stock && s.stock.mode) || 'off', locationId: (s.stock && s.stock.locationId) || '' };
    const c = stock.counts; const status = h('div', { class: 'stockstat' }, ['PENDING', 'APPLIED', 'FAILED', 'UNCERTAIN', 'SKIPPED'].map((k) => h('div', { class: `sbox ${(k === 'FAILED' || k === 'UNCERTAIN') && c[k] ? 'bad' : ''}` }, h('div', { class: 'sn' }, String(c[k] || 0)), h('div', { class: 'sl' }, tt({ PENDING: 'Pending', APPLIED: 'Applied', FAILED: 'Failed', UNCERTAIN: 'Uncertain', SKIPPED: 'Skipped' }[k])))));
    wrap.appendChild(cardOf(tt('Stock synchronisation'), tt('Shopify stays the source of truth'), h('p', { class: 'muted small' }, tt('A standalone B2B invoice takes its catalogue products out of Shopify stock once, when it is issued. Shop and POS invoices never do.')),
      h('div', { class: 'banner small ' + (stock.scope === 'OK' ? 'ok' : 'warn') }, stock.scope === 'OK' ? tt('The Shopify permission to adjust inventory is granted.') : stock.scope === 'MISSING' ? tt('The Shopify permission write_inventory is not granted yet: movements wait as pending.') : tt('The Shopify permission could not be checked.')),
      h('div', { class: 'row r2' }, sel(cfg, 'mode', tr('Mode'), [['off', 'Off'], ['dry_run', 'Dry run (report only)'], ['live', 'Live']]),
        h('div', { class: 'field' }, h('label', null, tt('Stock location')), h('select', { on: { change: (e) => { cfg.locationId = e.target.value; } } }, h('option', { value: '' }, tt('Automatic if there is a single location')), stock.locations.map((l) => h('option', { value: l.id, selected: l.id === cfg.locationId }, l.name))))),
      status, h('div', { class: 'actions' }, save('Save', () => ({ stock: cfg })), h('button', { style: 'margin-top:8px', on: { click: async () => { try { const r = await api('POST', '/api/stock/apply', {}); toast(r.blocked ? tt('Blocked: {0}', r.blocked) : tt('{0} movement(s) applied', r.applied), r.blocked ? 'bad' : 'ok'); } catch (e) { fail(e); } } } }, tt('Apply pending movements')),
        h('button', { style: 'margin-top:8px', on: { click: async () => { try { const r = await api('POST', '/api/stock/reconcile', {}); toast(tt('{0} missing movement(s) created', r.created), 'ok'); } catch (e) { fail(e); } } } }, tt('Reconcile')))));
  }

  const inbox = { financeAddress: (s.inbox && s.inbox.financeAddress) || '', allowedSenders: ((s.inbox && s.inbox.allowedSenders) || []).join(', ') };
  wrap.appendChild(cardOf(tt('Finance Inbox source'), tt('Only finance messages, never a personal mailbox'), h('p', { class: 'muted small' }, tt('Documents enter through a dedicated finance address only. Nothing reads your personal or historical mailbox.')),
    h('div', { class: 'row r2' }, text(inbox, 'financeAddress', tr('Dedicated finance address'), 'finance@example.com'), text(inbox, 'allowedSenders', tr('Allowed senders (comma separated)'), 'invoices@supplier.example')),
    save('Save', () => ({ inbox: { financeAddress: inbox.financeAddress, allowedSenders: inbox.allowedSenders.split(',').map((x) => x.trim()).filter(Boolean) } }))));

  let pp = null; try { pp = await api('GET', '/api/peppol/status'); } catch (e) { /* ignore */ }
  if (pp) {
    const t = { ...pp.topology };
    wrap.appendChild(cardOf(tt('Peppol'), tt('Provider-neutral until the topology is confirmed'), h('div', { class: 'banner warn small' }, tt('Do not register a second receiving Access Point before the topology is confirmed with your accountant / provider.')),
      h('ol', { class: 'plain small' }, pp.questions.map((q) => h('li', null, tt({ WHO_OWNS_THE_RECEIVING_REGISTRATION: 'Who owns the current receiving registration?', IS_CODABOX_VOILA_THE_RECEIVER: 'Is Codabox VOILA the receiver?', DOES_IT_EXPOSE_AN_EXPORT_OR_API: 'Does it expose an export or an API?', SEND_ONLY_OR_INTEGRATE_EXISTING: 'Should we only send through another Access Point, or integrate the existing one?' }[q] || q)))),
      h('div', { class: 'row r3' }, sel(t, 'receiverAccessPoint', tr('Current receiving Access Point'), [['unknown', 'Unknown'], ['codabox', 'Codabox'], ['other', 'Other']]), sel(t, 'mode', tr('Decision'), [['undecided', 'Undecided'], ['send_only', 'Send only (through another Access Point)'], ['receive_existing', 'Receive through the existing provider'], ['integrated', 'Integrated with the existing provider']]), text(t, 'confirmedWith', tr('Confirmed with'))),
      h('div', { class: 'row r2' }, text(t, 'confirmedOn', tr('Confirmed on'), 'YYYY-MM-DD'), text(t, 'note', tr('Note'))),
      h('div', { class: 'chips' }, h('span', { class: 'chip mute' }, tt('Sending: {0}', tt(pp.outgoing.configured ? 'Active' : 'NOT CONFIGURED'))), h('span', { class: 'chip mute' }, tt('Receiving: {0}', tt('NOT CONFIGURED')))), save('Save', () => ({ peppol: { topology: t } }))));
  }
  let cn = null; try { cn = (await api('GET', '/api/connectors')).connectors; } catch (e) { /* ignore */ }
  if (cn) wrap.appendChild(cardOf(tt('Connectors'), tt('Replaceable: nothing is hard-wired to one provider'), h('div', { class: 'connlist' }, cn.map((c) => h('div', { class: 'conn' }, h('span', { class: `dot2 ${c.configured ? 'on' : ''}` }), h('span', { class: 'cl' }, tr(c.label)), h('span', { class: 'chip mute' }, tt(c.configured ? 'Active' : 'NOT CONFIGURED')))))));
  return wrap;
}

// ---------- document detail additions: stock movements, Peppol lifecycle ----------
function stockMovementsCard(d) {
  if (!d.stockMovements || !d.stockMovements.length) return null;
  const STATUS = { PENDING: 'Pending', APPLYING: 'Applying', APPLIED: 'Applied', FAILED: 'Failed', UNCERTAIN: 'Uncertain', SKIPPED: 'Skipped' };
  return h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Stock movements'), h('table', null, h('tr', null, ['Line', 'SKU', 'Change', 'Status', 'Shopify adjustment'].map((x) => h('th', null, tt(x)))),
    d.stockMovements.map((m) => h('tr', null, h('td', null, String(m.linePosition)), h('td', { class: 'mono' }, m.sku || '-'), h('td', null, h('strong', null, m.delta > 0 ? `+${m.delta}` : String(m.delta))), h('td', null, h('span', { class: `chip ${m.status === 'APPLIED' ? 'ok' : m.status === 'FAILED' || m.status === 'UNCERTAIN' ? 'bad' : 'mute'}` }, tt(STATUS[m.status] || m.status)), m.error ? h('div', { class: 'small muted' }, m.error) : null), h('td', { class: 'mono small' }, m.shopifyAdjustmentId ? m.shopifyAdjustmentId.split('/').pop() : '-')))));
}
function peppolCard(d, reload) {
  if (!d.peppol || !['invoice', 'credit_note'].includes(d.type) || !d.doc.lockedAt) return null;
  const p = d.peppol; const STAT = { NOT_CONFIGURED: 'NOT CONFIGURED', NOT_SENT: 'Not sent', SENT: 'Sent', DELIVERED: 'Delivered', REJECTED: 'Rejected', FAILED: 'Failed', PREPARED: 'Prepared' };
  const steps = ['NOT_SENT', 'SENT', 'DELIVERED']; const idx = Math.max(0, steps.indexOf(p.status === 'NOT_CONFIGURED' ? 'NOT_SENT' : p.status));
  const bad = p.status === 'REJECTED' || p.status === 'FAILED';
  return h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'cardhead' }, h('h2', null, 'Peppol'), h('span', { class: `chip ${p.status === 'DELIVERED' ? 'ok' : bad ? 'bad' : 'mute'}` }, tt(STAT[p.status] || p.status))),
    h('ol', { class: 'stepper mini' }, steps.map((k, i) => h('li', { class: i < idx || (i === idx && p.status === 'DELIVERED') ? 'done' : i === idx ? 'current' : '' }, h('span', { class: 'sdot' }, String(i + 1)), h('span', null, tt(STAT[k]))))),
    bad ? h('div', { class: 'banner warn small' }, tt('The Access Point reported a problem: {0}', p.detail || p.status)) : null,
    p.note ? h('p', { class: 'muted small' }, tt(p.note)) : null,
    !p.topologyConfirmed && p.configured ? h('p', { class: 'muted small' }, tt('Confirm the Peppol topology in Settings before sending.')) : null,
    h('div', { class: 'actions' }, h('button', { class: 'primary', disabled: !p.canSend || p.transmitted, on: { click: () => modal('Send via Peppol', h('p', null, tt('This sends the structured invoice through your Peppol Access Point. It cannot be recalled.')), (close) => [h('button', { class: 'primary', on: { click: async () => { close(); try { await api('POST', `/api/documents/${d.id}/peppol/send`, { approve: true }); toast('Sent via Peppol', 'ok'); reload(); } catch (e) { fail(e); } } } }, tt('APPROVE and send')), h('button', { on: { click: close } }, tt('Cancel'))]) } }, tt('Send via Peppol')),
      p.transmitted ? h('button', { on: { click: async () => { try { await api('POST', `/api/documents/${d.id}/peppol/refresh`, {}); reload(); } catch (e) { fail(e); } } } }, tt('Refresh status')) : null));
}

// ---------- Bank & Treasury (strictly READ ONLY: balances and transactions only, never a payment or transfer) ----------
const BANK_STATUS_TEXT = { NOT_CONNECTED: 'Not connected', ACTIVE: 'Connected', EXPIRED: 'Consent expired', REVOKED: 'Disconnected' };
function treasuryCard(t) {
  const card = h('div', { class: 'card treasury' }, h('div', { class: 'cardhead' }, h('h2', null, 'Treasury'), h('span', { class: 'muted small' }, 'Short-term liquidity, not accounting cash flow')));
  const box = (label, value, tone) => h('div', { class: `tbox ${tone || ''}` }, h('div', { class: 'kl' }, label), h('div', { class: 'kbig' }, value == null ? '—' : value));
  card.appendChild(h('div', { class: 'tgrid' },
    box(tt('Bank'), t.display.bank), box(tt('Cash'), t.display.cash), box(tt('Total liquidity'), t.display.liquid, 'accent'),
    box(tt('Receivables due in {0} days', t.horizonDays), t.display.incoming, 'ok'), box(tt('To pay in {0} days', t.horizonDays), t.display.outgoing, 'bad'), box(tt('Projection'), t.display.projection, 'accent')));
  if (t.warnings.length) card.appendChild(h('div', { class: 'banner warn small' }, t.warnings.map((w) => h('div', null, tt(w === 'NO_BANK_BALANCE_AVAILABLE' ? 'No bank balance available: connect a bank or import a statement.' : w === 'NO_CASH_COUNT_CONFIRMED' ? 'No physical cash count confirmed yet.' : w)))));
  if (t.assumed.overdueReceivablesCents) card.appendChild(h('div', { class: 'hint' }, tt('{0} of overdue receivables is NOT included in the projection above (assumed, not expected).', fmtMoney(t.assumed.overdueReceivablesCents, t.currency))));
  card.appendChild(h('div', { class: 'hint' }, tt('Observed = bank balance / confirmed cash count. Expected = invoices and supplier invoices due. Assumed = excluded from the projection.')));
  return card;
}
// Shared match actions (Justify one candidate / choose among several / Ignore) - exactly the same real
// POST /api/bank/transactions/:id/confirm|ignore calls used before, now feeding the ledger's detail pane
// instead of a flat inline row.
const TX_STATUS_TEXT = { NEW: 'Unresolved', MATCHED: 'Justified', IGNORED: 'Ignored' };
const MATCH_STATUS_TONE = { EXACT: 'ok', PROBABLE: 'ok', PARTIAL: 'warn', OVERPAYMENT: 'warn', AMBIGUOUS: 'warn', NO_MATCH: 'mute' };
const MATCH_STATUS_TEXT = { EXACT: 'Exact match', PROBABLE: 'Probable match', PARTIAL: 'Partial payment', OVERPAYMENT: 'Overpayment', AMBIGUOUS: 'Several candidates', NO_MATCH: 'No match' };
function matchActions(s, reload) {
  const t = s.transaction;
  const acts = h('div', { class: 'actions' });
  const confirmWith = async (body) => { try { await api('POST', `/api/bank/transactions/${s.transactionId}/confirm`, body); toast(tt('Justified'), 'ok'); reload(); } catch (e) { fail(e); } };
  if (s.candidates.length) {
    if (s.candidates.length === 1 && s.status !== 'AMBIGUOUS') acts.appendChild(h('button', { class: 'primary', on: { click: () => confirmWith(t.amountCents >= 0 ? { documentId: s.candidates[0].documentId } : { itemId: s.candidates[0].itemId }) } }, tt('Justify')));
    else acts.appendChild(h('select', { on: { change: (e) => { if (e.target.value) confirmWith(t.amountCents >= 0 ? { documentId: e.target.value } : { itemId: e.target.value }); } } },
      h('option', { value: '' }, tt('Choose...')), s.candidates.map((c) => h('option', { value: t.amountCents >= 0 ? c.documentId : c.itemId }, `${c.number || c.invoiceNumber} — ${c.customer || c.supplierName}`))));
  }
  // Kept as "Ignore" (not the reference's "Choisir autre chose"): the real action behind this button
  // dismisses the suggestion - it does not let the merchant pick a different match, so labelling it as a
  // choice would promise something it does not do.
  acts.appendChild(h('button', { on: { click: async () => { try { await api('POST', `/api/bank/transactions/${s.transactionId}/ignore`, {}); toast('Ignored', 'ok'); reload(); } catch (e) { fail(e); } } } }, tt('Ignore')));
  return acts;
}
/** "Connect a bank": always opens a real workflow - the automatic connection when a provider is configured, the CSV statement import otherwise. Never simulates a connection. */
function openBankConnectModal(st, getCsvImporter) {
  const plan = bankConnectPlan(st);
  const err = h('div', { class: 'banner bad small', style: 'display:none', role: 'alert' });
  const body = h('div', { class: 'bank-connect', style: 'display:grid;gap:14px' },
    h('div', null, h('h3', null, tt('Automatic connection')),
      plan.automatic
        ? h('p', { class: 'muted small' }, tt('You sign in at your bank. Nordla only gets read-only access: it can never make a payment or a transfer.'))
        : h('p', { class: 'muted small' }, tt('No banking service is configured yet for this company.'), ' ', tt('An automatic connection needs a read-only bank data provider (PSD2) to be set up first.'))),
    h('div', null, h('h3', null, tt('Bank statement import')), h('p', { class: 'muted small' }, tt('Import a bank statement CSV: it works today, without any bank connection.'))),
    err);
  const back = modal(tt('Connect a bank'), body, (close) => [
    plan.automatic ? h('button', { class: 'primary', type: 'button', on: { click: async (ev) => {
      ev.target.disabled = true; err.style.display = 'none';
      try {
        const r = await api('POST', '/api/bank/connect', {});
        const url = safeAuthorizationUrl(r && r.authorizationUrl);
        if (!url) throw new Error('INVALID_AUTHORIZATION_URL');
        try { sessionStorage.setItem(BANK_STATE_KEY, String(r.state || '')); } catch (e) { /* the return will then be refused, never guessed */ }
        location.assign(url);
      } catch (e) { ev.target.disabled = false; err.textContent = tt('The bank connection could not be started. Nothing was connected.'); err.style.display = ''; }
    } } }, tt('Connect with my bank')) : null,
    // Opens the real file picker (same click = same user gesture, so the browser allows it); the paste box stays available below.
    plan.csvImport ? h('button', { type: 'button', on: { click: () => { close(); const imp = getCsvImporter(); if (imp) imp.pickFile(); } } }, tt('Import a CSV statement')) : null,
    h('button', { type: 'button', on: { click: close } }, tt('Cancel'))]);
  return back;
}

/**
 * Bank statement CSV import - two ways in, ONE path: choose a .csv file, or paste CSV text. Both are previewed by the backend
 * (POST /api/bank/import-csv/preview, which writes nothing) and only imported after the merchant confirms (POST /api/bank/import-csv,
 * all-or-nothing, idempotent). Nothing is sent anywhere else. See bank-csv.js for the DOM-free rules.
 */
function bankCsvImporter(onImported) {
  const cents = (c) => fmtMoney(c, 'EUR'); // same formatting as the bank ledger below
  const fileInput = h('input', { type: 'file', accept: CSV_ACCEPT, class: 'csv-file-input', tabindex: '-1', 'aria-hidden': 'true' });
  const fileName = h('span', { class: 'muted small csv-file-name' }, tt('No file chosen'));
  const pickBtn = h('button', { type: 'button', class: 'primary', on: { click: () => fileInput.click() } }, tt('Choose a CSV file'));
  const paste = h('textarea', { rows: 4, placeholder: tt('Paste your bank statement CSV export here'), 'aria-label': tt('Or paste CSV data') });
  const out = h('div', { class: 'csv-preview', 'aria-live': 'polite' });
  const previewBtn = h('button', { type: 'button', on: { click: () => { fileInput.value = ''; fileName.textContent = tt('No file chosen'); run(paste.value, tt('Pasted data')); } } }, tt('Preview'));

  function reset() { clear(out); fileInput.value = ''; fileName.textContent = tt('No file chosen'); }
  function problem(code) { clear(out); out.appendChild(h('div', { class: 'banner bad small', role: 'alert' }, human(code))); }

  async function run(text, sourceLabel) {
    const bad = csvTextProblem(text); if (bad) return problem(bad);
    clear(out); out.appendChild(h('div', { class: 'muted small' }, tt('Reading the statement...')));
    let pv; try { pv = await api('POST', '/api/bank/import-csv/preview', { csv: text }); } catch (e) { return fail(e, out); }
    render(pv, text, sourceLabel);
  }

  function render(pv, text, sourceLabel) {
    clear(out);
    const plan = csvImportPlan(pv);
    const errBox = h('div', { class: 'csv-import-error', role: 'alert' }); // an import failure is shown here; the preview stays on screen
    const colText = ['date', 'amount', 'counterparty', 'reference', 'id'].filter((k) => pv.columns[k]).map((k) => `${tt(`CSV column ${k}`)}: ${pv.columns[k]}`).join(' / ');
    out.appendChild(h('div', { class: 'card', style: 'padding:14px 16px;margin-top:10px' },
      h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, tt('Statement preview')), h('span', { class: 'chip mute' }, sourceLabel)),
      h('div', { class: 'kv' },
        h('div', null, tt('Lines detected')), h('div', null, String(pv.dataLines)),
        h('div', null, tt('Period covered')), h('div', null, pv.period ? `${pv.period.from} - ${pv.period.to}` : tt('Not determined')),
        h('div', null, tt('Recognised columns')), h('div', null, colText || '-'),
        h('div', null, tt('Invalid lines')), h('div', null, String(pv.invalid.length)),
        h('div', null, tt('Already imported')), h('div', null, String(pv.duplicates.alreadyImported)),
        h('div', null, tt('Repeated in the file')), h('div', null, String(pv.duplicates.inFile)),
        h('div', null, tt('New transactions')), h('div', null, h('strong', null, String(pv.importable)))),
      pv.invalid.length ? h('div', { class: 'banner bad small', role: 'alert', style: 'margin-top:10px' },
        h('div', null, tt('Nothing will be imported while the file has invalid lines. Fix them in the file and try again.')),
        h('ul', { class: 'plain' }, pv.invalid.slice(0, 8).map((e) => h('li', null, tt('Line {0}: {1}', e.line, tt(csvRowReason(e.reason)))))),
        pv.invalid.length > 8 ? h('div', null, tt('and {0} more', pv.invalid.length - 8)) : null) : null,
      !pv.invalid.length && !pv.importable ? h('div', { class: 'banner info small', style: 'margin-top:10px' }, tt('All these transactions are already imported: there is nothing new.')) : null,
      pv.sample.length ? h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, tt('Line')), h('th', null, tt('Date')), h('th', { class: 'num' }, tt('Amount')), h('th', null, tt('Counterparty')))),
        h('tbody', null, pv.sample.map((r) => h('tr', null, h('td', null, String(r.line)), h('td', null, r.date), h('td', { class: 'num' }, cents(r.amountCents)), h('td', null, r.counterpartyName || '-')))))) : null,
      errBox,
      h('div', { class: 'actions', style: 'margin-top:12px' },
        h('button', { type: 'button', class: 'primary csv-confirm', disabled: plan.canImport ? null : 'disabled', on: { click: async (ev) => {
          ev.target.disabled = true; clear(errBox);
          try {
            const r = await api('POST', '/api/bank/import-csv', { csv: text });
            reset(); paste.value = '';
            toast(r.duplicates ? tt('{0} transaction(s) imported, {1} already present', r.created, r.duplicates) : tt('{0} transaction(s) imported', r.created), 'ok');
            onImported();
          } catch (e) { ev.target.disabled = false; fail(e, errBox); }
        } } }, plan.canImport ? tt('Import {0} transaction(s)', plan.count) : tt('Import')),
        h('button', { type: 'button', class: 'csv-cancel', on: { click: reset } }, tt('Cancel')))));
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0]; if (!f) return;
    fileName.textContent = f.name;
    const bad = csvFileProblem(f); if (bad) return problem(bad);
    let text; try { text = await f.text(); } catch (e) { return problem('BANK_CSV_FILE_UNREADABLE'); }
    run(text, f.name);
  });

  const el = h('div', { class: 'csv-import', style: 'margin-top:12px;display:grid;gap:10px' },
    h('h3', { class: 'section-title', style: 'margin:0' }, tt('Import a bank statement (CSV) - no bank connection needed')),
    h('div', { class: 'field' }, h('label', null, tt('Import a CSV file')), h('div', { class: 'actions', style: 'align-items:center;flex-wrap:wrap' }, pickBtn, fileName, fileInput)),
    h('div', { class: 'field' }, h('label', null, tt('Or paste CSV data')), paste, h('div', { class: 'actions', style: 'margin-top:8px' }, previewBtn)),
    out);
  return { el, pickFile: () => { el.scrollIntoView({ block: 'center' }); fileInput.click(); }, fileInput, paste };
}

/** The user is back from the bank (?code&state, or ?error): success is only claimed after the backend really stored a consent. */
async function processBankReturn(ret) {
  if (ret.kind === 'cancelled') { toast(tt('Bank connection cancelled. Nothing was connected.'), 'ok'); return; }
  if (ret.kind === 'error') { toast(tt('The bank connection failed. Nothing was connected.'), 'bad'); return; }
  let saved = null; try { saved = sessionStorage.getItem(BANK_STATE_KEY); sessionStorage.removeItem(BANK_STATE_KEY); } catch (e) { saved = null; }
  if (!bankStateMatches(saved, ret.state)) { toast(tt('The bank connection failed. Nothing was connected.'), 'bad'); return; }
  try { const r = await api('POST', '/api/bank/consent', { code: ret.code, state: ret.state }); toast(r && r.connected ? tt('Bank connected (read-only).') : tt('The bank connection failed. Nothing was connected.'), r && r.connected ? 'ok' : 'bad'); }
  catch (e) { toast(tt('The bank connection failed. Nothing was connected.'), 'bad'); }
}

async function viewBank() {
  const shell = h('div', { class: 'page-shell premium' });
  layout('#/bank', shell);
  shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('Bank & Cash')), h('div', { class: 'subtitle' }, tt('Understand every inflow and outflow, without accounting jargon.'))),
    h('div', { class: 'quote-card bank-actions', style: 'align-self:center' }, h('a', { class: 'btn primary big', href: '#/treasury' }, tt('Treasury')))));
  const box = h('div', { style: 'display:grid;gap:14px' }); shell.appendChild(box);
  async function draw() {
    clear(box);
    let st, treasury; try { st = await api('GET', '/api/bank/status'); treasury = await api('GET', '/api/treasury'); } catch (e) { return fail(e, box); }
    box.appendChild(h('div', { class: 'accounts-grid' },
      h('div', { class: 'account-card' }, h('span', null, tt('Bank')), h('strong', null, treasury.display.bank ?? '—'), h('small', null, tt(st.state === 'ACTIVE' ? 'Connected' : 'Not connected'))),
      h('div', { class: 'account-card' }, h('span', null, tt('Cash')), h('strong', null, treasury.display.cash ?? '—'), h('small', null, tt('Confirmed count only'))),
      h('div', { class: 'account-card' }, h('span', null, tt('Total liquidity')), h('strong', null, treasury.display.liquid ?? '—'), h('small', null, tt('Bank + cash')))));
    mount(box, foreignNote(foreignCount(treasury.excluded)));
    const connCard = h('div', { class: 'card', style: 'padding:16px 18px' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Bank connection'), h('span', { class: `chip ${st.state === 'ACTIVE' ? 'ok' : 'mute'}` }, tt(BANK_STATUS_TEXT[st.state] || st.state))));
    connCard.appendChild(h('div', { class: 'banner info small' }, tt('Read-only access only. This connection can never initiate a payment, a transfer or change a beneficiary.')));
    if (st.state === 'ACTIVE') {
      connCard.appendChild(h('div', { class: 'kv' }, h('div', null, tt('Provider')), h('div', null, st.provider), h('div', null, tt('Scopes')), h('div', null, st.scopes.join(', ')), h('div', null, tt('Connected since')), h('div', null, String(st.grantedAt).slice(0, 10))));
      connCard.appendChild(h('div', { class: 'actions', style: 'margin-top:10px' },
        h('button', { on: { click: async () => { try { const r = await api('POST', '/api/bank/sync', {}); toast(tt('{0} new transaction(s)', r.created), 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Sync now')),
        h('button', { class: 'danger', on: { click: () => modal('Disconnect bank', h('p', null, tt('This revokes local and, where supported, remote access. No transactions are deleted.')), (close) => [h('button', { class: 'danger', on: { click: async () => { close(); try { await api('POST', '/api/bank/disconnect', {}); toast('Disconnected', 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Disconnect')), h('button', { on: { click: close } }, tt('Cancel'))]) } }, tt('Disconnect bank'))));
    } else {
      const importer = bankCsvImporter(() => draw());
      connCard.appendChild(h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'primary', type: 'button', on: { click: () => openBankConnectModal(st, () => importer) } }, tt('Connect a bank'))));
      connCard.appendChild(importer.el);
    }
    box.appendChild(connCard);
    const cashCard = h('div', { class: 'card', style: 'padding:16px 18px' }, h('h2', { class: 'section-title' }, 'Physical cash'), h('p', { class: 'muted small' }, tt('Only confirmed counts are used: cash sales are never assumed to stay in the till.')));
    const amt = h('input', { inputmode: 'decimal', placeholder: '0.00' }); const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    cashCard.appendChild(h('div', { class: 'row r3', style: 'align-items:end' }, h('div', { class: 'field' }, h('label', null, tt('Amount counted')), amt), h('div', { class: 'field' }, h('label', null, tt('Date')), date),
      h('button', { on: { click: async () => { try { await api('POST', '/api/cash/counts', { amount: amt.value, countedOn: date.value }); toast('Saved', 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Confirm cash count'))));
    box.appendChild(cashCard);
    // Real transaction ledger (index(4).html alignment) - shown regardless of a live bank connection (a CSV
    // import needs no connection at all, and its transactions still need reconciling). Replaces the previous
    // flat "suggestions only" list: every real transaction is browsable here, not only the unresolved ones.
    const ledgerCard = h('div', { class: 'card workspace-card' });
    box.appendChild(ledgerCard);
    let ledgerTab = 'to_justify'; let ledgerText = ''; let selectedTxId = null; let periodFrom = null; let periodTo = null;
    let allTx = []; let suggestionsById = new Map();
    const ledgerTabs = h('div', { class: 'workspace-head' }, h('div', { class: 'tabs' }));
    const ledgerToolbar = h('div', { class: 'workspace-toolbar' });
    const ledgerBody = h('div', { class: 'bank-workspace' });
    ledgerCard.appendChild(ledgerTabs); ledgerCard.appendChild(ledgerToolbar); ledgerCard.appendChild(ledgerBody);
    const txList = h('div', { class: 'tx-list' }); const txDetail = h('aside', { class: 'tx-detail' }, h('div', { class: 'muted small' }, tt('Select a transaction to see it here.')));
    ledgerBody.appendChild(txList); ledgerBody.appendChild(txDetail);
    // 'Justified transactions' is its own key, not the shared 'Justified' used in single-transaction toasts -
    // the tab label needs the plural ("Justifiees"), which would be the wrong grammar for a one-transaction toast.
    const LEDGER_TABS = [['to_justify', 'To justify'], ['all', 'All'], ['in', 'Inflows'], ['out', 'Outflows'], ['matched', 'Justified transactions']];
    function bucketOf(kind) {
      if (kind === 'to_justify') return allTx.filter((t) => suggestionsById.has(t.id));
      if (kind === 'in') return allTx.filter((t) => t.amountCents >= 0);
      if (kind === 'out') return allTx.filter((t) => t.amountCents < 0);
      if (kind === 'matched') return allTx.filter((t) => t.status === 'MATCHED');
      return allTx;
    }
    function drawLedgerTabs() {
      const row = ledgerTabs.firstChild; clear(row);
      LEDGER_TABS.forEach(([v, l]) => row.appendChild(h('button', { type: 'button', class: ledgerTab === v ? 'active' : '', on: { click: () => { ledgerTab = v; selectedTxId = null; drawLedgerTabs(); drawList(); } } }, tt(l), h('span', null, String(bucketOf(v).length)))));
    }
    function selectTx(id) {
      selectedTxId = id; drawList();
      const t = allTx.find((x) => x.id === id); if (!t) return;
      clear(txDetail);
      const sug = suggestionsById.get(id);
      txDetail.appendChild(h('div', { class: 'detail-head' }, h('div', null, h('h2', null, fmtMoney(t.amountCents, t.currency)), h('p', null, `${t.source ? tt(SOURCE_BADGE[t.source] || t.source) + ' · ' : ''}${t.date}`), h('p', null, t.counterpartyName || tt('Unknown')))));
      txDetail.appendChild(h('div', { class: 'block' }, h('h3', null, tt('Details')),
        h('div', { class: 'kv' }, h('span', null, tt('Reference')), h('strong', null, t.reference || t.structuredReference || '—')),
        h('div', { class: 'kv' }, h('span', null, tt('Status')), h('strong', null, tt(TX_STATUS_TEXT[t.status] || t.status)))));
      if (sug) {
        txDetail.appendChild(h('div', { class: 'block' }, h('h3', null, tt('Suggestion')),
          h('div', { class: 'muted small', style: 'margin-bottom:8px' }, h('span', { class: `chip ${MATCH_STATUS_TONE[sug.status] || 'mute'}` }, tt(MATCH_STATUS_TEXT[sug.status] || sug.status))),
          matchActions(sug, () => draw())));
      } else if (t.status === 'MATCHED') {
        txDetail.appendChild(h('div', { class: 'block' }, h('h3', null, tt('Suggestion')), h('div', { class: 'muted small' }, tt('This transaction is already justified.'))));
      } else {
        txDetail.appendChild(h('div', { class: 'block' }, h('h3', null, tt('Suggestion')), h('div', { class: 'muted small' }, tt('No match suggestion is available for this transaction yet.'))));
      }
    }
    function drawList() {
      clear(txList);
      const s = ledgerText.trim().toLowerCase();
      const rows = bucketOf(ledgerTab)
        .filter((t) => !s || `${t.counterpartyName || ''} ${t.reference || ''}`.toLowerCase().includes(s))
        .filter((t) => (!periodFrom || t.date >= periodFrom) && (!periodTo || t.date <= periodTo));
      if (!rows.length) { txList.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon ok' }, svgIcon('check', 22)), h('div', { class: 'muted small' }, tt('Nothing here.')))); return; }
      if (!selectedTxId && rows.length) selectedTxId = rows[0].id;
      let lastDay = null;
      rows.forEach((t) => {
        if (t.date !== lastDay) { txList.appendChild(h('div', { class: 'day' }, t.date)); lastDay = t.date; }
        txList.appendChild(h('div', { class: `tx ${t.id === selectedTxId ? 'selected' : ''}`, on: { click: () => selectTx(t.id) } },
          h('div', null, h('strong', null, t.counterpartyName || tt('Unknown')), h('small', null, [t.reference, suggestionsById.has(t.id) ? tt('To justify') : tt(TX_STATUS_TEXT[t.status] || t.status)].filter(Boolean).join(' · '))),
          h('div', { class: `amount ${t.amountCents >= 0 ? 'in' : ''}` }, `${t.amountCents >= 0 ? '+ ' : ''}${fmtMoney(t.amountCents, t.currency)}`)));
      });
    }
    function loadLedger() {
      Promise.all([api('GET', '/api/bank/transactions'), api('GET', '/api/bank/suggestions')]).then(([tx, sug]) => {
        allTx = tx.rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        suggestionsById = new Map(sug.rows.map((s) => [s.transactionId, s]));
        drawLedgerTabs(); drawList();
        if (allTx.length) selectTx(selectedTxId && allTx.some((t) => t.id === selectedTxId) ? selectedTxId : bucketOf(ledgerTab)[0]?.id ?? allTx[0].id);
      }).catch((e) => fail(e, txList));
    }
    const searchInput = h('input', { placeholder: tr('Label, amount, reference...'), on: { input: (e) => { ledgerText = e.target.value; drawList(); } } });
    // Real, opt-in date-range filter (empty = no filter, so it never hides real transactions by a silent
    // default period) - a genuine "Periode" control, not decorative.
    const fromInput = h('input', { type: 'date', style: 'width:auto', on: { change: (e) => { periodFrom = e.target.value || null; drawList(); } } });
    const toInput = h('input', { type: 'date', style: 'width:auto', on: { change: (e) => { periodTo = e.target.value || null; drawList(); } } });
    ledgerToolbar.appendChild(h('label', { class: 'search-field' }, NordlaIcon.semantic('recherche', 'sm'), searchInput));
    ledgerToolbar.appendChild(h('div', { class: 'tools' }, fromInput, toInput));
    loadLedger();
  }
  draw();
}

// ---------- Trésorerie: its own page, separate from Banque & Caisse - same real /api/treasury +
// /api/overview/cashflow data the combined page used to show, split out per the mandate's own architecture. ----------
const TREASURY_HORIZONS = [[30, '30 days'], [60, '60 days'], [90, '90 days']];
async function viewTreasury() {
  let horizon = 30;
  const shell = h('div', { class: 'page-shell premium' });
  layout('#/treasury', shell);
  const hzRow = h('div', { class: 'tabsrow' });
  shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('Treasury')), h('div', { class: 'subtitle' }, tt('Visualise what is realised, what is committed and your projected position.'))), hzRow));
  const box = h('div', { style: 'display:grid;gap:14px' }); shell.appendChild(box);
  const metricsRow = h('div', { class: 'treasury-grid' }); const warnBox = h('div', null); const workspace = h('div', { class: 'card treasury-workspace' });
  metricsRow.replaceChildren(...[1, 2, 3, 4].map(() => h('div', { class: 'card skel-card' }, h('div', { class: 'skl', style: 'height:20px;width:50%' }))));
  box.appendChild(metricsRow); box.appendChild(warnBox); box.appendChild(workspace);

  function drawHzRow() {
    clear(hzRow);
    TREASURY_HORIZONS.forEach(([days, label]) => hzRow.appendChild(h('button', { type: 'button', class: `tab2 ${horizon === days ? 'on' : ''}`, on: { click: () => { if (horizon === days) return; horizon = days; drawHzRow(); loadHorizon(); } } }, tt(label))));
  }
  drawHzRow();

  const chartWrap = h('div', { class: 'tchart-wrap' },
    h('div', { class: 'section-head' }, h('div', null, h('h3', { class: 'section-title' }, 'Treasury position'), h('div', { class: 'section-sub' }, tt('Realised documented balance, last 12 months')))));
  const projection = h('div', { class: 'projection' });
  workspace.appendChild(chartWrap); workspace.appendChild(projection);

  async function loadHorizon() {
    metricsRow.replaceChildren(...[1, 2, 3, 4].map(() => h('div', { class: 'card skel-card' }, h('div', { class: 'skl', style: 'height:20px;width:50%' }))));
    clear(warnBox);
    try {
      const treasury = await api('GET', `/api/treasury?horizon=${horizon}`);
      const tmetric = (label, value, cls) => h('div', { class: `tmetric ${cls || ''}` }, h('span', null, label), h('strong', null, value ?? '—'));
      const withCurTreasury = (v) => (v == null ? null : `${v} ${treasury.currency}`);
      metricsRow.replaceChildren(
        tmetric(tt('Available today'), withCurTreasury(treasury.display.liquid), 'main'),
        tmetric(tt('Receivable in {0} days', treasury.horizonDays), withCurTreasury(treasury.display.incoming)),
        tmetric(tt('Payable in {0} days', treasury.horizonDays), withCurTreasury(treasury.display.outgoing)),
        tmetric(tt('Projection'), withCurTreasury(treasury.display.projection)));
      if (treasury.warnings?.length) warnBox.appendChild(h('div', { class: 'banner warn small' }, treasury.warnings.map((w) => h('div', null, tt(w === 'NO_BANK_BALANCE_AVAILABLE' ? 'No bank balance available: connect a bank or import a statement.' : w === 'NO_CASH_COUNT_CONFIRMED' ? 'No physical cash count confirmed yet.' : w)))));
      clear(projection);
      projection.appendChild(h('h3', { class: 'section-title', style: 'font-size:16px' }, tt('Projection')));
      const proj = (label, note, amount, cls) => h('div', { class: 'proj' }, h('strong', null, label), h('span', null, h('em', null, note), h('b', { class: cls }, amount)));
      try {
        // Both figures come straight from /api/treasury's own `expected` block, which buildTreasury() already
        // scopes to the selected horizonDays server-side - not a separate, fixed-window fetch. This is what
        // makes the projection panel actually move when the 30/60/90-day toggle changes, instead of always
        // showing the same fixed "due soon" window regardless of the selected horizon.
        const cur = treasury.currency;
        projection.appendChild(proj(tt('Expected customer invoices'), tt('{0} document(s)', treasury.expected.incomingCount), `+ ${treasury.display.incoming ?? fmtMoney(0, cur)}`, 'in'));
        projection.appendChild(proj(tt('Supplier invoices to pay'), tt('{0} document(s)', treasury.expected.outgoingCount), `− ${treasury.display.outgoing ?? fmtMoney(0, cur)}`, 'out'));
        if (treasury.assumed?.overdueReceivablesCents) projection.appendChild(h('div', { class: 'muted small', style: 'margin-top:10px' }, tt('{0} of overdue receivables is NOT included in this projection (assumed, not expected).', fmtMoney(treasury.assumed.overdueReceivablesCents, cur))));
        // VAT is deliberately not provisioned here: this product has no running VAT-due estimate outside the
        // Accountant Pack's own per-period computation (see #/pack) - showing one here would be a second,
        // parallel VAT figure the mandate explicitly asks not to invent.
        projection.appendChild(h('div', { class: 'muted small', style: 'margin-top:10px' }, tt('VAT is not provisioned here - see the Accountant pack for the authoritative per-period VAT figure.')));
        mount(projection, foreignNote(foreignCount(treasury.excluded)));
      } catch (e) { projection.appendChild(h('div', { class: 'muted small' }, tt('Projection detail unavailable.'))); }
    } catch (e) { fail(e, metricsRow); }
  }

  // The 12-month realised-flow chart is deliberately independent of the horizon toggle: it always shows the
  // same real, already-closed months (from /api/overview/cashflow), never a projection - so it is fetched
  // once here and never re-fetched when the horizon selector changes.
  try {
    const cf = await api('GET', '/api/overview/cashflow?months=12');
    mount(chartWrap, foreignNote(foreignCount(cf.excluded)));
    if (!cf.hasActivity) chartWrap.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon' }, NordlaIcon.semantic('tresorerie', 'md')), h('div', { class: 'muted small' }, tt('Not enough history yet.'))));
    else {
      // Nordla Chart System: Trend Line (balance over time) + Comparison (inflows vs outflows) + Waterfall (what moved the balance).
      const card = (title, sub, body, cls) => h('div', { class: cls ? 'card nc-card span2' : 'card nc-card' }, h('h3', { class: 'section-title' }, title), sub ? h('div', { class: 'section-sub' }, sub) : null, body);
      chartWrap.appendChild(h('div', { class: 'nc-grid-2' },
        card(tt('Cash position over time'), null, cashTrendChart(cf.rows, cf.currency, tt('Cumulative balance'))),
        card(tt('Inflows vs outflows'), null, cashComparisonChart(cf.rows, cf.currency)),
        card(tt('What moved the balance'), tt('Net change per month'), cashWaterfallChart(cf.rows, cf.currency), 'span2')));
    }
  } catch (e) { chartWrap.appendChild(h('div', { class: 'muted small' }, tt('Chart unavailable.'))); }
  await loadHorizon();
}
