// Nordla - Sourcing terrain (field mode V0). The decision engines run HERE, in the browser (same files as the server and the tests), so the phone works offline.
// The server is optional: it keeps cases on disk, holds the Safety Gate cache and reads PDFs. Failure of any optional call never stops the case.
import { newCase, dispatch, assess, whatIf, recordDecision, suggestCategories, safetyFacts, safetyKey } from '/core/case.js';
import { CATEGORIES } from '/core/taxonomy.js';
import { effective } from '/core/identity.js';
import { fmt } from '/core/money.js';
import { INCOTERMS } from '/core/landed.js';
import { MARKETPLACES } from '/core/amazon.js';
import { DOC_TYPES } from '/core/docinspect.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };

const TABS = [['decision', 'Decision'], ['case', 'Case'], ['ask', 'Ask'], ['docs', 'Docs'], ['compliance', 'Rules'], ['market', 'Market'], ['money', 'Money']];
const S = { cases: ls.get('nordla.sourcing.cases', {}), currentId: ls.get('nordla.sourcing.current', null), tab: 'decision', token: ls.get('nordla.sourcing.token', ''), offlineChoice: ls.get('nordla.sourcing.offlineChoice', false), authFailed: false, online: false, busy: '', flash: '', whatIf: null, A: null, error: null, suggestions: [], ai: null };

/** The Safety Gate cache kept ON THE PHONE (matched locally, offline). LIVE only if the server said so within the last 24 h; otherwise CACHED. */
function externals() {
  const c = ls.get('nordla.sourcing.safety', null); if (!c || !c.alerts) return {};
  const fresh = S.online && c.source?.mode === 'LIVE_VERIFIED' && Date.now() - Date.parse(c.phoneFetchedAt ?? 0) < 24 * 3600 * 1000; // live only while the server is reachable NOW
  return { safety: { alerts: c.alerts, source: { ...c.source, mode: fresh ? 'LIVE_VERIFIED' : 'CACHED' } } };
}
const run = (state, extra = {}) => assess(state, { now: new Date(), externals: externals(), ...extra });

const cur = () => S.cases[S.currentId];
function persist() { if (!ls.set('nordla.sourcing.cases', S.cases)) S.flash = 'Local storage is full: export the case (menu) before adding more photos.'; ls.set('nordla.sourcing.current', S.currentId); }
function ensureCase() { if (!cur()) { const c = newCase({}); S.cases[c.id] = c; S.currentId = c.id; persist(); } }

/** Every change goes through here: event -> new state -> saved locally -> synced when a server is reachable. */
function commit(event) {
  S.cases[S.currentId] = dispatch(cur(), event, new Date()); S.whatIf = null;
  try { const a = run(cur()); S.cases[S.currentId] = recordDecision(cur(), a, new Date()); } catch { /* shown by render */ }
  persist(); render(); queueSync();
}

