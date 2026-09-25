'use strict';
// Pack comptable v1 (prepare -> control -> complete -> download) and expense capture (Achats).
// Loaded after app.js and views-workspace.js: it uses their globals (h, api, tt, tr, modal, toast, layout, fail, clear, svgIcon, state, ...).
// Every figure comes from /api/pack-comptable/* (the report layer); this file only lays it out. Text = English message ids (see lang-fr / lang-nl).

(function () {
  const CATS = ['clients', 'credit_notes', 'purchases', 'sales', 'bank', 'pos', 'receipts', 'vat'];
  const CAT_LABEL = { clients: 'Customer invoices', credit_notes: 'Credit notes', purchases: 'Purchases / supplier invoices', sales: 'Sales', bank: 'Bank', pos: 'Cash / POS', receipts: 'Supporting documents', vat: 'VAT' };
  const CAT_ICON = { clients: 'ventes', credit_notes: 'baisse', purchases: 'achats', sales: 'chiffreAffaires', bank: 'banqueEtCaisse', pos: 'commandes', receipts: null, vat: null };
  const STATUS = { ready: 'Ready', review: 'To review', incomplete: 'Incomplete', empty: 'No document' };
  const STATUS_CLASS = { ready: 'ok', review: 'warn', incomplete: 'bad', empty: '' };
  const ISSUE = {
    PERIOD_NOT_COVERED_BY_DATA: 'The sales history does not cover this period', CORRUPTED_SOURCE: 'An issued document fails its integrity check', MISSING_RECEIPT: 'Supporting document missing',
    ATTACHMENT_NOT_FOUND: 'The stored file could not be read', DOCUMENT_NOT_VALIDATED: 'Document not validated yet', SUPPLIER_VAT_MISSING: 'Supplier VAT number missing', VAT_NOT_PROVIDED: 'VAT amount not recorded',
    FOREIGN_CURRENCY_NOT_CONVERTED: 'Foreign currency, no EUR amount given', CAPTURE_METADATA_MISSING: 'Category or payment method missing', POSSIBLE_DUPLICATE_EXPENSE: 'Possible duplicate', TRANSACTION_UNMATCHED: 'Transaction not matched to a document',
    BANK_COVERAGE_PARTIAL: 'Bank data covers only part of the period', DOCUMENTS_WITHOUT_DATE: 'Incoming documents without a date', PERIOD_NOT_CLOSED: 'The period is not closed yet', RETAIL_LAST_SYNC_BEFORE_PERIOD_END: 'Sales were last synced before the end of the period',
    RETAIL_VAT_RATE_UNAVAILABLE_FOR_N_LINES: 'VAT rate not recorded for some sales lines', N_TEST_ORDERS_EXCLUDED: 'Test orders were excluded', N_ORDERS_IN_OTHER_CURRENCY_EXCLUDED: 'Orders in another currency were excluded',
    NUMBERING_GAP_OR_DUPLICATE: 'Gap or duplicate in the document numbering', UNISSUED_DOCUMENTS_IN_PERIOD: 'Draft documents dated in this period are not counted', DOCUMENT_IN_OTHER_CURRENCY_NOT_INCLUDED_IN_TOTALS: 'Document in another currency, left out of the totals',
  };
  const issueText = (i) => (ISSUE[i.code] ? tt(ISSUE[i.code]) : /^POSSIBLE_DUPLICATE/.test(i.code) ? tt('Possible duplicate') : (i.detail || i.code));
  const MONTHS = () => Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2000, m, 1)).toLocaleDateString(I18N.tag(), { month: 'long', timeZone: 'UTC' }));

  function catIcon(id) {
    const n = CAT_ICON[id];
    if (n) { try { return NordlaIcon.semantic(n, 'md'); } catch (e) { /* asset flagged defective: generic fallback */ } }
    return svgIcon(id === 'receipts' ? 'inbox' : id === 'vat' ? 'coins' : 'doc', 18);
  }
  /** Append children, skipping null / false (native append() would print the word "null"). */
  const put = (el, ...kids) => { for (const k of kids.flat(Infinity)) { if (k !== null && k !== undefined && k !== false) el.appendChild(k instanceof Node ? k : document.createTextNode(String(k))); } return el; };
  const money = (cents, cur) => fmtMoney(cents, cur || 'EUR');
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(I18N.tag(), { dateStyle: 'short', timeStyle: 'short' }); };
  const statusChip = (s) => h('span', { class: `chip ${STATUS_CLASS[s] || ''}` }, tt(STATUS[s] || s));

  // ---------- period ----------
  function defaultSpec() {
    const n = new Date(); let y = n.getFullYear(); let q = Math.floor(n.getMonth() / 3); if (q === 0) { y -= 1; q = 4; }
    return { kind: 'quarter', year: y, quarter: q, month: n.getMonth() + 1, from: `${y}-01-01`, to: n.toISOString().slice(0, 10) };
  }
  const specBody = (s) => (s.kind === 'custom' ? { kind: 'custom', from: s.from, to: s.to } : s.kind === 'year' ? { kind: 'year', year: s.year } : s.kind === 'month' ? { kind: 'month', year: s.year, month: s.month } : { kind: 'quarter', year: s.year, quarter: s.quarter });
  const specQuery = (s) => new URLSearchParams(Object.entries(specBody(s)).map(([k, v]) => [k, String(v)])).toString();

  // ---------- helpers to read a chosen file ----------
  function readB64(file) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
  }
  function pickFile(accept, onFile, opts) {
    const input = h('input', { type: 'file', accept, style: 'position:fixed;left:-9999px;opacity:0' });
    if (opts && opts.camera) input.setAttribute('capture', 'environment');
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.remove(); if (f) onFile(f); });
    document.body.appendChild(input); input.click();
  }

  // ---------- attach a supporting document to an existing record ----------
  function attachFor(id, reload) {
    pickFile('image/jpeg,image/png,application/pdf', async (f) => {
      try { await api('POST', `/api/inbox/${id}/attach`, { fileName: f.name, dataBase64: await readB64(f) }); toast(tt('Supporting document added'), 'ok'); reload(); } catch (e) { fail(e); }
    });
  }
  function attachButton(id, reload) { return h('button', { class: 'btn', type: 'button', on: { click: () => attachFor(id, reload) } }, tt('Add the supporting document')); }

  /** Extra block of the purchase detail for a captured expense / attached receipt (original file, currency, category...). */
  function captureInfoNode(it) {
    const c = it.capture; const rc = it.receipt; if (!c && !rc) return null;
    const rows = [];
    if (c) {
      rows.push([tt('Original currency'), it.currency || '-']);
      if (c.category) rows.push([tt('Category'), tt(CAPTURE_CATEGORY[c.category] || c.category)]);
      if (c.paymentMethod) rows.push([tt('Payment method'), tt(PAYMENT_LABEL[c.paymentMethod] || c.paymentMethod)]);
      if (c.eurAmountCents != null) rows.push([tt('EUR amount charged (entered by you)'), money(c.eurAmountCents, 'EUR')]);
      if (c.note) rows.push([tt('Note'), c.note]);
      rows.push([tt('Captured'), when(c.capturedAt)]);
    }
    const o = c || rc;
    return h('div', { class: 'pk-capinfo' },
      h('div', { class: 'pk-capinfo-h' }, h('strong', null, c ? tt('Captured expense') : tt('Attached document')), o.pdfGenerated ? h('span', { class: 'chip' }, tt('PDF generated from the image')) : null),
      h('div', { class: 'kv' }, rows.map(([k, v]) => [h('div', null, k), h('div', null, v)])),
      o.hasOriginal ? h('a', { class: 'btn', href: `/api/inbox/${it.id}/original`, target: '_blank', rel: 'noopener' }, tt('Open the original file')) : null);
  }

  // ---------- expense capture ----------
  const CAPTURE_CATEGORY = { hotel: 'Hotel', transport: 'Transport', meal: 'Meal', supplier: 'Supplier', exhibition: 'Exhibition', office: 'Office', other: 'Other' };
  const PAYMENT_LABEL = { card: 'Card', cash: 'Cash', bank_transfer: 'Bank transfer', other: 'Other' };
  const CURRENCIES = ['EUR', 'CNY', 'USD', 'GBP', 'CHF', 'HKD', 'JPY', 'TRY', 'AED'];
  const amountOk = (s) => /^\d+([.,]\d{1,2})?$/.test(String(s).trim());
  const normAmount = (s) => String(s).trim().replace(',', '.');
  const toCentsClient = (s) => { const [i, d = ''] = normAmount(s).split('.'); return Number(i) * 100 + Number((d + '00').slice(0, 2)); };
  const fromCentsClient = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

  function openExpenseCapture(done) {
    let file = null; let origin = 'image'; let previewUrl = null; let b64 = '';
    const stage = h('div', { class: 'pk-cap' }); const err = h('div');
    const f = { supplierName: '', issueDate: new Date().toISOString().slice(0, 10), gross: '', currency: 'EUR', vat: '', vatRate: '', category: '', paymentMethod: '', eur: '', note: '', invoiceNumber: '', supplierVatNumber: '' };
    function choose(kind) {
      if (kind === 'camera') pickFile('image/*', (x) => got(x, 'camera'), { camera: true });
      else if (kind === 'image') pickFile('image/jpeg,image/png', (x) => got(x, 'image'));
      else pickFile('application/pdf', (x) => got(x, 'pdf'));
    }
    // data: URLs (not blob:) so the strict Content-Security-Policy of the dashboard stays untouched
    function got(x, o) { file = x; origin = o; b64 = ''; previewUrl = null; const r = new FileReader(); r.onload = () => { const u = String(r.result); previewUrl = u; b64 = u.split(',')[1] || ''; draw(); }; r.onerror = () => { file = null; draw(); }; r.readAsDataURL(x); }
    const big = (label, sub, kind, primary) => h('button', { type: 'button', class: 'pk-bigbtn' + (primary ? ' primary' : ''), on: { click: () => choose(kind) } }, h('strong', null, label), h('span', null, sub));
    const inp = (key, label, opts = {}) => h('div', { class: `field ${opts.cls || ''}` }, h('label', null, label), h('input', { value: f[key], placeholder: opts.ph || '', inputmode: opts.mode || null, list: opts.list || null, type: opts.type === 'date' ? 'date' : null, on: { input: (e) => { f[key] = e.target.value; }, change: (e) => { f[key] = e.target.value; } } }), opts.hint ? h('div', { class: 'hint' }, opts.hint) : null);
    const sel = (key, label, options) => h('div', { class: 'field' }, h('label', null, label), h('select', { on: { change: (e) => { f[key] = e.target.value; } } }, [h('option', { value: '' }, '-'), ...options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, tt(l)))]));
    function preview() {
      if (file.type === 'application/pdf') return h('div', { class: 'pk-prev pk-prev-file' }, svgIcon('doc', 30), h('strong', null, file.name), h('span', { class: 'muted small' }, tt('The PDF preview is available after saving.')));
      return h('div', { class: 'pk-prev' }, h('img', { src: previewUrl, alt: file.name, class: 'pk-prev-img' }));
    }
    function draw() {
      clear(stage);
      if (!file) {
        stage.appendChild(h('p', { class: 'muted small' }, tt('Capture a receipt or a supplier document. The original file is always kept.')));
        stage.appendChild(h('div', { class: 'pk-bigbtns' }, big(tt('Take a photo'), tt('Opens the camera on your phone'), 'camera', true), big(tt('Import an image'), tt('JPEG or PNG'), 'image', false), big(tt('Import a PDF'), tt('An existing receipt or invoice'), 'pdf', false)));
        return;
      }
      stage.appendChild(preview());
      stage.appendChild(h('div', { class: 'pk-src muted small' }, h('strong', null, tt('Source document')), ' ', `${file.name} · ${fmtBytes(file.size)}`, ' · ', file.type === 'application/pdf' ? tt('The PDF is kept as is.') : tt('The original image is kept and a PDF is created from it.'), ' ', h('button', { type: 'button', class: 'linkbtn', on: { click: () => { file = null; draw(); } } }, tt('Choose another file'))));
      stage.appendChild(h('div', { class: 'row r2' }, inp('supplierName', tr('Supplier')), inp('issueDate', tr('Date'), { type: 'date' })));
      stage.appendChild(h('div', { class: 'row r3' }, inp('gross', tr('Amount incl. VAT'), { mode: 'decimal', ph: '0.00' }), inp('currency', tr('Original currency'), { list: 'pk-cur', ph: 'EUR' }), inp('vat', tr('VAT amount (if known)'), { mode: 'decimal', ph: '0.00' })));
      stage.appendChild(h('datalist', { id: 'pk-cur' }, CURRENCIES.map((c) => h('option', { value: c }))));
      stage.appendChild(h('div', { class: 'row r3' }, inp('vatRate', tr('VAT rate % (if known)'), { mode: 'decimal', ph: '21' }), sel('category', tr('Category'), Object.entries(CAPTURE_CATEGORY)), sel('paymentMethod', tr('Payment method'), Object.entries(PAYMENT_LABEL))));
      stage.appendChild(h('div', { class: 'row r2' }, inp('eur', tr('EUR amount charged (only if known)'), { mode: 'decimal', ph: '0.00', hint: tt('Enter the amount really charged in euros (for example on your card statement). Nordla never converts currencies.') }), inp('note', tr('Note'))));
      stage.appendChild(h('details', { class: 'pk-more' }, h('summary', null, tt('More details')), h('div', { class: 'row r2' }, inp('invoiceNumber', tr('Receipt / invoice number (optional)')), inp('supplierVatNumber', tr('Supplier VAT number (optional)')))));
    }
    async function save(validate) {
      clear(err);
      const problems = [];
      if (!file) { problems.push({ field: 'file', code: 'REQUIRED' }); }
      if (f.gross && !amountOk(f.gross)) problems.push({ field: 'gross', code: 'AMOUNT_INVALID' });
      if (f.vat && !amountOk(f.vat)) problems.push({ field: 'vat', code: 'AMOUNT_INVALID' });
      if (f.eur && !amountOk(f.eur)) problems.push({ field: 'eur', code: 'AMOUNT_INVALID' });
      if (problems.length) return fail(new ApiError(422, { error: { code: 'INPUT_INVALID', fields: problems } }), err);
      const fields = { supplierName: f.supplierName, issueDate: f.issueDate, currency: f.currency, invoiceNumber: f.invoiceNumber, supplierVatNumber: f.supplierVatNumber };
      if (f.gross) fields.gross = normAmount(f.gross);
      if (f.vat) { fields.vat = normAmount(f.vat); if (f.gross) fields.net = fromCentsClient(Math.max(0, toCentsClient(f.gross) - toCentsClient(f.vat))); }
      try {
        const r = await api('POST', '/api/inbox/capture', { fileName: file.name, dataBase64: b64 || await readB64(file), origin, fields, capture: { category: f.category, paymentMethod: f.paymentMethod, note: f.note, eur: f.eur ? normAmount(f.eur) : '', vatRate: f.vatRate ? normAmount(f.vatRate) : '' } });
        if (r.duplicate) { toast(tt('This file was already imported.'), 'ok'); box.remove(); done(); return; }
        if (validate) {
          try { await api('POST', `/api/inbox/${r.item.id}/validate`, {}); toast(tt('Expense saved and validated'), 'ok'); } catch (e) { toast(tt('Expense saved: complete the missing fields to validate it.'), 'ok'); }
        } else toast(tt('Expense saved for review'), 'ok');
        box.remove(); done();
      } catch (e) { fail(e, err); }
    }
    const saveBtn = h('button', { type: 'button', on: { click: () => save(false) } }, tt('Save for review'));
    const okBtn = h('button', { type: 'button', class: 'primary', on: { click: () => save(true) } }, tt('Save and validate'));
    const box = modal(tt('Add an expense'), h('div', null, err, stage), (close) => [okBtn, saveBtn, h('button', { type: 'button', on: { click: close } }, tt('Cancel'))]);
    box.classList.add('pk-capmodal'); draw();
    return box;
  }

  // ---------- send to accountant (existing approval-gated step) ----------
  function openSendToAccountant(p, after) {
    const ok = h('input', { type: 'checkbox' }); const err = h('div');
    const go = h('button', { class: 'primary', disabled: true, on: { click: async () => { try { await api('POST', `/api/accountant/package/${p.id}/send`, { approve: true, recipient: p.recipient.email }); go.closest('.modal-back').remove(); toast(tt('Sent to the accountant'), 'ok'); p.sent = true; if (after) after(); } catch (e) { fail(e, err); } } } }, tt('APPROVE and send'));
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    modal(tt('Send to accountant'), h('div', null, err, h('p', null, tt('You are about to send {0} to:', p.fileName)), h('div', { class: 'banner info' }, h('strong', null, p.recipient.email), p.recipient.name ? ` (${p.recipient.name})` : ''), h('p', { class: 'muted small' }, tt('Sending goes through: {0}.', p.sendChannel)),
      h('label', { style: 'color:var(--ink)' }, ok, tt('I approve sending this package to this recipient.'))), (close) => [go, h('button', { on: { click: close } }, tt('Cancel'))]);
  }

  // ---------- the page ----------
  async function viewPackComptable() {
    const spec = defaultSpec(); const include = { clients: true, credit_notes: true, purchases: true, receipts: true, sales: true, bank: true, pos: true, vat: true, control: true, csv: true, xlsx: true, ubl: true };
    let data = null; let preview = null; let generated = null; let showAll = false; let showAllHist = false;
    const shell = h('div', { class: 'page-shell premium pack-page' });
    layout('#/pack', shell);
    shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('Accountant pack')), h('div', { class: 'subtitle' }, tt('Prepare, check and download a clean file for your accountant.')))));
    const S = {}; const box = h('div', { class: 'pk-stack' }); shell.appendChild(box);
    for (const k of ['period', 'verdict', 'issues', 'controls', 'vat', 'winbooks', 'content', 'preview', 'history']) { S[k] = h('section', { class: 'card pk-card', id: `pk-${k}` }); box.appendChild(S[k]); }
    const head = (title, hint, ...extra) => h('div', { class: 'cardhead' }, h('h2', null, title), hint ? h('span', { class: 'muted small' }, hint) : null, ...extra);
    const jump = (k) => { const el = S[k]; if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    async function load() {
      for (const k of Object.keys(S)) { if (k !== 'period') { clear(S[k]); S[k].appendChild(h('div', { class: 'skl', style: 'height:64px' })); } }
      drawPeriod();
      try { data = await api('POST', '/api/pack-comptable/status', specBody(spec)); } catch (e) { for (const k of Object.keys(S)) if (k !== 'period') clear(S[k]); fail(e, S.verdict); return; }
      drawPeriod(); drawAll(); refreshPreview();
    }
    async function refreshPreview() {
      try { preview = await api('POST', '/api/pack-comptable/preview', { period: specBody(spec), include }); } catch (e) { preview = null; }
      drawPreview();
    }
    function drawAll() { drawVerdict(); drawIssues(); drawControls(); drawVat(); drawWinbooks(); drawContent(); drawPreview(); drawHistory(); }

    // 1. period
    function drawPeriod() {
      clear(S.period);
      const kind = h('select', { on: { change: (e) => { spec.kind = e.target.value; load(); } } }, [['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([v, l]) => h('option', { value: v, selected: spec.kind === v }, tt(l))));
      const year = h('input', { type: 'number', value: String(spec.year), min: 2000, max: 2100, on: { change: (e) => { spec.year = Number(e.target.value); load(); } } });
      const q = h('select', { on: { change: (e) => { spec.quarter = Number(e.target.value); load(); } } }, [1, 2, 3, 4].map((n) => h('option', { value: String(n), selected: spec.quarter === n }, `Q${n}`)));
      const mo = h('select', { on: { change: (e) => { spec.month = Number(e.target.value); load(); } } }, MONTHS().map((n, i) => h('option', { value: String(i + 1), selected: spec.month === i + 1 }, n)));
      const controls = h('div', { class: 'pk-period' });
      if (spec.kind === 'custom') {
        const from = h('input', { type: 'date', value: spec.from, on: { change: (e) => { spec.from = e.target.value; if (spec.from && spec.to) load(); } } }); const to = h('input', { type: 'date', value: spec.to, on: { change: (e) => { spec.to = e.target.value; if (spec.from && spec.to) load(); } } });
        put(controls, h('div', { class: 'field' }, h('label', null, tt('From')), from), h('div', { class: 'field' }, h('label', null, tt('To')), to), h('button', { class: 'linkbtn', type: 'button', on: { click: () => { spec.kind = 'quarter'; load(); } } }, tt('Back to standard periods')));
      } else {
        put(controls, h('div', { class: 'field' }, h('label', null, tt('Period')), kind), h('div', { class: 'field' }, h('label', null, tt('Year')), year), spec.kind === 'quarter' ? h('div', { class: 'field' }, h('label', null, tt('Quarter')), q) : null, spec.kind === 'month' ? h('div', { class: 'field' }, h('label', null, tt('Month')), mo) : null);
      }
      const range = data && data.period ? tt('From {0} to {1}', displayFromIso(data.period.start), displayFromIso(data.period.end)) : '';
      put(S.period, head(tt('Accounting period')), controls, h('div', { class: 'pk-range' }, range), spec.kind === 'custom' ? null : h('button', { class: 'linkbtn small', type: 'button', on: { click: () => { spec.kind = 'custom'; drawPeriod(); } } }, tt('Custom date range (advanced)')));
    }

    // 2. verdict
    function drawVerdict() {
      clear(S.verdict); const m = data.model; const f = m.facts; const n = m.counts.items;
      const headline = m.verdict === 'ready' ? tt('The file is ready') : m.verdict === 'review' ? tt('{0} item(s) need your attention', n) : tt('The file is incomplete: {0} item(s) to handle', n);
      const facts = [
        tt('{0} customer invoice(s) · {1} credit note(s)', f.invoices, f.creditNotes),
        f.purchasesTotal ? tt('{0} / {1} purchase document(s) with a supporting document', f.purchasesWithReceipt, f.purchasesTotal) : tt('No purchase document in this period'),
        f.bankCoverage === 'none' ? tt('No bank data in Nordla for this period') : tt('{0} / {1} bank transactions matched', f.bankMatched, f.bankTransactions),
        m.counts.blocking ? tt('{0} blocking item(s)', m.counts.blocking) : null,
        m.completeness === 'PARTIAL' ? tt('Data is partial for this period: see the items below.') : null,
      ].filter(Boolean);
      const cta = n ? h('button', { class: 'primary warm big', type: 'button', on: { click: () => jump('issues') } }, tt('Fix the items ({0})', n)) : h('button', { class: 'primary warm big', type: 'button', on: { click: () => jump('preview') } }, tt('Prepare the pack'));
      put(S.verdict, h('div', { class: 'pk-verdict' }, h('div', { class: 'pk-verdict-main' }, h('div', { class: 'pk-verdict-top' }, h('span', { class: `pk-state ${STATUS_CLASS[m.verdict]}` }, tt(STATUS[m.verdict])), h('span', { class: 'muted small' }, tt('File status'))), h('h2', { class: 'pk-verdict-h' }, headline),
        h('ul', { class: 'pk-facts' }, facts.map((x) => h('li', null, x)))), h('div', { class: 'pk-verdict-cta' }, cta)));
    }

    // 3. items to fix
    function issueAction(i, reload) {
      const a = i.action; if (!a) return null;
      const go = (label, fn, cls) => h('button', { class: cls || 'btn', type: 'button', on: { click: fn } }, tt(label));
      if (a.type === 'add_receipt') return go('Add the supporting document', () => attachFor(a.id, reload));
      if (a.type === 'open_purchase') return go(i.kind === 'metadata' || i.kind === 'vat' || i.kind === 'currency' ? 'Fix' : 'Check', () => openInboxItem(a.id, reload));
      if (a.type === 'open_document') return go('Check', () => { location.hash = `#/doc/${a.id}`; });
      if (a.type === 'open_bank') return go('Match', () => { location.hash = '#/bank'; });
      if (a.type === 'open_inbox') return go('Check', () => { location.hash = '#/purchases?tab=inbox'; });
      return go('Check', () => { location.hash = '#/sales'; });
    }
    function drawIssues() {
      clear(S.issues); const m = data.model; if (!m.issues.length) { put(S.issues, head(tt('Items to fix')), h('div', { class: 'empty' }, h('div', { class: 'muted' }, tt('Nothing to fix: every check passed.')))); return; }
      const order = (i) => (i.level === 'blocking' ? 0 : i.priority === 'critical' ? 1 : 2);
      const list = m.issues.slice().sort((a, b) => order(a) - order(b) || String(a.date || '').localeCompare(String(b.date || '')));
      const shown = showAll ? list : list.slice(0, 8);
      put(S.issues, head(tt('Items to fix'), tt('{0} item(s)', list.length)), h('div', { class: 'pk-issues' }, shown.map((i) => {
        const sev = i.level === 'blocking' ? ['bad', 'Blocking'] : i.priority === 'critical' ? ['warn', 'Important'] : ['', 'Warning'];
        return h('div', { class: `pk-issue ${i.level === 'blocking' ? 'blocking' : ''}` },
          h('div', { class: 'pk-issue-top' }, h('span', { class: 'chip' }, tt(CAT_LABEL[i.category] || i.category)), h('span', { class: `chip ${sev[0]}` }, tt(sev[1]))),
          h('div', { class: 'pk-issue-body' }, h('div', { class: 'pk-issue-title' }, issueText(i)), h('div', { class: 'pk-issue-meta muted small' }, [i.date ? displayFromIso(i.date) : null, i.party, Number.isInteger(i.amountCents) ? money(i.amountCents, i.currency) : null, i.ref].filter(Boolean).join(' · '))),
          h('div', { class: 'pk-issue-act' }, issueAction(i, load)));
      })), list.length > 8 ? h('button', { class: 'linkbtn', type: 'button', on: { click: () => { showAll = !showAll; drawIssues(); } } }, showAll ? tt('Show fewer') : tt('Show all ({0})', list.length)) : null);
    }

    // 4. quick controls
    function drawControls() {
      clear(S.controls); const m = data.model; const cat = (id) => m.categories.find((c) => c.id === id); const nIssue = (pred) => m.issues.filter(pred).length;
      const card = (id, title, lines) => h('div', { class: 'pk-ctl' }, h('div', { class: 'pk-ctl-h' }, h('span', { class: 'pk-ico' }, catIcon(id)), h('strong', null, title), statusChip(cat(id).status)), h('ul', { class: 'pk-facts small' }, lines.filter(Boolean).map((x) => h('li', null, x))));
      const s = m.sales; const b = m.bank; const cp = m.captured;
      put(S.controls, head(tt('Quick checks')), h('div', { class: 'pk-ctls' },
        card('sales', tt('Sales'), [tt('{0} customer invoice(s) · {1} credit note(s)', m.facts.invoices, m.facts.creditNotes), tt('{0} shop / POS order(s) · {1} standalone B2B invoice(s)', s.orders, s.standaloneB2b), tt('{0} numbering / document issue(s)', nIssue((i) => i.category === 'clients' || i.category === 'credit_notes'))]),
        card('purchases', tt('Purchases'), [tt('{0} validated purchase document(s)', m.facts.purchases), tt('{0} missing supporting document(s)', nIssue((i) => i.code === 'MISSING_RECEIPT')), tt('{0} VAT issue(s)', nIssue((i) => i.kind === 'vat')), cp.total ? tt('{0} captured expense(s): {1} not validated, {2} missing details', cp.total, cp.notValidated, cp.missingMetadata) : null]),
        card('bank', tt('Bank'), b.coverage === 'none' ? [tt('No bank data in Nordla'), tt('CODA files are not supported yet: CSV / XLSX exports only.')] : [tt('{0} transaction(s)', m.facts.bankTransactions), tt('{0} matched · {1} not matched', b.counts.MATCHED, b.counts.NEW), b.coverage === 'partial' ? tt('Bank data covers only part of the period ({0} to {1})', displayFromIso(b.first), displayFromIso(b.last)) : tt('Bank data covers the whole period'), tt('CODA files are not supported yet: CSV / XLSX exports only.')]),
        card('pos', tt('Cash / POS'), [tt('{0} POS order(s)', m.pos.orders), tt('{0} cash movement(s) recorded', m.pos.cashMovements), tt('Cash reconciliation is not supported yet.')])));
    }

    // 5. VAT
    function drawVat() {
      clear(S.vat); const v = data.model.vat; const cur = data.model.currency;
      const reason = (r) => tt({ RETAIL_VAT_RATE_UNAVAILABLE: 'VAT rate missing for some sales lines', FOREIGN_CURRENCY_EXCLUDED: 'Foreign-currency purchases are left out', UNVALIDATED_PURCHASES_EXCLUDED: 'Purchases not validated yet are left out', PURCHASE_VAT_NOT_RECORDED: 'Some purchases have no recorded VAT amount', PERIOD_NOT_CLOSED: 'The period is not closed yet' }[r] || r);
      const kv = (l, val, strong) => h('div', { class: `pk-kv${strong ? ' strong' : ''}` }, h('span', null, l), h('strong', null, val));
      put(S.vat, head(tt('VAT check'), null, h('span', { class: `chip ${v.status === 'COMPLETE' ? 'ok' : 'warn'}` }, v.status === 'COMPLETE' ? tt('Complete') : tt('Partial'))),
        h('div', { class: 'banner info small' }, tt('Indicative estimate based on the available data. This is not an official VAT return.')),
        h('div', { class: 'pk-vatgrid' }, kv(tt('VAT collected'), money(v.collectedCents, cur)), kv(tt('VAT on validated purchases'), money(v.deductibleCents, cur)), kv(tt('Indicative balance'), money(v.balanceCents, cur), true)),
        v.byRate.length ? h('div', { class: 'pk-rates' }, h('div', { class: 'muted small' }, tt('Collected VAT by rate (known rates only)')), v.byRate.map((g) => h('div', { class: 'pk-kv' }, h('span', null, `${g.vatRateBp / 100} %`), h('span', null, `${money(g.taxableCents, cur)} → ${money(g.vatCents, cur)}`)))) : null,
        v.unclassified ? h('div', { class: 'small muted' }, tt('{0} sales line(s) have no recorded VAT rate: they are not spread across rates.', v.unclassified.lines)) : null,
        v.reasons.length ? h('ul', { class: 'pk-facts small' }, v.reasons.map((r) => h('li', null, reason(r)))) : null,
        h('div', { class: 'small muted' }, tt('Coverage: {0} / {1} validated purchase document(s) carry a VAT amount.', v.coverage.purchaseDocumentsWithVat, v.coverage.purchaseDocumentsTotal), ' ', tt('The right to deduct VAT is not assessed.')));
    }

    // 6. documents ready for WinBooks (category downloads)
    function drawWinbooks() {
      clear(S.winbooks); const m = data.model;
      put(S.winbooks, head(tt('Documents ready for WinBooks'), tt('Download each category separately, then upload it in WinBooks.')),
        h('div', { class: 'pk-cats' }, m.categories.map((c) => {
          const issues = m.issues.filter((i) => i.category === c.id).length;
          const dl = c.downloadable ? h('a', { class: 'btn primary warm', href: `/api/pack-comptable/category?${specQuery(spec)}&category=${c.id}` }, tt('Download')) : h('button', { class: 'btn', type: 'button', disabled: true }, tt('Download'));
          return h('div', { class: `pk-cat ${c.status}` }, h('span', { class: 'pk-ico' }, catIcon(c.id)),
            h('div', { class: 'pk-cat-main' }, h('div', { class: 'pk-cat-title' }, h('strong', null, tt(CAT_LABEL[c.id])), statusChip(c.status)), h('div', { class: 'muted small' }, c.count ? tt('{0} document(s)', c.count) : tt('No document in this period'), issues ? ` · ${tt('{0} item(s) to check', issues)}` : '', c.note === 'CASH_RECONCILIATION_NOT_SUPPORTED' ? ` · ${tt('Cash reconciliation is not supported yet.')}` : '')),
            h('div', { class: 'pk-cat-act' }, dl));
        })),
        h('div', { class: 'small muted', style: 'margin-top:10px' }, tt('These are Nordla exports (PDF, CSV, XLSX, UBL) prepared for a manual upload. They are not in an official WinBooks import format.')));
    }

    // 7. content of the pack
    function drawContent() {
      clear(S.content); const m = data.model;
      const cb = (key, label, disabled, note) => h('label', { class: `pk-check${disabled ? ' off' : ''}` }, h('input', { type: 'checkbox', checked: !!include[key] && !disabled, disabled, on: { change: (e) => { include[key] = e.target.checked; refreshPreview(); } } }), h('span', null, label, note ? h('em', null, note) : null));
      const catBox = (id) => { const c = m.categories.find((x) => x.id === id); return cb(id, tt(CAT_LABEL[id]), !c.count, c.count ? tt('{0} document(s)', c.count) : tt('No document')); };
      put(S.content, head(tt('Pack contents'), tt('Relevant items are selected by default.')),
        h('div', { class: 'pk-checks' }, CATS.map(catBox), cb('control', tt('Control report'), false, tt('Always recommended'))),
        h('details', { class: 'pk-more' }, h('summary', null, tt('Advanced options')), h('div', { class: 'pk-checks' }, cb('csv', tt('CSV exports'), false), cb('xlsx', tt('Excel (XLSX) exports'), false), cb('ubl', tt('UBL / XML (only for documents that are structurally ready)'), false))));
    }

    // 8. preview + generation
    function drawPreview() {
      clear(S.preview); if (!data) return; const m = data.model; const p = preview;
      const lines = p ? [[p.counts.invoices, 'customer invoice(s)'], [p.counts.creditNotes, 'credit note(s)'], [p.counts.purchases, 'supplier invoice(s)'], [p.counts.receipts, 'supporting document(s)'], [p.counts.bankExports, 'bank export(s)'], [p.counts.salesExports, 'sales export(s)'], [p.counts.posExports, 'POS export(s)'], [p.counts.vatSummaries, 'VAT summary'], [p.counts.controlReports, 'control report(s)'], [p.counts.ubl, 'UBL file(s)']].filter(([n]) => n > 0) : [];
      const blocking = m.counts.blocking > 0; const warn = m.counts.warnings;
      const genBtn = blocking ? h('button', { class: 'primary warm big', type: 'button', disabled: true }, tt('Generate the Accountant Pack'))
        : h('button', { class: 'primary warm big', type: 'button', on: { click: () => (m.verdict === 'ready' ? generate(false) : confirmWarnings()) } }, m.verdict === 'ready' ? tt('Generate the Accountant Pack') : tt('Generate despite the warnings ({0})', warn));
      put(S.preview, head(tt('Preview before generation')),
        h('div', { class: 'pk-prev-grid' }, h('div', null, h('h4', null, tt('Your file contains')), lines.length ? h('ul', { class: 'pk-facts' }, lines.map(([n, l]) => h('li', null, `${n} ${tt(l)}`))) : h('div', { class: 'muted small' }, tt('Nothing selected.'))),
          h('div', null, h('h4', null, tt('State')), h('div', { class: 'pk-verdict-top' }, h('span', { class: `pk-state ${STATUS_CLASS[m.verdict]}` }, tt(STATUS[m.verdict])), h('span', { class: 'muted small' }, m.completeness === 'COMPLETE' ? tt('Complete data') : tt('Partial data'))),
            h('ul', { class: 'pk-facts' }, h('li', null, tt('{0} blocking item(s)', m.counts.blocking)), h('li', null, tt('{0} warning(s)', warn))), blocking ? h('div', { class: 'banner bad small' }, tt('Generation is blocked: the sales history does not cover this period, or a document fails its integrity check.')) : (warn ? h('div', { class: 'banner warn small' }, tt('Warnings do not block the pack. They are listed in the control report.')) : null))),
        h('div', { class: 'actions pk-actions' }, genBtn, h('button', { class: 'btn', type: 'button', on: { click: () => jump('winbooks') } }, tt('Download by category'))),
        generated ? generatedBox() : null);
    }
    function generatedBox() {
      const r = generated.record; const sd = generated.send;
      return h('div', { class: 'pk-done' }, h('div', { class: 'pk-verdict-top' }, h('strong', null, tt('Pack generated: {0}', r.versionLabel)), h('span', { class: 'muted small' }, `${r.fileName} · ${fmtBytes(r.size)}`)),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary warm', href: r.downloadUrl }, tt('Download the pack')), h('a', { class: 'btn', href: sd.emlUrl }, tt('Download the .eml (fallback)')), h('button', { class: 'btn', type: 'button', disabled: !sd.recipient.configured, on: { click: () => openSendToAccountant(sd, () => drawPreview()) } }, tt('Send to accountant')), h('span', { class: 'muted small' }, tt('Nothing is sent until you approve.'))));
    }
    function confirmWarnings() {
      const m = data.model; const ok = h('input', { type: 'checkbox' });
      const go = h('button', { class: 'primary', disabled: true, on: { click: () => { go.closest('.modal-back').remove(); generate(true); } } }, tt('Generate the pack'));
      ok.addEventListener('change', () => { go.disabled = !ok.checked; });
      modal(tt('Generate despite the warnings?'), h('div', null, h('p', null, tt('{0} warning(s) remain. They will be listed in the control report.', m.counts.warnings)), h('label', { style: 'color:var(--ink)' }, ok, tt('I understand and want to generate the pack anyway.'))), (close) => [go, h('button', { on: { click: close } }, tt('Cancel'))]);
    }
    async function generate(ack) {
      clear(S.preview); S.preview.appendChild(h('div', { class: 'skl', style: 'height:80px' }));
      try { generated = await api('POST', '/api/pack-comptable/generate', { period: specBody(spec), include, acknowledgeWarnings: ack }); toast(tt('Pack generated'), 'ok'); data = await api('POST', '/api/pack-comptable/status', specBody(spec)); drawAll(); jump('preview'); } catch (e) { drawPreview(); fail(e, S.preview.appendChild(h('div'))); }
    }

    // 9. history + soft versioning
    function drawHistory() {
      clear(S.history); const hi = data.history; const rows = hi.versions;
      put(S.history, head(tt('Pack history')));
      const ch = hi.changed;
      if (ch && hi.latest) {
        const parts = [ch.newDocuments ? tt('{0} new document(s) added since {1}.', ch.newDocuments, hi.latest.versionLabel) : null, ch.changedPurchases ? tt('{0} purchase document(s) changed status.', ch.changedPurchases) : null, ch.retailChanged ? tt('The sales figures changed.') : null, ch.newBankTransactions ? tt('{0} new bank transaction(s).', ch.newBankTransactions) : null].filter(Boolean);
        put(S.history, h('div', { class: 'banner warn pk-changed' }, h('strong', null, tt('Data has changed since the last generated pack.')), h('div', { class: 'small' }, parts.join(' ')), h('button', { class: 'btn', type: 'button', on: { click: () => jump('preview') } }, tt('Generate a new version'))));
      }
      if (!rows.length) { put(S.history, h('div', { class: 'empty' }, h('div', { class: 'muted' }, tt('No pack has been generated for this period yet.')))); return; }
      const histShown = showAllHist ? rows : rows.slice(0, 5);
      put(S.history, h('div', { class: 'pk-hist' }, histShown.map((r) => h('div', { class: 'pk-hrow' },
        h('div', { class: 'pk-hver' }, h('strong', null, r.versionLabel), statusChip(r.verdict)),
        h('div', { class: 'pk-hmeta muted small' }, `${displayFromIso(r.period.start)} → ${displayFromIso(r.period.end)} · ${when(r.generatedAt)} · ${tt('{0} document(s)', r.counts.documents)} · ${tt('Generated by {0}', tt('Merchant'))}`, h('div', { class: 'mono small' }, `SHA-256 ${r.sha256.slice(0, 16)}…`)),
        h('div', { class: 'pk-hact' }, h('a', { class: 'btn', href: r.downloadUrl }, tt('Download the pack')), h('details', { class: 'pk-hcats' }, h('summary', { class: 'btn' }, tt('Categories')), h('div', { class: 'pk-hcats-list' }, r.categories.filter((c) => c.count).map((c) => h('a', { href: c.url }, `${tt(CAT_LABEL[c.id])} (${c.count})`)))))))), rows.length > 5 ? h('button', { class: 'linkbtn', type: 'button', on: { click: () => { showAllHist = !showAllHist; drawHistory(); } } }, showAllHist ? tt('Show fewer') : tt('Show all ({0})', rows.length)) : null);
    }
    await load();
  }

  window.viewPackComptable = viewPackComptable; window.openExpenseCapture = openExpenseCapture; window.attachButton = attachButton; window.captureInfoNode = captureInfoNode;
})();
