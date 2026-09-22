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
const INBOX_ERR = { SUPPLIER_NAME_MISSING: 'Supplier name is missing', INVOICE_NUMBER_MISSING: 'Invoice number is missing', ISSUE_DATE_INVALID: 'Invoice date is missing or invalid', DUE_DATE_INVALID: 'Due date is invalid', NET_AMOUNT_INVALID: 'Amount excl. VAT is missing', VAT_AMOUNT_INVALID: 'VAT amount is missing', GROSS_AMOUNT_INVALID: 'Amount incl. VAT is missing', NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL: 'Excl. VAT + VAT does not equal the total', CURRENCY_INVALID: 'Currency is missing' };
const inboxErrText = (c) => tt(INBOX_ERR[c] || c);
/** Integer cents -> text in the UI language, by string composition only (no arithmetic on money). */
const CUR_SYMBOL = { EUR: '€', USD: '$', GBP: '£' };
function fmtMoney(cents, currency) {
  if (cents == null) return '';
  const neg = cents < 0; const a = String(Math.abs(cents)).padStart(3, '0'); const int = a.slice(0, -2); const dec = a.slice(-2);
  const lang = I18N.getLang(); const group = lang === 'en' ? ',' : lang === 'nl' ? '.' : ' '; const point = lang === 'en' ? '.' : ',';
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group); const sym = CUR_SYMBOL[currency] || currency || '';
  const num = `${neg ? '-' : ''}${grouped}${point}${dec}`;
  return lang === 'fr' ? `${num} ${sym}`.trim() : lang === 'nl' ? `${sym} ${num}`.trim() : `${sym}${num}`;
}
const centsToInput = (c) => (c == null ? '' : `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`);