// ---- optional server -------------------------------------------------------------------------------------------------------------------------------------------------------
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { 'x-sourcing-token': S.token, 'content-type': 'application/json', ...(opts.headers ?? {}) } }); const body = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(body.error ?? r.status), { status: r.status, body }); return body; };
async function ping() {
  if (!S.token) { S.online = false; return; }
  const was = S.online;
  try { await api('/api/health'); S.online = true; S.authFailed = false; } catch (e) { S.online = false; S.authFailed = e.status === 401 || e.status === 429; if (e.status === 429) S.flash = 'Too many wrong attempts: wait a minute.'; }
  paintHeader(); if (S.authFailed || was !== S.online) render(); if (S.online) { refreshAi(); if (!was || dirty.size) sync(); }
}
async function refreshAi() { try { S.ai = await api('/api/ai/status'); } catch { S.ai = null; } }
let syncTimer = null;
function queueSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); }
const dirty = new Set(ls.get('nordla.sourcing.dirty', []));
const markDirty = (id) => { dirty.add(id); ls.set('nordla.sourcing.dirty', [...dirty]); };
/** Pushes every case changed while offline (and the current one). A case changed elsewhere is never overwritten: it is reported. */
async function sync() {
  if (!S.token || !cur()) return;
  markDirty(cur().id);
  for (const id of [...dirty]) {
    const c = S.cases[id]; if (!c) { dirty.delete(id); continue; }
    try { const saved = await api(`/api/cases/${id}`, { method: 'PUT', body: JSON.stringify(c) }); S.cases[saved.id] = saved; dirty.delete(id); S.online = true; }
    catch (e) { if (e.status === 409) { S.flash = 'This case was changed on another device. Your copy is kept here; open the menu to take the server copy.'; S.conflict = e.body?.server ?? null; dirty.delete(id); } else { S.online = false; break; } }
  }
  ls.set('nordla.sourcing.dirty', [...dirty]); persist(); paintHeader();
}
async function checkSafety() {
  S.busy = 'safety'; render();
  try {
    const r = await api('/api/safety/alerts');
    if (!r.alerts) { S.flash = 'The server has no Safety Gate data yet (it downloads it at start). Still OFFLINE - VERIFICATION REQUIRED.'; }
    else { ls.set('nordla.sourcing.safety', { alerts: r.alerts, source: r.source, phoneFetchedAt: new Date().toISOString() }); S.flash = ''; }
  } catch (e) { S.flash = e.status === 401 ? 'Wrong or missing access token (menu).' : 'The Safety Gate could not be reached: the result stays what it was (CACHED or OFFLINE - VERIFICATION REQUIRED). This is not a clean result.'; }
  S.busy = ''; render();
}
async function fetchFx() {
  const q = quoteOf(cur()); if (!S.token) { S.flash = 'Add the access token (menu) to fetch the ECB rate, or type the rate.'; return render(); }
  try { const fx = await api(`/api/fx?currency=${encodeURIComponent(q.currency ?? 'USD')}`); commit({ type: 'COSTS', costs: { fx: { rate: String(fx.rate), date: fx.date, source: fx.source }, costs: cur().costs.costs, importVat: cur().costs.importVat } }); }
  catch { S.flash = 'The rate could not be fetched: type it by hand.'; render(); }
}

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const chip = (label, value, cls = value) => `<span class="chip t-${esc(cls)}">${esc(label)} <b>${esc(String(value).replace(/_/g, ' '))}</b></span>`;
const money = (m, cur = 'EUR') => (m === null || m === undefined ? '-' : fmt(m, cur));
const list = (xs) => (xs.length ? `<ul class="tight">${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="muted small">none</p>');
const VERDICT_TEXT = { GO: ['Yes - continue', 'Oui, continuer'], CONDITIONAL_GO: ['Continue, but only on conditions', 'Continuer, sous conditions'], NO_GO: ['No - not on these terms', 'Non, pas dans ces conditions'], INSUFFICIENT_INFORMATION: ['Not enough information yet', 'Pas assez d\'informations'] };
const field = (name, label, val = '', attrs = '') => `<label>${esc(label)}<input name="${name}" value="${esc(val)}" ${attrs}></label>`;
const selectOf = (name, label, opts, val = '') => `<label>${esc(label)}<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const seg = (act, key, current, opts = [[true, 'Yes'], [false, 'No']]) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" data-act="${act}" data-key="${esc(key)}" data-val="${esc(JSON.stringify(v))}" aria-pressed="${current === v}">${l}</button>`).join('')}</div>`;
const quoteOf = (c) => c.quotes.at(-1) ?? {};

// ---- screens ----------------------------------------------------------------------------------------------------------------------------------------------------------------
function decisionScreen(A, c) {
  const d = A.decision; const [en, fr] = VERDICT_TEXT[d.verdict]; const dim = d.dimensions; const mp = A.maxPurchasePrice; const q = quoteOf(c);
  const cur = q.currency ?? 'USD';
  const wi = S.whatIf;
  return `<section class="verdict v-${d.verdict}" aria-live="polite"><p class="q">SHOULD I CONTINUE WITH THIS PRODUCT?</p><div class="v">${esc(d.verdict.replace(/_/g, ' '))}</div><p class="a">${esc(en)} <span class="muted small">/ ${esc(fr)}</span></p><p style="margin:0">${esc(d.nextAction)}</p></section>
  <div class="chips">${chip('Identification', dim.identification, dim.identification === 'HIGH' ? 'GREEN' : dim.identification === 'MEDIUM' ? 'AMBER' : 'RED')}${chip('EU / BE', dim.marketability)}${chip('Amazon', dim.amazonReadiness)}${chip('Economics', dim.economics)}${chip('Supplier evidence', dim.supplierEvidence)}${chip('Safety risk', dim.safetyRisk)}</div>
  ${d.hardBlockers.length ? `<div class="warn"><strong>Hard blockers</strong>${list(d.hardBlockers.map((b) => `<b>${esc(b.code.replace(/_/g, ' '))}</b> - ${esc(b.detail)}`))}</div>` : ''}
  ${A.role.warnings.map((w) => `<div class="warn"><strong>${esc(w.code.replace(/_/g, ' '))}</strong> - ${esc(w.message)}</div>`).join('')}
  <div class="card"><h2>MAXIMUM PURCHASE PRICE</h2>${mp?.maxUnitPriceMinor != null ? `<div class="big">${esc(money(mp.maxUnitPriceMinor, mp.currency))}<span class="muted small"> / unit${mp.upperBound ? ' - UPPER BOUND (some fees unknown)' : ''}</span></div>${mp.maxUnitPriceMinor === 0 ? '<p class="warn">Even a tiny price misses your target margin.</p>' : ''}` : `<p><b>INFORMATION INSUFFICIENT</b> - ${esc(mp?.reason ?? 'selling price, margin target or a cost is missing')}</p>`}
    <form data-form="whatif" class="row" style="align-items:end"><label>Supplier says (${esc(cur)})<input name="unitPrice" inputmode="decimal" placeholder="4.20" value="${esc(wi?.change?.unitPrice ?? '')}"></label><button class="btn" style="flex:0 0 auto">What if</button></form>
    ${wi ? `<div class="note"><b>At ${esc(wi.change.unitPrice)} ${esc(cur)}:</b> landed ${esc(money(wi.whatIf.landedPerUnitMinor))}/unit, contribution ${esc(money(wi.whatIf.contributionMinor))}${wi.whatIf.contributionPct != null ? ` (${(wi.whatIf.contributionPct * 100).toFixed(1)}%)` : ''}, economics ${esc(wi.whatIf.economics)}, verdict <b>${esc(wi.whatIf.verdict.replace(/_/g, ' '))}</b>${wi.withinMaxPrice === false ? ' - ABOVE your maximum price' : wi.withinMaxPrice ? ' - within your maximum price' : ''}</div>` : ''}</div>
  <div class="card"><h2>WHY</h2>${list(d.why.map(esc))}${d.conditions.length ? `<h3>Conditions</h3>${list(d.conditions.map(esc))}` : ''}</div>
  <div class="card"><h2>VERIFIED / ESTIMATED / MISSING</h2><details open><summary>Verified (${A.evidence.verified.length}) - official source or inspected</summary>${list(A.evidence.verified.map((e) => esc(`${e.item}: ${e.value ?? ''}`)))}</details>
  <details><summary>Supplier claims (${A.evidence.supplierClaims.length}) - not proof</summary>${list(A.evidence.supplierClaims.map((e) => esc(`${e.item}: ${typeof e.value === 'object' ? JSON.stringify(e.value) : e.value ?? ''}`)))}</details>
  <details><summary>Calculated (${A.evidence.calculated.length})</summary>${list(A.evidence.calculated.map((e) => esc(`${e.item}: ${e.valueMinor != null ? money(e.valueMinor, e.currency) : ''}${e.upperBound ? ' (upper bound)' : ''}`)))}</details>
  <details><summary>Estimated / assumed (${A.evidence.estimated.length + A.evidence.assumed.length})</summary>${list([...A.evidence.estimated, ...A.evidence.assumed].map((e) => esc(`${e.item}${e.value !== undefined ? ` = ${e.value}` : ''} - ${e.note ?? e.level ?? ''}`)))}</details>
  <details open><summary>Missing / unknown (${A.evidence.unknown.length})</summary>${list(A.evidence.unknown.map((e) => esc(`${e.item}${e.note ? ` - ${e.note}` : ''}`)))}</details>
  <details><summary>Needs an expert or authority (${A.evidence.needsExpert.length})</summary>${list(A.evidence.needsExpert.map((e) => esc(e.title)))}</details></div>
  ${d.adminObligations.length ? `<div class="card"><h2>REGISTRATIONS AND OBLIGATIONS (not part of the verdict)</h2>${list(d.adminObligations.map((o) => `${esc(o.title)} <span class="chip">${esc(o.layer)}</span> <span class="muted small">review: ${esc(String(o.reviewStatus).replace(/_/g, ' '))}</span>`))}<p class="small muted">Legal obligations, scheme services and optional services are different things: see Rules.</p></div>` : ''}
  <div class="card"><h2>COULD BLOCK</h2><h3>Import</h3>${list(d.blocksImport.map((x) => esc(x.replace(/_/g, ' '))))}<h3>Amazon</h3>${list(d.blocksAmazon.map((x) => esc(x.replace(/_/g, ' '))))}</div>
  <p class="note">${esc(d.note)}</p>`;
}

const TRAITS = [['electrical.present', 'Electrical / electronic'], ['electrical.mainsConnected', 'Plugs into mains (230 V)'], ['battery.present', 'Contains a battery'], ['radio.present', 'Bluetooth / Wi-Fi / radio'], ['childrenUse', 'Designed for children'], ['toy', 'Toy / made for play (under 14)'], ['foodContact', 'Touches food or drink'], ['cosmetic', 'Cosmetic / skin product'], ['textile', 'Textile / clothing'], ['ppe', 'Protective equipment'], ['medical', 'Medical claim']];
function caseScreen(A, c) {
  const id = c.identity; const cat = effective(id, 'category'); const sugg = suggestCategories(id.workingName);
  const level = (t) => { const e = effective(id, t); return e.known ? (e.level === 'PROBABLE' ? 'assumed from category' : e.level.toLowerCase().replace(/_/g, ' ')) : e.contradiction ? 'CONTRADICTORY' : 'unknown'; };
  const photos = id.photos.map((p, i) => { const d = ls.get(`nordla.sourcing.photo.${c.id}.${i}`, null); return d ? `<img src="${esc(d)}" alt="product photo ${i + 1}" style="width:96px;height:96px;object-fit:cover;border-radius:8px;margin-right:6px">` : `<span class="chip">photo ${i + 1}</span>`; }).join('');
  const radioOn = effective(id, 'radio.present').value === true;
  return `<div class="card"><h2>PRODUCT</h2><form data-form="product">${field('name', 'What is it? (name, or what the label says)', id.workingName, 'autocomplete="off"')}
    <div class="row">${field('model', 'Model number', id.identifiers.model ?? '')}${field('brand', 'Brand', id.identifiers.brand ?? '')}</div>${field('manufacturer', 'Manufacturer (legal name on label)', id.identifiers.manufacturer ?? '')}${field('gtin', 'Barcode (GTIN / EAN)', id.identifiers.gtin ?? '', 'inputmode="numeric"')}
    ${selectOf('category', 'Category (probable - you confirm)', [['', cat.known ? '(keep)' : '- choose -'], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])], '')}<button class="btn" style="margin-top:10px">Save product</button></form>
    ${sugg.length ? `<p class="small muted">From the name, probably: ${sugg.map((s) => `<button type="button" class="btn sec" data-act="cat" data-key="${esc(s.id)}" style="min-height:36px;padding:4px 10px;margin:2px">${esc(s.label)}</button>`).join('')}</p>` : ''}
    <p class="small">Category now: <b>${esc(cat.known ? (CATEGORIES[cat.value]?.label ?? cat.value) : 'not set')}</b> <span class="muted">(${esc(cat.known ? cat.level.toLowerCase().replace(/_/g, ' ') : 'unknown')})</span></p>
    ${S.suggestions.length ? `<div class="note"><b>AI SUGGESTED</b> (not a fact until you confirm)${S.suggestions.map((x) => `<div style="margin-top:6px">${esc(CATEGORIES[x.categoryId]?.label ?? x.categoryId)} <span class="muted small">(${esc(x.confidence)}${x.why ? `: ${esc(x.why)}` : ''})</span><br><button type="button" class="btn sec" data-act="cat-confirm" data-key="${esc(x.categoryId)}" style="min-height:36px;padding:4px 10px">Yes, it is this</button> <button type="button" class="btn sec" data-act="cat-guess" data-key="${esc(x.categoryId)}" style="min-height:36px;padding:4px 10px">Keep as an unconfirmed guess</button></div>`).join('')}</div>` : ''}
    <label>Photo of the product / label / packaging (kept as evidence)</label><input type="file" accept="image/*" capture="environment" data-act="photo"><div style="margin-top:6px">${photos}</div></div>
  <div class="card"><h2>WHAT IS IT, FOR REAL?</h2><p class="small muted">Each answer is stronger than the category guess. Unknown stays unknown.</p>
    ${TRAITS.map(([t, l]) => `<div class="trait"><div><div class="nm">${esc(l)}</div><div class="lv">${esc(level(t))}</div></div>${seg('trait', t, effective(id, t).known ? effective(id, t).value : null)}</div>`).join('')}
    ${radioOn ? `<div class="trait"><div><div class="nm">Connects to the internet / app</div><div class="lv">${esc(level('radio.internetConnected'))}</div></div>${seg('trait', 'radio.internetConnected', effective(id, 'radio.internetConnected').known ? effective(id, 'radio.internetConnected').value : null)}</div><div class="trait"><div><div class="nm">Handles personal data (account, voice, location)</div><div class="lv">${esc(level('radio.processesPersonalData'))}</div></div>${seg('trait', 'radio.processesPersonalData', effective(id, 'radio.processesPersonalData').known ? effective(id, 'radio.processesPersonalData').value : null)}</div>` : ''}
    <form data-form="electrics"><div class="row">${field('vac', 'Rated AC volts', effective(id, 'electrical.maxVoltageAc').value ?? '', 'inputmode="decimal"')}${field('vdc', 'Rated DC volts', effective(id, 'electrical.maxVoltageDc').value ?? '', 'inputmode="decimal"')}</div>${selectOf('chem', 'Battery type', [['', '(unknown)'], ['li_ion', 'Lithium-ion'], ['li_po', 'Lithium-polymer'], ['other', 'Other / not lithium']], effective(id, 'battery.chemistry').value ?? '')}<button class="btn sec" style="margin-top:8px">Save ratings</button></form></div>
  <div class="card"><h2>WHO IS RESPONSIBLE?</h2><div class="trait"><div class="nm">Sold under MY name / brand (private label)</div>${seg('place', 'underOwnNameOrBrand', c.placing.underOwnNameOrBrand ?? null)}</div>
    <div class="trait"><div class="nm">Manufacturer is in the EU</div>${seg('place', 'manufacturerEstablishedInEU', c.placing.manufacturerEstablishedInEU ?? null)}</div>
    <div class="trait"><div class="nm">Supplier names an EU representative</div>${seg('place', 'euAuthorisedRepresentative', c.placing.euAuthorisedRepresentative ?? null)}</div>
    <div class="trait"><div class="nm">I modify the product (design, firmware, accessories)</div>${seg('place', 'modifiedProduct', c.placing.modifiedProduct ?? null)}</div>
    ${c.placing.modifiedProduct === true ? `<div class="trait"><div class="nm">The modification can affect safety or compliance</div>${seg('place', 'modificationAffectsCompliance', c.placing.modificationAffectsCompliance ?? null)}</div>` : ''}
    <div class="trait"><div class="nm">I repack it</div>${seg('place', 'repackaged', c.placing.repackaged ?? null)}</div>
    ${c.placing.repackaged === true ? `<div class="trait"><div class="nm">The new packaging carries MY name / brand</div>${seg('place', 'repackagedUnderOwnName', c.placing.repackagedUnderOwnName ?? null)}</div>` : ''}
    <div class="trait"><div class="nm">I change the labels or instructions</div>${seg('place', 'changedInstructionsOrLabels', c.placing.changedInstructionsOrLabels ?? null)}</div>
    ${c.placing.changedInstructionsOrLabels === true ? `<div class="trait"><div class="nm">Safety information or warnings change (not only translation)</div>${seg('place', 'changedSafetyInformation', c.placing.changedSafetyInformation ?? null)}</div>` : ''}
    ${A.role.basis.length ? `<p class="small muted">Basis: ${esc(A.role.basis.join(' | '))}</p>` : ''}
    <p class="note">${esc(A.role.note)} Role now: <b>${esc(A.role.role.replace(/_/g, ' '))}</b>${A.role.status === 'UNRESOLVED' ? ' - <b>NOT DECIDED</b>: answer the open role questions (a deciding fact is unknown)' : ''}</p></div>
  <div class="card"><h2>WHERE WILL IT BE SOLD?</h2><div class="trait"><div class="nm">Own shop / retail</div>${seg('chan', 'own_site', c.context.channels.includes('own_site'))}</div><div class="trait"><div class="nm">Amazon (BE/FR/DE/NL)</div>${seg('chan', 'amazon', c.context.channels.includes('amazon'))}</div></div>
  <div class="card"><h2>SUPPLIER</h2><form data-form="supplier">${field('name', 'Company', c.supplier.name ?? '')}<div class="row">${field('booth', 'Booth / hall', c.supplier.booth ?? '')}${field('market', 'Fair / market', c.supplier.market ?? '')}</div>${field('contact', 'Contact (name, WeChat, phone)', c.supplier.contact ?? '')}${field('link', 'Listing / link', c.supplier.link ?? '')}<button class="btn sec" style="margin-top:8px">Save supplier</button></form><p class="small muted">Stored on this device and your own server only. Never sent to an AI provider.</p></div>`;
}

function askScreen(A) {
  const qs = A.questions;
  return `<div class="card"><h2>ASK THE SUPPLIER NOW</h2><p class="small muted">Prioritised from what is still missing. ${qs.filter((q) => q.priority === 'P1').length} are P1 (they block the decision).</p><div class="row"><button class="btn" data-act="show-sup">Show to supplier (EN + 中文)</button><button class="btn sec" data-act="copy-sup">Copy</button></div></div>
  <div class="card">${qs.map((q) => `<div class="q-item"><span class="pri ${q.priority}">${q.priority}</span><b>${esc(q.topic)}</b><div>${esc(q.en)}</div><div class="zh" lang="zh-Hans">${esc(q.zh)}</div><div class="small muted">${esc(q.why)}</div></div>`).join('')}</div>
  <p class="note">${esc(A.supplierSheet.note.en)}</p><div class="card"><h2>NEGOTIATION BRIEF</h2>${negotiation(A)}</div>`;
}
function negotiation(A) {
  const n = A.negotiation;
  return `<table><tr><td>Walk-away price</td><td class="n"><b>${esc(n.walkAwayUnitPrice?.display ?? 'INFORMATION INSUFFICIENT')}</b></td></tr><tr><td>Target price</td><td class="n">${esc(n.targetUnitPrice?.display ?? '-')}</td></tr><tr><td>Quoted</td><td class="n">${esc(n.quotedUnitPrice ?? '-')}</td></tr><tr><td>MOQ</td><td class="n">${esc(n.moq ?? '-')}</td></tr><tr><td>Incoterm</td><td class="n">${esc(n.incoterm ?? '-')}</td></tr></table>
  ${n.moqNote ? `<p class="warn">${esc(n.moqNote)}</p>` : ''}${n.ownBrandWarning ? `<p class="warn">${esc(n.ownBrandWarning)}</p>` : ''}<h3>Documents before any deposit</h3>${list(n.documentsBeforeDeposit.map(esc))}<ul class="tight"><li>${esc(n.sample)}</li><li>${esc(n.inspection)}</li><li>${esc(n.incotermAdvice)}</li></ul><p class="small muted">${esc(n.targetUnitPrice?.basis ?? '')}. ${esc(n.nothingPredicted)}</p>`;
}

function docsScreen(A, c) {
  const docCard = (d) => {
    const photo = ls.get(`nordla.sourcing.docphoto.${c.id}.${d.id}`, null);
    const src = { NATIVE: 'text layer of a PDF', PASTED: 'pasted text', TRANSCRIBED: 'typed by you from the paper', OCR: 'read from a photo by an AI reader', PHOTO_ONLY: 'photo only (not read)' }[d.textSource] ?? d.textSource;
    const ocrPending = d.textSource === 'OCR' && !d.confirmed;
    return `<div class="card"><h2>${esc(d.fileName ?? d.id)} <span class="muted small">${esc(d.docType)}</span></h2><p class="small muted">Source: ${esc(src)}${d.textSource === 'OCR' ? (d.confirmed ? ' - confirmed by you' : ' - UNVERIFIED until you confirm') : ''}</p>${photo ? `<img src="${esc(photo)}" alt="photo of the document" style="max-width:100%;max-height:220px;border-radius:8px">` : ''}
    ${chip('Consistency', d.consistency, d.consistency === 'NO_ISSUE_FOUND' ? 'GREEN' : d.consistency === 'UNVERIFIED' || d.consistency === 'INSUFFICIENT_EVIDENCE' ? 'AMBER' : 'RED')}${d.findings.length ? list(d.findings.map((f) => `<b>${esc(f.code.replace(/_/g, ' '))}</b> (${esc(f.severity)}) - ${esc(f.detail)}`)) : ''}${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}
    <p class="small muted">Models: ${esc(d.models.join(', ') || '-')} - Standards: ${esc(d.standards.slice(0, 5).join(', ') || '-')}</p>
    ${d.textSource === 'OCR' || d.textSource === 'PHOTO_ONLY' ? `<details ${ocrPending || d.textSource === 'PHOTO_ONLY' ? 'open' : ''}><summary>${d.textSource === 'PHOTO_ONLY' ? 'Type what the paper says' : 'Text read from the photo (fix it while looking at the paper)'}</summary><form data-form="doc-correct" data-id="${esc(d.id)}"><textarea name="text">${esc(d.ocrText ?? '')}</textarea><button class="btn sec" style="margin-top:6px">Save corrections</button></form>${ocrPending ? `<button class="btn" data-act="doc-confirm" data-key="${esc(d.id)}" style="margin-top:8px">I checked the fields against the paper: confirm</button>` : ''}</details>` : ''}</div>`;
  };
  return `<div class="card"><h2>ADD A SUPPLIER DOCUMENT</h2><p class="small muted">PDF with text, photo of a paper document, pasted text, or typed from the paper. A photographed document is only a MACHINE READING until you check it against the paper. Nordla never says "fake": only what the evidence shows.</p>
  <form data-form="doc"><label>PDF, .txt or photo (camera)<input type="file" name="file" accept=".pdf,.txt,text/plain,application/pdf,image/*"></label><label>Or paste the text<textarea name="text" placeholder="Paste the text of the document"></textarea></label>${selectOf('claimed', 'The supplier calls it', [['', '(not stated)'], ['EU_DOC', 'EU Declaration of Conformity'], ['TEST_REPORT', 'Test report'], ['CERTIFICATE', 'Certificate'], ['SDS', 'Safety data sheet'], ['UN383', 'UN 38.3 report'], ['FCM_DOC', 'Food-contact declaration'], ['MANUAL', 'Manual']])}
  <button class="btn" style="margin-top:10px" ${S.busy === 'doc' ? 'disabled' : ''}>${S.busy === 'doc' ? 'Reading...' : 'Inspect document'}</button></form>
  <p class="small muted">Photo reading uses an AI reader ${S.ai?.enabled ? `(${esc(S.ai.provider)}, ${esc(S.ai.region)}): you are asked before each image is sent` : 'only if one is configured (none now): the photo is kept as evidence and you type what the paper says'}.</p></div>
  <div class="card"><h2>TYPE FROM THE PAPER</h2><p class="small muted">Works offline and with no reader. Key fields only: it can show a model or standard mismatch, not whether the original is complete.</p>
  <form data-form="doc-typed">${selectOf('docType', 'Document', [['EU_DOC', 'EU Declaration of Conformity'], ['TEST_REPORT', 'Test report'], ['CERTIFICATE', 'Certificate'], ['SDS', 'Safety data sheet'], ['UN383', 'UN 38.3 report'], ['FCM_DOC', 'Food-contact declaration'], ['MANUAL', 'Manual']])}<div class="row">${field('model', 'Model on the paper')}${field('date', 'Date of issue (YYYY-MM-DD)')}</div>${field('manufacturer', 'Manufacturer / applicant on the paper')}${field('directives', 'Directives / regulations cited (e.g. 2014/35/EU, 2014/30/EU)')}${field('standards', 'Standards cited (e.g. EN 62368-1, EN 55032)')}<div class="row">${field('lab', 'Laboratory (reports)')}${field('pages', 'Page x of y (e.g. 1 of 4)')}</div><button class="btn sec" style="margin-top:8px">Add typed document</button></form></div>
  ${A.documents.length ? A.documents.map(docCard).join('') : '<p class="muted">No document yet.</p>'}
  ${A.crossChecks.length ? `<div class="card"><h2>BETWEEN DOCUMENTS</h2>${list(A.crossChecks.map((f) => esc(f.detail)))}</div>` : ''}`;
}

function rulesScreen(A, c) {
  const rs = A.rules.results; const order = { APPLIES: 0, UNRESOLVED: 1, NOT_APPLICABLE: 2 };
  const sorted = [...rs].sort((a, b) => order[a.status] - order[b.status] || (b.severity === 'HIGH') - (a.severity === 'HIGH'));
  const s = A.safety; const cu = A.customs;
  const one = (r) => `<details ${r.status === 'APPLIES' && r.severity === 'HIGH' ? 'open' : ''}><summary>${esc(r.title)} <span class="chip t-${r.status === 'APPLIES' ? 'AMBER' : r.status === 'UNRESOLVED' ? 'UNKNOWN' : 'GREEN'}">${esc(r.status.replace(/_/g, ' '))}</span> ${r.jurisdiction !== 'EU' ? `<span class="chip">${esc(r.jurisdiction)}</span>` : ''} <span class="chip t-${r.review.status === 'VERIFIED_CURRENT' ? 'GREEN' : r.review.status === 'PRIMARY_TEXT_ONLY' ? 'AMBER' : 'RED'}" title="${esc(r.review.basis)}">rule review <b>${esc(r.review.status.replace(/_/g, ' '))}</b></span></summary><p class="small"><b>Rule review:</b> ${esc(r.review.status.replace(/_/g, ' '))}${r.reviewFreshness?.status === 'STALE' ? ' - STALE: re-check before relying on it' : ''} - checked ${esc(r.review.checkedAt)}. <b>Layer:</b> ${esc(r.layer)} - <b>${esc(r.materiality.replace(/_/g, ' '))}</b>, ${esc(r.scope)}.</p>
    <p class="small">${esc(r.review.interpretation)}</p>
    <p class="small muted"><b>Instruments:</b> ${r.review.instruments.map((i) => `${esc(i.name)}${i.consolidated ? ` [consolidated ${esc(i.consolidated)}]` : ''}${i.articles ? ` - ${esc(i.articles)}` : ''}`).join('; ')}<br><b>Dates:</b> ${esc((r.review.applicationDates ?? []).join(' | ') || 'none recorded')}<br><b>Uncertainty:</b> ${esc(r.review.uncertainty)}${r.review.pendingChange ? `<br><b>Pending change:</b> ${esc(r.review.pendingChange)}` : ''}</p>
    <p>${esc(r.why)}</p>${r.requiredEvidence.length && r.status !== 'NOT_APPLICABLE' ? `<table>${r.requiredEvidence.map((e) => `<tr><td>${esc(e.label)}<br><span class="muted small">${esc(e.requirement)}</span></td><td class="n"><span class="chip t-${e.coverage.status === 'PRESENT' ? 'GREEN' : e.coverage.status === 'OWN_ACTION' ? 'UNKNOWN' : 'RED'}">${esc(e.coverage.status.replace(/_/g, ' '))}</span></td></tr>`).join('')}</table>` : ''}
    <p class="small muted">Sources: ${r.sources.map((x) => `${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>` : esc(x.title)} [${esc(x.verification.replace(/_/g, ' '))}]`).join('; ') || 'none'}<br>${esc(r.sourceVerification.replace(/_/g, ' '))} - ${esc(r.freshness)} - rule ${esc(r.ruleVersion)}${r.requiresAuthorityConfirmation ? ' - REQUIRES EXPERT / AUTHORITY CONFIRMATION' : ''}</p>${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ''}</details>`;
  return `<div class="card"><h2>CE MARKING</h2>${chip('', A.rules.ce?.status ?? 'CE_APPLICABILITY_UNRESOLVED', A.rules.ce?.status === 'CE_REQUIRED' ? 'AMBER' : A.rules.ce?.status === 'CE_NOT_APPLICABLE' ? 'GREEN' : 'UNKNOWN')}<p>${esc(A.rules.ce?.why ?? '')}</p><p class="small muted">A CE logo on a product or a listing proves nothing; the EU declaration of conformity and its evidence do.</p></div>
  <div class="card"><h2>EU SAFETY GATE</h2>${chip('', s.status, s.status === 'EXACT_MATCH' || s.status === 'PROBABLE_MATCH' ? 'RED' : s.status === 'SIMILAR_PRODUCT_RISK' ? 'AMBER' : s.status === 'NO_MATCH_FOUND' ? 'GREEN' : 'UNKNOWN')} ${chip('Data', A.dataMode.replace(/_/g, ' '), A.dataMode === 'LIVE_VERIFIED' ? 'GREEN' : A.dataMode === 'CACHED' ? 'AMBER' : 'RED')}
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}${s.matches?.length ? list(s.matches.slice(0, 5).map((m) => `<b>${esc(m.basis.replace(/_/g, ' '))}</b> ${esc(m.alertNumber ?? '')} - ${esc(m.name ?? '')} ${esc(m.brand ?? '')} - ${esc((m.hazards ?? []).join(', '))}`)) : ''}<p class="small muted">${esc(s.source?.coverage ?? '')} ${esc(s.source?.attribution ?? '')}</p>
    <button class="btn" data-act="safety" ${S.busy === 'safety' || !S.token ? 'disabled' : ''}>${S.busy === 'safety' ? 'Checking...' : 'Refresh live evidence (Safety Gate)'}</button>${S.token ? `<p class="small muted">The cache is kept on this phone and matched here, so it also works offline (shown as CACHED).${S.A.safety.source?.newestPublication ? ` Newest weekly report ingested: ${esc(S.A.safety.source.newestPublication)}.` : ''}</p>` : '<p class="small muted">Add the access token (menu) to download the Safety Gate cache to this phone.</p>'}</div>
  <div class="card"><h2>CUSTOMS</h2><p class="warn">CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION. The codes below are <b>HS/CN CANDIDATES</b>, not a classification. ${esc(cu.limitation)}</p><p><b>${esc(cu.codeLabel)}</b></p>${list(cu.candidates.map((h) => `HS/CN CANDIDATE <b>${esc(h.code)}</b> ${esc(h.desc)} <span class="muted">(${esc(h.confidence)})</span>`))}
    <form data-form="customs"><div class="row">${field('code', 'Candidate code you choose (stays unconfirmed)', cu.chosenCode ?? '')}${field('rate', 'Duty rate % (from your broker / TARIC)', cu.duty?.ratePct ?? '', 'inputmode="decimal"')}</div><button class="btn sec" style="margin-top:8px">Save customs</button></form>${cu.notes.length ? list(cu.notes.map(esc)) : ''}</div>
  <div class="card"><h2>RULES (${A.rules.summary.applies} apply, ${A.rules.summary.unresolved} unresolved)</h2>${sorted.map(one).join('')}</div>
  <div class="card"><h2>FRESHNESS</h2>${list(A.freshness.map((f) => `${esc(f.name)}: <b>${esc(f.status)}</b>${f.checkedAt ? ` (${esc(String(f.checkedAt).slice(0, 10))})` : ''}${f.mode ? ` - ${esc(f.mode.replace(/_/g, ' '))}` : ''}`))}</div>`;
}

function marketScreen(A, c) {
  const m = A.market; const az = c.context.channels.includes('amazon'); const last = c.amazon.observations.at(-1);
  return `<div class="card"><h2>AMAZON - WHAT YOU SAW</h2><p class="small muted">Nordla does not scrape Amazon. Type the listings you looked at (consumer price incl. VAT). A similar listing is NOT proof that you may sell this product.</p>
  <form data-form="obs">${selectOf('marketplace', 'Marketplace', MARKETPLACES.map((x) => [x, x.replace('amazon.', 'Amazon ').toUpperCase().replace('AMAZON ', 'Amazon ')]), last?.marketplace ?? 'amazon.be')}<div class="row">${field('price', 'Price shown (EUR)', '', 'inputmode="decimal" required')}${field('packQty', 'Pack of (units)', 1, 'inputmode="numeric"')}</div><div class="row">${field('asin', 'ASIN (if known)', '', 'autocapitalize="characters"')}${field('reviews', 'Reviews', '', 'inputmode="numeric"')}</div><div class="row">${field('rating', 'Rating (0-5)', '', 'inputmode="decimal"')}${field('title', 'Title / seller')}</div>${field('notes', 'Notes')}<button class="btn" style="margin-top:8px">Add and next</button></form></div>
  <div class="card"><h2>PRICES SEEN (per unit)</h2><table><tr><th>Marketplace</th><th class="n">Min</th><th class="n">Median</th><th class="n">Max</th></tr>${m.byMarketplace.map((x) => `<tr><td>${esc(x.marketplace)}<br><span class="muted small">${esc(x.status)}${x.freshness ? ` - ${esc(x.freshness)}` : ''}</span></td><td class="n">${esc(money(x.minMinor))}</td><td class="n">${esc(money(x.medianMinor))}</td><td class="n">${esc(money(x.maxMinor))}</td></tr>`).join('')}</table>${m.referencePriceMinor ? `<p>Median of observed listings: <b>${esc(money(m.referencePriceMinor))}</b> <button class="btn sec" data-act="useprice" data-key="${m.referencePriceMinor}" style="min-height:36px;padding:4px 10px">Use as selling price (OBSERVED)</button></p>` : ''}${list(m.caveats.map(esc))}
  ${c.amazon.observations.length ? `<h3>Entered</h3><table>${c.amazon.observations.map((o, i) => `<tr><td>${esc(o.marketplace)} ${esc(money(o.priceMinor))}${o.packQty > 1 ? ` /${o.packQty}` : ''}<br><span class="muted small">${esc([o.asin, o.reviews != null ? `${o.reviews} reviews` : null, o.rating != null ? `${o.rating}*` : null, o.notes].filter(Boolean).join(' - '))}</span></td><td class="n"><button class="btn danger" data-act="obs-remove" data-key="${i}" style="min-height:34px;padding:2px 8px">Remove</button></td></tr>`).join('')}</table>` : ''}</div>
  <div class="card"><h2>AMAZON READINESS</h2>${az ? `${chip('', A.amazon.status, A.amazon.status === 'READY' ? 'GREEN' : A.amazon.status === 'NOT_READY' ? 'RED' : A.amazon.status === 'UNKNOWN' ? 'UNKNOWN' : 'AMBER')}<div class="trait" style="margin-top:8px"><div class="nm">Category restricted / gated for you (checked in Seller Central)</div>${seg('amz', 'restricted', c.amazon.restricted ?? null)}</div>${list(A.amazon.notes.map(esc))}${A.amazon.items.length ? `<table>${A.amazon.items.map((i) => `<tr><td>${esc(i.label)}</td><td class="n"><span class="chip t-${i.coverage === 'PRESENT' ? 'GREEN' : i.coverage === 'OWN_ACTION' ? 'UNKNOWN' : 'RED'}">${esc(i.coverage.replace(/_/g, ' '))}</span></td></tr>`).join('')}</table>` : ''}` : '<p class="muted">Amazon is not a target channel: turn it on in Case.</p>'}</div>`;
}

function moneyScreen(A, c) {
  const q = quoteOf(c); const co = c.costs.costs ?? {}; const fx = c.costs.fx ?? {}; const iv = c.costs.importVat ?? {}; const sl = c.sale ?? {}; const sa = c.saleAmazon ?? {}; const L = A.landed; const E = A.economics;
  const lineOf = (k) => co[k]?.total ?? co[k]?.perUnit ?? '';
  return `<div class="card"><h2>SUPPLIER QUOTE</h2><form data-form="quote"><div class="row">${field('unitPrice', 'Unit price', q.unitPrice ?? '', 'inputmode="decimal"')}${selectOf('currency', 'Currency', [['USD', 'USD'], ['CNY', 'CNY'], ['EUR', 'EUR']], q.currency ?? 'USD')}</div><div class="row">${field('qty', 'Quantity I would buy', q.qty ?? '', 'inputmode="numeric"')}${field('moq', 'Supplier MOQ', q.moq ?? '', 'inputmode="numeric"')}</div>${selectOf('incoterm', 'Incoterm', [['', '(not stated)'], ...Object.keys(INCOTERMS).map((k) => [k, k])], q.incoterm ?? '')}<div class="row">${field('leadTimeDays', 'Lead time (days)', q.leadTimeDays ?? '', 'inputmode="numeric"')}${field('carton', 'Carton (cm / kg / units)', q.carton ?? '')}</div><button class="btn" style="margin-top:8px">Save quote</button></form></div>
  <div class="card"><h2>IMPORT COSTS (EUR, whole order)</h2><p class="small muted">Leave blank = UNKNOWN. Nothing is assumed: an unknown critical cost gives INFORMATION INSUFFICIENT.</p><form data-form="costs"><div class="row">${field('fxRate', 'FX: EUR per 1 unit of currency', fx.rate ?? '', 'inputmode="decimal"')}${field('fxDate', 'FX date', fx.date ?? '')}</div><button type="button" class="btn sec" data-act="fx" style="min-height:36px;padding:4px 10px">Fetch today's ECB rate</button><div class="row">${field('freight', 'Freight (total)', lineOf('freight'), 'inputmode="decimal"')}${field('insurance', 'Insurance (total)', lineOf('insurance'), 'inputmode="decimal"')}</div><div class="row">${field('originCharges', 'Origin charges', lineOf('originCharges'), 'inputmode="decimal"')}${field('brokerage', 'Customs broker', lineOf('brokerage'), 'inputmode="decimal"')}</div><div class="row">${field('testing', 'Lab testing', lineOf('testing'), 'inputmode="decimal"')}${field('inspection', 'Inspection', lineOf('inspection'), 'inputmode="decimal"')}</div><div class="row">${field('labelling', 'Labelling / translation', lineOf('labelling'), 'inputmode="decimal"')}${field('epr', 'Recupel / Bebat / packaging', lineOf('epr'), 'inputmode="decimal"')}</div><div class="row">${field('inboundLogistics', 'Delivery to your shop / FBA', lineOf('inboundLogistics'), 'inputmode="decimal"')}${field('importVat', 'Import VAT %', iv.ratePct ?? '', 'inputmode="decimal"')}</div><label><input type="checkbox" name="vatRecoverable" ${iv.recoverable === false ? '' : 'checked'} style="width:auto;min-height:0"> import VAT is recoverable</label><p class="small muted">Amounts are treated as estimates (not quotes).</p><button class="btn" style="margin-top:8px">Save costs</button></form></div>
  <div class="card"><h2>SELLING SIDE</h2><form data-form="sale"><div class="row">${field('price', 'Selling price (incl. VAT)', sl.sellingPriceGross ?? '', 'inputmode="decimal"')}${field('vat', 'VAT %', sl.vatRatePct ?? 21, 'inputmode="decimal"')}</div>${selectOf('basis', 'This price is', [['TARGET', 'TARGET: the price I intend to charge'], ['OBSERVED', 'OBSERVED: a listing I saw'], ['ASSUMED', 'ASSUMED: a placeholder']], sl.priceBasis ?? 'TARGET')}${field('target', 'Target margin (% of price without VAT)', sl.targetContributionPct ?? '', 'inputmode="decimal"')}<button class="btn" style="margin-top:8px">Save</button></form>
  ${c.context.channels.includes('amazon') ? `<h3>Amazon fees (from Seller Central - never guessed)</h3><form data-form="amazon-sale"><div class="row">${field('aprice', 'Amazon price (incl. VAT)', sa.sellingPriceGross ?? '', 'inputmode="decimal"')}${field('avat', 'VAT %', sa.vatRatePct ?? 21, 'inputmode="decimal"')}</div><div class="row">${field('referral', 'Referral fee %', sa.lines?.find((l) => l.key === 'referral')?.value ?? '', 'inputmode="decimal"')}${field('fulfilment', 'FBA fee / unit EUR', sa.lines?.find((l) => l.key === 'fulfilment')?.value ?? '', 'inputmode="decimal"')}</div><button class="btn sec" style="margin-top:8px">Save Amazon</button></form>${A.economicsAmazon ? `<p class="small">Amazon: <b>${esc(A.economicsAmazon.status)}</b>${A.economicsAmazon.contributionMinor != null ? ` - contribution ${esc(money(A.economicsAmazon.contributionMinor))}${A.economicsAmazon.contributionIsUpperBound ? ' (UPPER BOUND)' : ''}` : ''}</p>` : ''}` : ''}</div>
  <div class="card"><h2>LANDED COST</h2>${chip('', L.status, L.status === 'COMPLETE' ? 'GREEN' : L.status === 'RANGE' ? 'AMBER' : 'RED')}${L.status === 'INFORMATION_INSUFFICIENT' ? `<p class="warn">Critical unknown: ${esc((L.criticalUnknown ?? []).join(', '))}</p>` : `<div class="big">${esc(money(L.totals.landedPerUnitEurMinor))}<span class="muted small"> per unit${L.totals.rangeEurMinor ? ` (range ${esc(money(L.totals.rangeEurMinor.perUnit.min))} - ${esc(money(L.totals.rangeEurMinor.perUnit.max))})` : ''}</span></div>`}
  <table>${(L.lines ?? []).map((l) => `<tr><td>${esc(l.key)}</td><td class="n"><span class="muted small">${esc(l.status)}</span> ${esc(money(l.totalMinor))}</td></tr>`).join('')}</table>${L.warnings?.length ? list(L.warnings.map(esc)) : ''}${E.contributionMinor != null ? `<h3>Per unit</h3><p>Contribution <b>${esc(money(E.contributionMinor))}</b>${E.contributionPct != null ? ` = ${(E.contributionPct * 100).toFixed(1)}% of net revenue` : ''}${E.breakEvenGrossMinor ? `; break-even selling price ${esc(money(E.breakEvenGrossMinor))}` : ''}</p>` : `<p class="muted">${esc(E.reason ?? '')}</p>`}</div>`;
}

const SCREENS = { decision: decisionScreen, case: caseScreen, ask: askScreen, docs: docsScreen, compliance: rulesScreen, market: marketScreen, money: moneyScreen };

// ---- shell ------------------------------------------------------------------------------------------------------------------------------------------------------------------
function paintHeader() {
  const c = cur(); if (!c) return;
  $('#case-name').textContent = c.identity.workingName || 'New case'; $('#case-sub').textContent = [c.supplier.name, c.identity.identifiers.model].filter(Boolean).join(' - ');
  const mode = S.A?.dataMode ?? 'OFFLINE_VERIFICATION_REQUIRED'; const el = $('#mode');
  el.className = `badge ${mode === 'LIVE_VERIFIED' ? 'b-live' : mode === 'CACHED' ? 'b-cached' : 'b-off'}`;
  el.textContent = mode === 'LIVE_VERIFIED' ? 'LIVE VERIFIED' : mode === 'CACHED' ? 'CACHED' : 'OFFLINE - VERIFY'; el.title = `${S.online ? 'server reachable' : 'server not reachable (the case works offline)'}`;
}
function gate() {
  return `<div class="card"><h2>SIGN IN</h2><p class="small muted">Enter the access token of your Nordla server to keep cases on it and use the Safety Gate cache. Or work on this phone only: everything except live checks works offline.</p>${S.authFailed ? '<p class="warn">The token was refused.</p>' : ''}<label>Access token<input id="gate-tok" type="password" autocomplete="off"></label><button class="btn" data-act="gate-save" style="margin-top:10px">Sign in</button><button class="btn sec" data-act="gate-offline" style="margin-top:8px">Work on this phone only</button></div>`;
}
function render() {
  ensureCase(); const c = cur();
  if ((!S.token && !S.offlineChoice) || S.authFailed) { $('#tabs').innerHTML = ''; $('#screen').innerHTML = gate(); $('#case-name').textContent = 'Nordla - Sourcing'; return; }
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-act="tab" data-key="${k}" aria-current="${S.tab === k}">${l}</button>`).join('');
  try { S.A = run(c); S.error = null; } catch (e) { S.error = e; console.error(e); }
  paintHeader();
  const main = $('#screen');
  main.innerHTML = `${S.flash ? `<div class="warn">${esc(S.flash)}</div>` : ''}${S.error ? `<div class="warn"><b>This screen could not be computed.</b> Your case is saved. ${esc(String(S.error.message ?? S.error))}</div>` : SCREENS[S.tab](S.A, c)}`;
}

const readForm = (f) => Object.fromEntries(new FormData(f).entries());
const num = (v) => (v === '' || v === undefined || v === null ? null : String(v).replace(',', '.'));
const lineSpec = (v) => (num(v) === null ? undefined : { total: num(v), status: 'ESTIMATED' });

async function onSubmit(ev) {
  const f = ev.target.closest('form[data-form]'); if (!f) return; ev.preventDefault(); const d = readForm(f); const name = f.dataset.form; const c = cur();
  if (name === 'product') {
    const e = (event) => { S.cases[S.currentId] = dispatch(cur(), event, new Date()); };
    if (d.name !== c.identity.workingName) e({ type: 'NAME', name: d.name });
    for (const k of ['model', 'brand', 'manufacturer', 'gtin']) if (d[k] && d[k] !== (cur().identity.identifiers[k] ?? '')) e({ type: 'IDENTIFIER', name: k, value: d[k].trim() });
    if (d.category) e({ type: 'CATEGORY', category: d.category });
    persist(); return commit({ type: 'NOTE', text: 'product updated' });
  }
  if (name === 'electrics') {
    const e = (event) => { S.cases[S.currentId] = dispatch(cur(), event, new Date()); };
    if (num(d.vac) !== null) e({ type: 'TRAIT', trait: 'electrical.maxVoltageAc', value: Number(num(d.vac)) });
    if (num(d.vdc) !== null) e({ type: 'TRAIT', trait: 'electrical.maxVoltageDc', value: Number(num(d.vdc)) });
    if (d.chem) e({ type: 'TRAIT', trait: 'battery.chemistry', value: d.chem });
    return commit({ type: 'NOTE', text: 'ratings updated' });
  }
  if (name === 'supplier') return commit({ type: 'SUPPLIER', supplier: d });
  if (name === 'quote') return commit({ type: 'QUOTE', quote: { unitPrice: num(d.unitPrice), currency: d.currency, qty: num(d.qty) ? Number(num(d.qty)) : null, moq: num(d.moq) ? Number(num(d.moq)) : null, incoterm: d.incoterm || null, leadTimeDays: num(d.leadTimeDays), carton: d.carton || null } });
  if (name === 'costs') {
    const costs = {}; for (const k of ['freight', 'insurance', 'originCharges', 'brokerage', 'testing', 'inspection', 'labelling', 'epr', 'inboundLogistics']) { const s = lineSpec(d[k]); if (s) costs[k] = s; }
    return commit({ type: 'COSTS', costs: { fx: num(d.fxRate) ? { rate: num(d.fxRate), date: d.fxDate || new Date().toISOString().slice(0, 10), source: 'USER_ENTERED' } : undefined, costs, importVat: num(d.importVat) ? { ratePct: num(d.importVat), recoverable: d.vatRecoverable === 'on' } : undefined } });
  }
  if (name === 'sale') return commit({ type: 'SALE', sale: { sellingPriceGross: num(d.price), vatRatePct: num(d.vat), targetContributionPct: num(d.target), priceBasis: d.basis || 'TARGET' } });
  if (name === 'amazon-sale') { const lines = []; if (num(d.referral)) lines.push({ key: 'referral', kind: 'pct_of_gross', value: num(d.referral), status: 'KNOWN', source: 'Seller Central (entered)' }); else lines.push({ key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }); if (num(d.fulfilment)) lines.push({ key: 'fulfilment', kind: 'per_unit', value: num(d.fulfilment), status: 'KNOWN', source: 'Seller Central (entered)' }); else lines.push({ key: 'fulfilment', kind: 'per_unit', status: 'UNKNOWN' }); return commit({ type: 'SALE_AMAZON', sale: { sellingPriceGross: num(d.aprice), vatRatePct: num(d.avat), lines } }); }
  if (name === 'customs') return commit({ type: 'CUSTOMS', customs: { chosenCode: d.code || null, duty: num(d.rate) ? { ratePct: num(d.rate), kind: 'USER_ENTERED', source: 'entered by the owner' } : cur().customs?.duty } });
  if (name === 'obs') return commit({ type: 'AMAZON_OBS', observation: { marketplace: d.marketplace, price: num(d.price), packQty: num(d.packQty), asin: d.asin, reviews: num(d.reviews), rating: num(d.rating), title: d.title, notes: d.notes, source: 'MANUAL' } });
  if (name === 'whatif') { if (num(d.unitPrice) === null) return; try { S.whatIf = whatIf(cur(), { unitPrice: num(d.unitPrice), currency: quoteOf(cur()).currency ?? 'USD' }, { now: new Date(), externals: externals() }); } catch (e) { S.flash = `Could not compute: ${e.message}`; } return render(); }
  if (name === 'doc') return addDocument(f, d);
  if (name === 'doc-correct') return commit({ type: 'DOCUMENT_CORRECT', id: f.dataset.id, text: d.text ?? '' });
  if (name === 'doc-typed') {
    const lines = [{ EU_DOC: 'EU DECLARATION OF CONFORMITY', TEST_REPORT: 'TEST REPORT', CERTIFICATE: 'CERTIFICATE', SDS: 'SAFETY DATA SHEET', UN383: 'UN 38.3 test summary', FCM_DOC: 'Declaration of Compliance - food contact', MANUAL: 'USER MANUAL' }[d.docType] ?? 'DOCUMENT', d.manufacturer && `Manufacturer: ${d.manufacturer}`, d.model && `Model: ${d.model}`, d.directives && `Union legislation: ${d.directives}`, d.standards && `Standards: ${d.standards}`, d.lab && `Testing laboratory: ${d.lab}`, d.date && `Date of issue: ${d.date}`, d.pages && `Page ${d.pages.replace(/\s*of\s*/i, ' of ')}`].filter(Boolean);
    return commit({ type: 'DOCUMENT', fileName: 'typed from the paper', text: lines.join('\n'), textSource: 'TRANSCRIBED', docType: d.docType, summary: 'document typed from the paper' });
  }
}