// ---------- item review drawer (edit fields, see the source document, validate / reject) ----------
function openInboxItem(id, reload) {
  const body = h('div', { class: 'drawer-body' }); const err = h('div');
  const back = modal('Supplier invoice', h('div', null, err, body), (close) => [h('button', { on: { click: () => { close(); reload(); } } }, tt('Close'))]);
  back.classList.add('drawer');
  async function draw() {
    clear(body);
    let it; try { it = await api('GET', `/api/inbox/${id}`); } catch (e) { return fail(e, body); }
    const editable = ['RECEIVED', 'TO_REVIEW'].includes(it.status);
    const f = {}; const inp = (k, label, val, ph, cls) => { const el = h('input', { value: val ?? '', placeholder: ph || '', disabled: !editable, on: { input: (e) => { f[k] = e.target.value; } } }); f[k] = val ?? ''; return h('div', { class: `field ${cls || ''}` }, h('label', null, label, it.extraction && it.extraction.fields && it.extraction.fields[k.replace(/^net$|^vat$|^gross$/, (m) => `${m}Cents`)] !== undefined ? h('span', { class: 'conf' }, ` ${Math.round(it.extraction.fields[k.replace(/^net$|^vat$|^gross$/, (m) => `${m}Cents`)] * 100)}%`) : null), el); };
    body.appendChild(h('div', { class: 'drawer-head' }, inboxBadge(it.status), sourceBadge(it.source), confChip(it), it.fileName ? h('span', { class: 'muted small' }, `${it.fileName} · ${fmtBytes(it.sizeBytes || 0)}`) : null));
    if (it.rejectedReason) body.appendChild(h('div', { class: 'banner warn small' }, tt('Rejected: {0}', it.rejectedReason)));
    if (it.extraction && it.extraction.warnings && it.extraction.warnings.length) body.appendChild(h('div', { class: 'banner warn small' }, it.extraction.warnings.map((w) => h('div', null, tt(w === 'TOTALS_DO_NOT_ADD_UP' ? 'The extracted totals do not add up: check them.' : w === 'SUPPLIER_CREDIT_NOTE_REVIEW_MANUALLY' ? 'This looks like a supplier credit note: review it manually.' : w)))));
    if (it.hasFile) body.appendChild(h('div', { style: 'margin:8px 0' }, h('a', { class: 'btn', href: `/api/inbox/${id}/file`, target: '_blank', rel: 'noopener' }, tt('Open the source document'))));
    body.appendChild(h('div', { class: 'row r2' }, inp('supplierName', tr('Supplier'), it.supplierName), inp('supplierVatNumber', tr('Supplier VAT number'), it.supplierVatNumber, 'BE0123456789')));
    body.appendChild(h('div', { class: 'row r3' }, inp('invoiceNumber', tr('Invoice number'), it.invoiceNumber), inp('issueDate', tr('Invoice date'), it.issueDate, 'YYYY-MM-DD'), inp('dueDate', tr('Due date'), it.dueDate, 'YYYY-MM-DD')));
    body.appendChild(h('div', { class: 'row r4' }, inp('net', tr('Excl. VAT'), centsToInput(it.netCents)), inp('vat', tr('VAT'), centsToInput(it.vatCents)), inp('gross', tr('Incl. VAT'), centsToInput(it.grossCents)), inp('currency', tr('Currency'), it.currency, 'EUR')));
    body.appendChild(h('div', { class: 'row r2' }, inp('paymentReference', tr('Payment reference'), it.paymentReference, '+++000/0000/00000+++'), h('div', null)));
    if (it.errors.length && ['RECEIVED', 'TO_REVIEW'].includes(it.status)) body.appendChild(h('div', { class: 'banner info small' }, h('strong', null, tt('Still needed before validation:')), h('ul', { class: 'plain' }, it.errors.map((c) => h('li', null, inboxErrText(c))))));
    const act = h('div', { class: 'actions', style: 'margin-top:12px' });
    const go = (path, payload, msg) => async () => { try { await api('POST', `/api/inbox/${id}/${path}`, payload || {}); toast(msg, 'ok'); draw(); } catch (e) { fail(e, err); } };
    if (editable) {
      act.appendChild(h('button', { on: { click: async () => { try { await api('PUT', `/api/inbox/${id}`, f); toast('Saved', 'ok'); draw(); } catch (e) { fail(e, err); } } } }, tt('Save')));
      act.appendChild(h('button', { class: 'primary', on: { click: async () => { try { await api('PUT', `/api/inbox/${id}`, f); await api('POST', `/api/inbox/${id}/validate`, {}); toast('Validated', 'ok'); draw(); } catch (e) { fail(e, err); } } } }, tt('Validate')));
      act.appendChild(h('button', { class: 'danger', on: { click: () => { const reason = h('input', { placeholder: tr('Reason (required)') }); modal('Reject this document', h('div', null, h('p', { class: 'muted' }, tt('It is not a supplier invoice, or it is a duplicate.')), h('div', { class: 'field' }, h('label', null, tt('Reason')), reason)), (close) => [h('button', { class: 'danger', on: { click: async () => { close(); try { await api('POST', `/api/inbox/${id}/reject`, { reason: reason.value }); toast('Rejected', 'ok'); draw(); } catch (e) { fail(e, err); } } } }, tt('Reject')), h('button', { on: { click: close } }, tt('Cancel'))]); } } }, tt('Reject')));
    } else if (it.status === 'VALIDATED') { act.appendChild(h('button', { class: 'primary', on: { click: go('to-pay', {}, 'Marked to pay') } }, tt('Mark to pay'))); act.appendChild(h('button', { on: { click: go('reopen', {}, 'Reopened') } }, tt('Reopen for correction'))); }
    else if (it.status === 'TO_PAY') {
      act.appendChild(h('button', { class: 'primary', on: { click: () => { const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }); const ref = h('input', { placeholder: tr('Bank reference (optional)') }); modal('Record the payment', h('div', null, h('p', { class: 'muted' }, tt('Amount: {0} {1}', fmtMoney(it.grossCents, it.currency), '')), h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, tt('Date paid')), date), h('div', { class: 'field' }, h('label', null, tt('Reference')), ref))), (close) => [h('button', { class: 'primary', on: { click: async () => { close(); try { await api('POST', `/api/inbox/${id}/pay`, { paidOn: date.value, amount: centsToInput(it.grossCents), reference: ref.value || undefined }); toast('Payment recorded', 'ok'); draw(); } catch (e) { fail(e, err); } } } }, tt('Record payment')), h('button', { on: { click: close } }, tt('Cancel'))]); } } }, tt('Mark as paid')));
      act.appendChild(h('button', { on: { click: go('reopen', {}, 'Reopened') } }, tt('Reopen for correction')));
    } else if (it.status === 'PAID') act.appendChild(h('span', { class: 'muted' }, tt('Paid on {0}', it.paidAt || '')));
    body.appendChild(act);
  }
  draw();
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
      h('span', { class: 'dstat' }, inboxBadge(r.status), sourceBadge(r.source)), h('span', { class: 'dgo' }, svgIcon('chevron', 16)))));
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
function accountantWorkspace() {
  const now = new Date(); const y = now.getFullYear(); const qn = Math.floor(now.getMonth() / 3) + 1;
  const spec = { kind: 'quarter', year: y, quarter: qn === 1 ? 4 : qn - 1, month: now.getMonth() + 1, from: `${y}-01-01`, to: now.toISOString().slice(0, 10) };
  if (qn === 1) spec.year = y - 1;
  const card = h('div', { class: 'card closing' }); const out = h('div');
  const kindSel = h('select', { on: { change: (e) => { spec.kind = e.target.value; draw(); } } }, [['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['custom', 'Custom period']].map(([v, l]) => h('option', { value: v, selected: v === spec.kind }, tt(l))));
  const controls = h('div', { class: 'row r4', style: 'align-items:end' });
  function draw() {
    clear(controls);
    controls.appendChild(h('div', { class: 'field' }, h('label', null, tt('Period')), kindSel));
    const num = (k, label, min, max) => h('div', { class: 'field' }, h('label', null, label), h('input', { type: 'number', value: String(spec[k]), min, max, on: { input: (e) => { spec[k] = Number(e.target.value); } } }));
    if (spec.kind === 'quarter') { controls.appendChild(num('year', tr('Year'), 2000, 2100)); controls.appendChild(h('div', { class: 'field' }, h('label', null, tt('Quarter')), h('select', { on: { change: (e) => { spec.quarter = Number(e.target.value); } } }, [1, 2, 3, 4].map((n) => h('option', { value: String(n), selected: n === spec.quarter }, `Q${n}`))))); }
    else if (spec.kind === 'month') { controls.appendChild(num('year', tr('Year'), 2000, 2100)); controls.appendChild(num('month', tr('Month'), 1, 12)); }
    else if (spec.kind === 'year') controls.appendChild(num('year', tr('Year'), 2000, 2100));
    else { controls.appendChild(h('div', { class: 'field' }, h('label', null, tt('From')), h('input', { type: 'date', value: spec.from, on: { input: (e) => { spec.from = e.target.value; } } }))); controls.appendChild(h('div', { class: 'field' }, h('label', null, tt('To')), h('input', { type: 'date', value: spec.to, on: { input: (e) => { spec.to = e.target.value; } } }))); }
    controls.appendChild(h('div', { class: 'field' }, h('button', { class: 'primary', on: { click: prepare } }, tt('Prepare the accountant file'))));
  }
  async function prepare() {
    clear(out); out.appendChild(h('div', { class: 'skl', style: 'height:80px;margin-top:12px' }));
    try { renderPreview(await api('POST', '/api/accountant/prepare', spec)); } catch (e) { clear(out); fail(e, out); }
  }
  function renderPreview(p) {
    clear(out);
    const warn = (w) => tt({ ACCOUNTANT_EMAIL_MISSING: 'No accountant address is set: add it in Settings.', PACK_INCOMPLETE: 'The period data is incomplete: see the anomalies file in the package.', DIRECT_SEND_NOT_CONFIGURED: 'Direct sending is not configured: download the package or the .eml file and send it yourself.' }[w] || w);
    out.appendChild(h('div', { class: 'preview' },
      h('div', { class: 'pv-head' }, h('div', null, h('div', { class: 'eyebrow' }, tt('Preview')), h('h3', null, p.fileName)), h('span', { class: `badge ${p.completeness}` }, p.completeness)),
      p.warnings.length ? h('div', { class: 'banner warn small' }, p.warnings.map((w) => h('div', null, warn(w)))) : null,
      h('div', { class: 'grid two' },
        h('div', null, h('h4', null, tt('Recipient')), h('div', { class: 'kv' }, h('div', null, tt('Name')), h('div', null, p.recipient.name || '-'), h('div', null, tt('Email')), h('div', null, p.recipient.email || tt('not set'))),
          h('h4', { style: 'margin-top:12px' }, tt('Message')), h('div', { class: 'msgbox' }, h('div', { class: 'small muted' }, tt('Subject')), h('div', null, p.subject), h('pre', null, p.body))),
        h('div', null, h('h4', null, tt('Attachment')), h('div', { class: 'file' }, svgIcon('doc', 16), h('span', null, p.fileName), h('span', { class: 'muted small' }, fmtBytes(p.size))),
          h('h4', { style: 'margin-top:12px' }, tt('Contents')), h('div', { class: 'small muted' }, tt('{0} invoice(s) · {1} credit note(s) · {2} refund(s) · {3} supplier invoice(s)', p.counts.invoices, p.counts.creditNotes, p.counts.refunds, p.counts.supplierInvoices)),
          h('ul', { class: 'plain small filelist' }, p.files.slice(0, 14).map((f) => h('li', null, f.path))), p.files.length > 14 ? h('div', { class: 'muted small' }, tt('+ {0} more files', p.files.length - 14)) : null)),
      h('div', { class: 'actions', style: 'margin-top:14px' },
        h('a', { class: 'btn', href: p.downloadUrl }, tt('Download the ZIP')), h('a', { class: 'btn', href: p.emlUrl }, tt('Download the .eml (fallback)')),
        h('button', { class: 'primary', disabled: !p.recipient.configured, on: { click: () => approveSend(p) } }, tt('Send to accountant')),
        h('span', { class: 'muted small' }, tt('Nothing is sent until you approve.')))));
  }
  function approveSend(p) {
    const ok = h('input', { type: 'checkbox' }); const err = h('div');
    const go = h('button', { class: 'primary', disabled: true, on: { click: async () => { try { await api('POST', `/api/accountant/package/${p.id}/send`, { approve: true, recipient: p.recipient.email }); go.closest('.modal-back').remove(); toast('Sent to the accountant', 'ok'); p.sent = true; renderPreview(p); } catch (e) { if (e.code === 'DIRECT_SEND_NOT_CONFIGURED') { fail(e, err); } else fail(e, err); } } } }, tt('APPROVE and send'));
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    modal('Send to accountant', h('div', null, err, h('p', null, tt('You are about to send {0} to:', p.fileName)), h('div', { class: 'banner info' }, h('strong', null, p.recipient.email), p.recipient.name ? ` (${p.recipient.name})` : ''), h('p', { class: 'muted small' }, tt('The package contains your sales, VAT and documents for the period. Sending goes through: {0}.', p.sendChannel)),
      h('label', { style: 'color:var(--ink)' }, ok, tt('I approve sending this package to this recipient.'))),
      (close) => [go, h('button', { on: { click: close } }, tt('Cancel'))]);
  }
  card.appendChild(h('div', { class: 'cardhead' }, h('h2', null, 'Close the period'), h('span', { class: 'muted small' }, 'One click: the whole accountant file, checked and ready.')));
  card.appendChild(controls); card.appendChild(out); draw();
  return card;
}

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
function suggestionRow(s, currency, reload) {
  const STATUS_TONE = { EXACT: 'ok', PROBABLE: 'ok', PARTIAL: 'warn', OVERPAYMENT: 'warn', AMBIGUOUS: 'warn', NO_MATCH: 'mute' };
  const STATUS_TEXT = { EXACT: 'Exact match', PROBABLE: 'Probable match', PARTIAL: 'Partial payment', OVERPAYMENT: 'Overpayment', AMBIGUOUS: 'Several candidates', NO_MATCH: 'No match' };
  const t = s.transaction;
  const row = h('div', { class: 'txrow' },
    h('div', { class: 'txmain' }, h('span', { class: `chip ${t.amountCents >= 0 ? 'ok' : 'mute'}` }, t.amountCents >= 0 ? tt('IN') : tt('OUT')),
      h('span', { class: 'dt' }, t.counterpartyName || tt('Unknown')), h('span', { class: 'ds' }, [t.date, t.reference].filter(Boolean).join('  ·  '))),
    h('div', { class: 'txamt' }, h('strong', null, fmtMoney(t.amountCents, t.currency))),
    h('div', null, h('span', { class: `chip ${STATUS_TONE[s.status] || 'mute'}` }, tt(STATUS_TEXT[s.status] || s.status))),
    h('div', { class: 'txacts' }));
  const acts = row.lastChild;
  const confirmWith = async (body) => { try { await api('POST', `/api/bank/transactions/${s.transactionId}/confirm`, body); toast('Reconciled', 'ok'); reload(); } catch (e) { fail(e); } };
  if (s.candidates.length) {
    if (s.candidates.length === 1 && s.status !== 'AMBIGUOUS') acts.appendChild(h('button', { class: 'primary', on: { click: () => confirmWith(t.amountCents >= 0 ? { documentId: s.candidates[0].documentId } : { itemId: s.candidates[0].itemId }) } }, tt('Confirm')));
    else acts.appendChild(h('select', { on: { change: (e) => { if (e.target.value) confirmWith(t.amountCents >= 0 ? { documentId: e.target.value } : { itemId: e.target.value }); } } },
      h('option', { value: '' }, tt('Choose...')), s.candidates.map((c) => h('option', { value: t.amountCents >= 0 ? c.documentId : c.itemId }, `${c.number || c.invoiceNumber} — ${c.customer || c.supplierName}`))));
  }
  acts.appendChild(h('button', { on: { click: async () => { try { await api('POST', `/api/bank/transactions/${s.transactionId}/ignore`, {}); toast('Ignored', 'ok'); reload(); } catch (e) { fail(e); } } } }, tt('Ignore')));
  return row;
}
async function viewBank() {
  const main = layout('#/bank', h('div', { class: 'hero' }, h('div', null, h('h1', null, 'Bank & Treasury'), h('div', { class: 'muted' }, 'Read-only: balances and transactions, never a payment or a transfer.'))));
  const box = h('div'); main.appendChild(box);
  async function draw() {
    clear(box);
    let st, treasury; try { st = await api('GET', '/api/bank/status'); treasury = await api('GET', '/api/treasury'); } catch (e) { return fail(e, box); }
    box.appendChild(treasuryCard(treasury));
    const connCard = h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'cardhead' }, h('h2', null, 'Bank connection'), h('span', { class: `chip ${st.state === 'ACTIVE' ? 'ok' : 'mute'}` }, tt(BANK_STATUS_TEXT[st.state] || st.state))));
    connCard.appendChild(h('div', { class: 'banner info small' }, tt('Read-only access only. This connection can never initiate a payment, a transfer or change a beneficiary.')));
    if (st.state === 'ACTIVE') {
      connCard.appendChild(h('div', { class: 'kv' }, h('div', null, tt('Provider')), h('div', null, st.provider), h('div', null, tt('Scopes')), h('div', null, st.scopes.join(', ')), h('div', null, tt('Connected since')), h('div', null, String(st.grantedAt).slice(0, 10))));
      connCard.appendChild(h('div', { class: 'actions', style: 'margin-top:10px' },
        h('button', { on: { click: async () => { try { const r = await api('POST', '/api/bank/sync', {}); toast(tt('{0} new transaction(s)', r.created), 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Sync now')),
        h('button', { class: 'danger', on: { click: () => modal('Disconnect bank', h('p', null, tt('This revokes local and, where supported, remote access. No transactions are deleted.')), (close) => [h('button', { class: 'danger', on: { click: async () => { close(); try { await api('POST', '/api/bank/disconnect', {}); toast('Disconnected', 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Disconnect')), h('button', { on: { click: close } }, tt('Cancel'))]) } }, tt('Disconnect bank'))));
    } else {
      connCard.appendChild(h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'primary', disabled: !st.adapter.configured, on: { click: async () => { try { const r = await api('POST', '/api/bank/connect', {}); toast(tt('Provider: {0}', st.adapter.name), 'ok'); console.log(r.authorizationUrl); } catch (e) { fail(e); } } } }, tt('Connect a bank')),
        !st.adapter.configured ? h('span', { class: 'muted small' }, tt('No bank provider is configured yet.')) : null));
      const csv = h('textarea', { rows: 4, placeholder: tt('Paste your bank statement CSV export here') });
      connCard.appendChild(h('div', { class: 'field', style: 'margin-top:10px' }, h('label', null, tt('Or import a CSV statement (no bank connection needed)')), csv,
        h('button', { style: 'margin-top:8px', on: { click: async () => { try { const r = await api('POST', '/api/bank/import-csv', { csv: csv.value }); toast(tt('{0} transaction(s) imported', r.created), 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Import CSV'))));
    }
    box.appendChild(connCard);
    const cashCard = h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Physical cash'), h('p', { class: 'muted small' }, tt('Only confirmed counts are used: cash sales are never assumed to stay in the till.')));
    const amt = h('input', { inputmode: 'decimal', placeholder: '0.00' }); const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    cashCard.appendChild(h('div', { class: 'row r3', style: 'align-items:end' }, h('div', { class: 'field' }, h('label', null, tt('Amount counted')), amt), h('div', { class: 'field' }, h('label', null, tt('Date')), date),
      h('button', { on: { click: async () => { try { await api('POST', '/api/cash/counts', { amount: amt.value, countedOn: date.value }); toast('Saved', 'ok'); draw(); } catch (e) { fail(e); } } } }, tt('Confirm cash count'))));
    box.appendChild(cashCard);
    // Shown regardless of a live bank connection: a CSV import needs no connection at all, and its transactions still need reconciling.
    const sugCard = h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Transactions to reconcile'));
    try {
      const sug = (await api('GET', '/api/bank/suggestions')).rows;
      sugCard.appendChild(sug.length ? h('div', { class: 'txlist' }, sug.map((s) => suggestionRow(s, treasury.currency, draw))) : h('div', { class: 'empty' }, h('span', { class: 'eicon ok' }, svgIcon('check', 22)), h('div', null, h('strong', null, tt('Nothing to reconcile')))));
    } catch (e) { fail(e, sugCard); }
    box.appendChild(sugCard);
  }
  draw();
}