const downscale = async (file, max, q) => { const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); return cv.toDataURL('image/jpeg', q); };
async function addDocument(form, d) {
  const file = form.elements.file.files[0]; let text = d.text ?? ''; let pages = null; let note = ''; let textSource = 'PASTED'; let photoRef = null; let ocrProvider = null; const id = `doc-${cur().documents.length + 1}`;
  S.busy = 'doc'; render();
  try {
    if (file && !text) {
      if (file.type.startsWith('image/')) {
        const url = await downscale(file, 1600, 0.8); photoRef = `docphoto-${id}`; ls.set(`nordla.sourcing.docphoto.${cur().id}.${id}`, url);
        textSource = 'PHOTO_ONLY'; note = 'The photo is kept as evidence but could not be read: type what the paper says (below, in the document card).';
        if (S.token && S.online && S.ai?.enabled) {
          if (window.confirm(`Send this image of the document to ${S.ai.provider} (${S.ai.region}) to be read? Supplier documents are confidential. Choose Cancel to keep the photo only.`)) {
            try { const r = await api('/api/documents/extract', { method: 'POST', body: JSON.stringify({ fileName: file.name, mime: 'image/jpeg', dataBase64: url.split(',')[1], consent: true }) }); text = r.text ?? ''; textSource = 'OCR'; ocrProvider = r.provider ?? null; note = r.note ?? ''; }
            catch (e) { note = `The reader failed (${e.message}). The photo is kept: type what the paper says.`; }
          } else note = 'Photo kept, not sent. Type what the paper says.';
        }
      } else if (/\.txt$/i.test(file.name) || file.type.startsWith('text/')) { text = await file.text(); }
      else if (S.token) { const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); const r = await api('/api/documents/extract', { method: 'POST', body: JSON.stringify({ fileName: file.name, mime: file.type, dataBase64: btoa(bin) }) }); text = r.text ?? ''; pages = r.pages ?? null; note = r.note ?? ''; textSource = r.textSource ?? 'PHOTO_ONLY'; }
      else note = 'Reading a PDF needs the server (add the access token, menu). Paste or type the text instead.';
    }
    S.flash = note;
    commit({ type: 'DOCUMENT', id, fileName: file?.name ?? 'pasted text', text, pages, claimedType: d.claimed || null, textSource: text ? textSource : (textSource === 'OCR' ? 'OCR' : textSource), photoRef, ocrProvider, summary: 'document added' });
  } catch (e) { S.flash = `The document could not be read (${e.message}). Paste or type its text instead.`; }
  S.busy = ''; render();
}

function supplierText(A) { return A.supplierSheet.items.map((i) => `${i.n}. ${i.en}\n   ${i.zh}`).join('\n\n'); }
async function onClick(ev) {
  const t = ev.target.closest('[data-act]'); if (!t) return; const act = t.dataset.act; const key = t.dataset.key; const val = t.dataset.val !== undefined ? JSON.parse(t.dataset.val) : undefined;
  if (act === 'tab') { S.tab = key; S.flash = ''; render(); $('#screen').focus({ preventScroll: true }); window.scrollTo(0, 0); return; }
  if (act === 'trait') return commit({ type: 'TRAIT', trait: key, value: val });
  if (act === 'place') return commit({ type: 'PLACING', placing: { [key]: val } });
  if (act === 'chan') { const set = new Set(cur().context.channels); if (val) set.add(key); else set.delete(key); if (set.size === 0) { S.flash = 'Pick at least one sales channel.'; return render(); } return commit({ type: 'CONTEXT', context: { channels: [...set] } }); }
  if (act === 'amz') return commit({ type: 'AMAZON', amazon: { restricted: val } });
  if (act === 'cat') return commit({ type: 'CATEGORY', category: key });
  if (act === 'safety') return checkSafety();
  if (act === 'useprice') return commit({ type: 'SALE', sale: { sellingPriceGross: String(Number(key) / 100), vatRatePct: cur().sale?.vatRatePct ?? '21', priceBasis: 'OBSERVED' } });
  if (act === 'show-sup') return showSupplier();
  if (act === 'copy-sup') { try { await navigator.clipboard.writeText(supplierText(S.A)); S.flash = 'Copied.'; } catch { S.flash = 'Copy is not available here: use "Show to supplier".'; } return render(); }
  if (act === 'close-overlay') { $('#overlay').hidden = true; $('#overlay').className = ''; return; }
  if (act === 'newcase') { const c = newCase({}); S.cases[c.id] = c; S.currentId = c.id; S.tab = 'case'; persist(); closeOverlay(); return render(); }
  if (act === 'opencase') { S.currentId = key; S.tab = 'decision'; persist(); closeOverlay(); return render(); }
  if (act === 'server-copy') { if (S.conflict) { S.cases[S.conflict.id] = S.conflict; S.conflict = null; S.flash = ''; persist(); closeOverlay(); render(); } return; }
  if (act === 'export') { const blob = new Blob([JSON.stringify(cur(), null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nordla-case-${cur().id}.json`; a.click(); return; }
  if (act === 'gate-save') { S.token = $('#gate-tok').value.trim(); ls.set('nordla.sourcing.token', S.token); S.authFailed = false; await ping(); if (!S.authFailed) { await checkSafety(); queueSync(); } return render(); }
  if (act === 'gate-offline') { S.offlineChoice = true; ls.set('nordla.sourcing.offlineChoice', true); return render(); }
  if (act === 'fx') return fetchFx();
  if (act === 'cat-confirm') { S.suggestions = []; return commit({ type: 'CATEGORY', category: key }); }
  if (act === 'cat-guess') { S.suggestions = []; return commit({ type: 'CATEGORY', category: key, level: 'AI_SUGGESTED' }); }
  if (act === 'doc-confirm') return commit({ type: 'DOCUMENT_CONFIRM', id: key });
  if (act === 'obs-remove') return commit({ type: 'AMAZON_OBS_REMOVE', index: Number(key) });
  if (act === 'savetoken') { S.token = $('#tok').value.trim(); ls.set('nordla.sourcing.token', S.token); await ping(); closeOverlay(); queueSync(); return render(); }
}
const closeOverlay = () => { const o = $('#overlay'); o.hidden = true; o.className = ''; };
function showSupplier() {
  const o = $('#overlay'); o.hidden = false; o.className = 'show show-sup';
  o.innerHTML = `<button class="btn sec" data-act="close-overlay">Close</button><p class="small muted">${esc(S.A.supplierSheet.note.zh)}</p>${S.A.supplierSheet.items.map((i) => `<div class="q-item"><b>${i.n}.</b> ${esc(i.en)}<div class="zh" lang="zh-Hans">${esc(i.zh)}</div></div>`).join('')}<button class="btn sec" data-act="close-overlay">Close</button>`;
}
function openMenu() {
  const o = $('#overlay'); o.hidden = false; o.className = 'show';
  o.innerHTML = `<button class="btn sec" data-act="close-overlay">Close</button><h2>Cases</h2><button class="btn" data-act="newcase">New product case</button>${Object.values(S.cases).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => `<div class="card"><b>${esc(c.identity.workingName || 'Untitled')}</b> <span class="muted small">${esc(c.supplier.name ?? '')} - ${esc(c.updatedAt.slice(0, 16).replace('T', ' '))} - ${esc(c.decisions.at(-1)?.verdict?.replace(/_/g, ' ') ?? 'no decision yet')}</span><br><button class="btn sec" data-act="opencase" data-key="${esc(c.id)}" style="margin-top:6px">Open</button></div>`).join('')}
  <h2>Server (optional)</h2><p class="small muted">Without it everything works offline on this device. With it: cases are kept on your server, the Safety Gate cache and PDF reading are available.</p><label>Access token<input id="tok" type="password" autocomplete="off" value="${esc(S.token)}"></label><button class="btn" data-act="savetoken" style="margin-top:8px">Save token</button>${S.conflict ? '<p class="warn">A newer copy of this case exists on the server.</p><button class="btn danger" data-act="server-copy">Replace my copy with the server copy</button>' : ''}<h2>This case</h2><button class="btn sec" data-act="export">Export as JSON</button>`;
}

async function onPhoto(ev) {
  const t = ev.target.closest('input[data-act="photo"]'); if (!t || !t.files[0]) return; const file = t.files[0]; const c = cur();
  try {
    const url = await downscale(file, 640, 0.7); const n = c.identity.photos.length; if (!ls.set(`nordla.sourcing.photo.${c.id}.${n}`, url)) S.flash = 'Photo too large for local storage: it was not saved.';
    commit({ type: 'PHOTO', ref: `photo-${n}`, note: file.name });
    S.flash = 'Photo saved as EVIDENCE. Nordla does not recognise products by itself: choose what it is below (or in the category list) to confirm it.';
    if (S.token && S.online && S.ai?.enabled) {
      if (window.confirm(`Send this photo to ${S.ai.provider} (${S.ai.region}) to get a category SUGGESTION? Only the photo is sent. Cancel keeps it on this phone.`)) {
        try { const r = await api('/api/ai/describe', { method: 'POST', body: JSON.stringify({ imageBase64: url.split(',')[1], imageMime: 'image/jpeg', consent: true }) }); S.suggestions = r.suggestions ?? []; S.flash = S.suggestions.length ? 'AI SUGGESTED categories below: not a fact until you confirm.' : 'The reader could not tell what it is: choose the category yourself.'; } catch { S.flash = 'The reader could not be reached: choose the category yourself.'; }
      }
    }
    render();
  } catch { S.flash = 'This photo could not be read.'; render(); }
}

document.addEventListener('click', onClick); document.addEventListener('submit', onSubmit); document.addEventListener('change', onPhoto);
$('#btn-cases').addEventListener('click', openMenu);
window.addEventListener('online', ping); window.addEventListener('offline', () => { S.online = false; render(); });
setInterval(() => { if (S.token) ping(); }, 30000); // notice a lost or recovered connection
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(() => { S.sw = 'registered'; }).catch((e) => { S.sw = `not registered (${e.message})`; });
window.nordlaSourcing = { state: () => ({ sw: S.sw, online: S.online, token: !!S.token }) };
render(); ping();
