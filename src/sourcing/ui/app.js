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
const S = { cases: ls.get('nordla.sourcing.cases', {}), currentId: ls.get('nordla.sourcing.current', null), tab: 'decision', token: ls.get('nordla.sourcing.token', ''), online: false, busy: '', flash: '', whatIf: null, A: null, error: null };

const cur = () => S.cases[S.currentId];
function persist() { if (!ls.set('nordla.sourcing.cases', S.cases)) S.flash = 'Local storage is full: export the case (menu) before adding more photos.'; ls.set('nordla.sourcing.current', S.currentId); }
function ensureCase() { if (!cur()) { const c = newCase({}); S.cases[c.id] = c; S.currentId = c.id; persist(); } }

/** Every change goes through here: event -> new state -> saved locally -> synced when a server is reachable. */
function commit(event) {
  S.cases[S.currentId] = dispatch(cur(), event, new Date()); S.whatIf = null;
  try { const a = assess(cur(), { now: new Date() }); S.cases[S.currentId] = recordDecision(cur(), a, new Date()); } catch { /* shown by render */ }
  persist(); render(); queueSync();
}

// ---- optional server -------------------------------------------------------------------------------------------------------------------------------------------------------
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { 'x-sourcing-token': S.token, 'content-type': 'application/json', ...(opts.headers ?? {}) } }); const body = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(body.error ?? r.status), { status: r.status, body }); return body; };
async function ping() { if (!S.token) { S.online = false; return; } try { await api('/api/health'); S.online = true; } catch { S.online = false; } paintHeader(); }
let syncTimer = null;
function queueSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); }
async function sync() {
  if (!S.token || !cur()) return;
  try { const saved = await api(`/api/cases/${cur().id}`, { method: 'PUT', body: JSON.stringify(cur()) }); S.cases[saved.id] = saved; persist(); S.online = true; }
  catch (e) { if (e.status === 409) { S.flash = 'This case was changed on another device. Your copy is kept here; open the menu to take the server copy.'; S.conflict = e.body?.server ?? null; } else S.online = false; }
  paintHeader();
}
async function checkSafety() {
  const facts = safetyFacts(cur()); S.busy = 'safety'; render();
  try { const r = await api('/api/safety/check', { method: 'POST', body: JSON.stringify({ identity: facts }) }); S.flash = ''; commit({ type: 'SAFETY_SNAPSHOT', snapshot: { ...r, identityKey: safetyKey(facts), checkedAt: new Date().toISOString() }, summary: `Safety Gate: ${r.status}` }); }
  catch (e) { S.flash = e.status === 401 ? 'Wrong or missing access token (menu).' : 'The Safety Gate could not be reached: OFFLINE - VERIFICATION REQUIRED. This is not a clean result.'; }
  S.busy = ''; render();
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
    <label>Photo of the product / label / packaging</label><input type="file" accept="image/*" capture="environment" data-act="photo"><div style="margin-top:6px">${photos}</div></div>
  <div class="card"><h2>WHAT IS IT, FOR REAL?</h2><p class="small muted">Each answer is stronger than the category guess. Unknown stays unknown.</p>
    ${TRAITS.map(([t, l]) => `<div class="trait"><div><div class="nm">${esc(l)}</div><div class="lv">${esc(level(t))}</div></div>${seg('trait', t, effective(id, t).known ? effective(id, t).value : null)}</div>`).join('')}
    ${radioOn ? `<div class="trait"><div><div class="nm">Connects to the internet / app</div><div class="lv">${esc(level('radio.internetConnected'))}</div></div>${seg('trait', 'radio.internetConnected', effective(id, 'radio.internetConnected').known ? effective(id, 'radio.internetConnected').value : null)}</div><div class="trait"><div><div class="nm">Handles personal data (account, voice, location)</div><div class="lv">${esc(level('radio.processesPersonalData'))}</div></div>${seg('trait', 'radio.processesPersonalData', effective(id, 'radio.processesPersonalData').known ? effective(id, 'radio.processesPersonalData').value : null)}</div>` : ''}
    <form data-form="electrics"><div class="row">${field('vac', 'Rated AC volts', effective(id, 'electrical.maxVoltageAc').value ?? '', 'inputmode="decimal"')}${field('vdc', 'Rated DC volts', effective(id, 'electrical.maxVoltageDc').value ?? '', 'inputmode="decimal"')}</div>${selectOf('chem', 'Battery type', [['', '(unknown)'], ['li_ion', 'Lithium-ion'], ['li_po', 'Lithium-polymer'], ['other', 'Other / not lithium']], effective(id, 'battery.chemistry').value ?? '')}<button class="btn sec" style="margin-top:8px">Save ratings</button></form></div>
  <div class="card"><h2>WHO IS RESPONSIBLE?</h2><div class="trait"><div class="nm">Sold under MY name / brand (private label)</div>${seg('place', 'underOwnNameOrBrand', c.placing.underOwnNameOrBrand ?? null)}</div>
    <div class="trait"><div class="nm">Manufacturer is in the EU</div>${seg('place', 'manufacturerEstablishedInEU', c.placing.manufacturerEstablishedInEU ?? null)}</div>
    <div class="trait"><div class="nm">Supplier names an EU representative</div>${seg('place', 'euAuthorisedRepresentative', c.placing.euAuthorisedRepresentative ?? null)}</div>
    <div class="trait"><div class="nm">I modify the product substantially</div>${seg('place', 'substantialModification', c.placing.substantialModification ?? null)}</div>
    <p class="note">${esc(A.role.note)} Role now: <b>${esc(A.role.role.replace(/_/g, ' '))}</b></p></div>
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
  return `<div class="card"><h2>ADD A SUPPLIER DOCUMENT</h2><p class="small muted">Declaration of conformity, test report, certificate, safety data sheet, manual, label... Nordla reads the text, then compares it with the case. It never says "fake": only what the evidence shows.</p>
  <form data-form="doc"><label>File (PDF with text, or .txt)<input type="file" name="file" accept=".pdf,.txt,text/plain,application/pdf"></label><label>Or paste the text<textarea name="text" placeholder="Paste the text of the document"></textarea></label>${selectOf('claimed', 'The supplier calls it', [['', '(not stated)'], ['EU_DOC', 'EU Declaration of Conformity'], ['TEST_REPORT', 'Test report'], ['CERTIFICATE', 'Certificate'], ['SDS', 'Safety data sheet'], ['UN383', 'UN 38.3 report'], ['FCM_DOC', 'Food-contact declaration'], ['MANUAL', 'Manual']])}
  <button class="btn" style="margin-top:10px" ${S.busy === 'doc' ? 'disabled' : ''}>${S.busy === 'doc' ? 'Reading...' : 'Inspect document'}</button></form></div>
  ${A.documents.length ? A.documents.map((d) => `<div class="card"><h2>${esc(d.fileName ?? d.id)} <span class="muted small">${esc(d.docType)}</span></h2>${chip('Consistency', d.consistency, d.consistency === 'NO_ISSUE_FOUND' ? 'GREEN' : d.consistency === 'UNVERIFIED' || d.consistency === 'INSUFFICIENT_EVIDENCE' ? 'AMBER' : 'RED')}${d.findings.length ? list(d.findings.map((f) => `<b>${esc(f.code.replace(/_/g, ' '))}</b> (${esc(f.severity)}) - ${esc(f.detail)}`)) : ''}${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}<p class="small muted">Models: ${esc(d.models.join(', ') || '-')} - Standards: ${esc(d.standards.slice(0, 5).join(', ') || '-')}</p></div>`).join('') : '<p class="muted">No document yet.</p>'}
  ${A.crossChecks.length ? `<div class="card"><h2>BETWEEN DOCUMENTS</h2>${list(A.crossChecks.map((f) => esc(f.detail)))}</div>` : ''}`;
}

function rulesScreen(A, c) {
  const rs = A.rules.results; const order = { APPLIES: 0, UNRESOLVED: 1, NOT_APPLICABLE: 2 };
  const sorted = [...rs].sort((a, b) => order[a.status] - order[b.status] || (b.severity === 'HIGH') - (a.severity === 'HIGH'));
  const s = A.safety; const cu = A.customs;
  const one = (r) => `<details ${r.status === 'APPLIES' && r.severity === 'HIGH' ? 'open' : ''}><summary>${esc(r.title)} <span class="chip t-${r.status === 'APPLIES' ? 'AMBER' : r.status === 'UNRESOLVED' ? 'UNKNOWN' : 'GREEN'}">${esc(r.status.replace(/_/g, ' '))}</span> ${r.jurisdiction !== 'EU' ? `<span class="chip">${esc(r.jurisdiction)}</span>` : ''}</summary>
    <p>${esc(r.why)}</p>${r.requiredEvidence.length && r.status !== 'NOT_APPLICABLE' ? `<table>${r.requiredEvidence.map((e) => `<tr><td>${esc(e.label)}<br><span class="muted small">${esc(e.requirement)}</span></td><td class="n"><span class="chip t-${e.coverage.status === 'PRESENT' ? 'GREEN' : e.coverage.status === 'OWN_ACTION' ? 'UNKNOWN' : 'RED'}">${esc(e.coverage.status.replace(/_/g, ' '))}</span></td></tr>`).join('')}</table>` : ''}
    <p class="small muted">Sources: ${r.sources.map((x) => `${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>` : esc(x.title)} [${esc(x.verification.replace(/_/g, ' '))}]`).join('; ') || 'none'}<br>${esc(r.sourceVerification.replace(/_/g, ' '))} - ${esc(r.freshness)} - rule ${esc(r.ruleVersion)}${r.requiresAuthorityConfirmation ? ' - REQUIRES EXPERT / AUTHORITY CONFIRMATION' : ''}</p>${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ''}</details>`;
  return `<div class="card"><h2>CE MARKING</h2>${chip('', A.rules.ce?.status ?? 'CE_APPLICABILITY_UNRESOLVED', A.rules.ce?.status === 'CE_REQUIRED' ? 'AMBER' : A.rules.ce?.status === 'CE_NOT_APPLICABLE' ? 'GREEN' : 'UNKNOWN')}<p>${esc(A.rules.ce?.why ?? '')}</p><p class="small muted">A CE logo on a product or a listing proves nothing; the EU declaration of conformity and its evidence do.</p></div>
  <div class="card"><h2>EU SAFETY GATE</h2>${chip('', s.status, s.status === 'EXACT_MATCH' || s.status === 'PROBABLE_MATCH' ? 'RED' : s.status === 'SIMILAR_PRODUCT_RISK' ? 'AMBER' : s.status === 'NO_MATCH_FOUND' ? 'GREEN' : 'UNKNOWN')} ${chip('Data', A.dataMode.replace(/_/g, ' '), A.dataMode === 'LIVE_VERIFIED' ? 'GREEN' : A.dataMode === 'CACHED' ? 'AMBER' : 'RED')}
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}${s.matches?.length ? list(s.matches.slice(0, 5).map((m) => `<b>${esc(m.basis.replace(/_/g, ' '))}</b> ${esc(m.alertNumber ?? '')} - ${esc(m.name ?? '')} ${esc(m.brand ?? '')} - ${esc((m.hazards ?? []).join(', '))}`)) : ''}<p class="small muted">${esc(s.source?.coverage ?? '')} ${esc(s.source?.attribution ?? '')}</p>
    <button class="btn" data-act="safety" ${S.busy === 'safety' || !S.token ? 'disabled' : ''}>${S.busy === 'safety' ? 'Checking...' : 'Check the Safety Gate now'}</button>${S.token ? '' : '<p class="small muted">Add the access token (menu) to use the Safety Gate cache.</p>'}</div>
  <div class="card"><h2>CUSTOMS</h2><p class="warn">CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION - candidates are hints, not a classification.</p>${list(cu.candidates.map((h) => `<b>${esc(h.code)}</b> ${esc(h.desc)} <span class="muted">(${esc(h.confidence)})</span>`))}
    <form data-form="customs"><div class="row">${field('code', 'Code you choose', cu.chosenCode ?? '')}${field('rate', 'Duty rate % (from your broker / TARIC)', cu.duty?.ratePct ?? '', 'inputmode="decimal"')}</div><button class="btn sec" style="margin-top:8px">Save customs</button></form>${cu.notes.length ? list(cu.notes.map(esc)) : ''}</div>
  <div class="card"><h2>RULES (${A.rules.summary.applies} apply, ${A.rules.summary.unresolved} unresolved)</h2>${sorted.map(one).join('')}</div>
  <div class="card"><h2>FRESHNESS</h2>${list(A.freshness.map((f) => `${esc(f.name)}: <b>${esc(f.status)}</b>${f.checkedAt ? ` (${esc(String(f.checkedAt).slice(0, 10))})` : ''}${f.mode ? ` - ${esc(f.mode.replace(/_/g, ' '))}` : ''}`))}</div>`;
}

function marketScreen(A, c) {
  const m = A.market; const az = c.context.channels.includes('amazon');
  return `<div class="card"><h2>AMAZON - WHAT YOU SAW</h2><p class="small muted">Nordla does not scrape Amazon. Enter listings you looked at (consumer price incl. VAT). A similar listing is NOT proof that you may sell this product.</p>
  <form data-form="obs">${selectOf('marketplace', 'Marketplace', MARKETPLACES.map((x) => [x, x]))}<div class="row">${field('price', 'Price EUR', '', 'inputmode="decimal" required')}${field('reviews', 'Reviews', '', 'inputmode="numeric"')}</div>${field('title', 'Listing title')}${field('url', 'Link')}<button class="btn" style="margin-top:8px">Add observation</button></form></div>
  <div class="card"><h2>PRICES SEEN</h2><table><tr><th>Marketplace</th><th class="n">Min</th><th class="n">Median</th><th class="n">Max</th></tr>${m.byMarketplace.map((x) => `<tr><td>${esc(x.marketplace)}<br><span class="muted small">${esc(x.status)}${x.freshness ? ` - ${esc(x.freshness)}` : ''}</span></td><td class="n">${esc(money(x.minMinor))}</td><td class="n">${esc(money(x.medianMinor))}</td><td class="n">${esc(money(x.maxMinor))}</td></tr>`).join('')}</table>${m.referencePriceMinor ? `<p>Reference (median observed): <b>${esc(money(m.referencePriceMinor))}</b> <button class="btn sec" data-act="useprice" data-key="${m.referencePriceMinor}" style="min-height:36px;padding:4px 10px">Use as my selling price</button></p>` : ''}${list(m.caveats.map(esc))}</div>
  <div class="card"><h2>AMAZON READINESS</h2>${az ? `${chip('', A.amazon.status, A.amazon.status === 'READY' ? 'GREEN' : A.amazon.status === 'NOT_READY' ? 'RED' : A.amazon.status === 'UNKNOWN' ? 'UNKNOWN' : 'AMBER')}<div class="trait" style="margin-top:8px"><div class="nm">Category restricted / gated for you (checked in Seller Central)</div>${seg('amz', 'restricted', c.amazon.restricted ?? null)}</div>${list(A.amazon.notes.map(esc))}${A.amazon.items.length ? `<table>${A.amazon.items.map((i) => `<tr><td>${esc(i.label)}</td><td class="n"><span class="chip t-${i.coverage === 'PRESENT' ? 'GREEN' : i.coverage === 'OWN_ACTION' ? 'UNKNOWN' : 'RED'}">${esc(i.coverage.replace(/_/g, ' '))}</span></td></tr>`).join('')}</table>` : ''}` : '<p class="muted">Amazon is not a target channel: turn it on in Case.</p>'}</div>`;
}

function moneyScreen(A, c) {
  const q = quoteOf(c); const co = c.costs.costs ?? {}; const fx = c.costs.fx ?? {}; const iv = c.costs.importVat ?? {}; const sl = c.sale ?? {}; const sa = c.saleAmazon ?? {}; const L = A.landed; const E = A.economics;
  const lineOf = (k) => co[k]?.total ?? co[k]?.perUnit ?? '';
  return `<div class="card"><h2>SUPPLIER QUOTE</h2><form data-form="quote"><div class="row">${field('unitPrice', 'Unit price', q.unitPrice ?? '', 'inputmode="decimal"')}${selectOf('currency', 'Currency', [['USD', 'USD'], ['CNY', 'CNY'], ['EUR', 'EUR']], q.currency ?? 'USD')}</div><div class="row">${field('qty', 'Quantity I would buy', q.qty ?? '', 'inputmode="numeric"')}${field('moq', 'Supplier MOQ', q.moq ?? '', 'inputmode="numeric"')}</div>${selectOf('incoterm', 'Incoterm', [['', '(not stated)'], ...Object.keys(INCOTERMS).map((k) => [k, k])], q.incoterm ?? '')}<div class="row">${field('leadTimeDays', 'Lead time (days)', q.leadTimeDays ?? '', 'inputmode="numeric"')}${field('carton', 'Carton (cm / kg / units)', q.carton ?? '')}</div><button class="btn" style="margin-top:8px">Save quote</button></form></div>
  <div class="card"><h2>IMPORT COSTS (EUR, whole order)</h2><p class="small muted">Leave blank = UNKNOWN. Nothing is assumed: an unknown critical cost gives INFORMATION INSUFFICIENT.</p><form data-form="costs"><div class="row">${field('fxRate', 'FX: EUR per 1 unit of currency', fx.rate ?? '', 'inputmode="decimal"')}${field('fxDate', 'FX date', fx.date ?? '')}</div><div class="row">${field('freight', 'Freight (total)', lineOf('freight'), 'inputmode="decimal"')}${field('insurance', 'Insurance (total)', lineOf('insurance'), 'inputmode="decimal"')}</div><div class="row">${field('originCharges', 'Origin charges', lineOf('originCharges'), 'inputmode="decimal"')}${field('brokerage', 'Customs broker', lineOf('brokerage'), 'inputmode="decimal"')}</div><div class="row">${field('testing', 'Lab testing', lineOf('testing'), 'inputmode="decimal"')}${field('inspection', 'Inspection', lineOf('inspection'), 'inputmode="decimal"')}</div><div class="row">${field('labelling', 'Labelling / translation', lineOf('labelling'), 'inputmode="decimal"')}${field('epr', 'Recupel / Bebat / packaging', lineOf('epr'), 'inputmode="decimal"')}</div><div class="row">${field('inboundLogistics', 'Delivery to your shop / FBA', lineOf('inboundLogistics'), 'inputmode="decimal"')}${field('importVat', 'Import VAT %', iv.ratePct ?? '', 'inputmode="decimal"')}</div><label><input type="checkbox" name="vatRecoverable" ${iv.recoverable === false ? '' : 'checked'} style="width:auto;min-height:0"> import VAT is recoverable</label><p class="small muted">Amounts are treated as estimates (not quotes).</p><button class="btn" style="margin-top:8px">Save costs</button></form></div>
  <div class="card"><h2>SELLING SIDE</h2><form data-form="sale"><div class="row">${field('price', 'My selling price (incl. VAT)', sl.sellingPriceGross ?? '', 'inputmode="decimal"')}${field('vat', 'VAT %', sl.vatRatePct ?? 21, 'inputmode="decimal"')}</div>${field('target', 'Target margin (% of price without VAT)', sl.targetContributionPct ?? '', 'inputmode="decimal"')}<button class="btn" style="margin-top:8px">Save</button></form>
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
function render() {
  ensureCase(); const c = cur();
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-act="tab" data-key="${k}" aria-current="${S.tab === k}">${l}</button>`).join('');
  try { S.A = assess(c, { now: new Date() }); S.error = null; } catch (e) { S.error = e; console.error(e); }
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
  if (name === 'sale') return commit({ type: 'SALE', sale: { sellingPriceGross: num(d.price), vatRatePct: num(d.vat), targetContributionPct: num(d.target) } });
  if (name === 'amazon-sale') { const lines = []; if (num(d.referral)) lines.push({ key: 'referral', kind: 'pct_of_gross', value: num(d.referral), status: 'KNOWN', source: 'Seller Central (entered)' }); else lines.push({ key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }); if (num(d.fulfilment)) lines.push({ key: 'fulfilment', kind: 'per_unit', value: num(d.fulfilment), status: 'KNOWN', source: 'Seller Central (entered)' }); else lines.push({ key: 'fulfilment', kind: 'per_unit', status: 'UNKNOWN' }); return commit({ type: 'SALE_AMAZON', sale: { sellingPriceGross: num(d.aprice), vatRatePct: num(d.avat), lines } }); }
  if (name === 'customs') return commit({ type: 'CUSTOMS', customs: { chosenCode: d.code || null, duty: num(d.rate) ? { ratePct: num(d.rate), kind: 'USER_ENTERED', source: 'entered by the owner' } : cur().customs?.duty } });
  if (name === 'obs') return commit({ type: 'AMAZON_OBS', observation: { marketplace: d.marketplace, price: num(d.price), reviews: num(d.reviews), title: d.title, url: d.url, source: 'MANUAL' } });
  if (name === 'whatif') { if (num(d.unitPrice) === null) return; try { S.whatIf = whatIf(cur(), { unitPrice: num(d.unitPrice), currency: quoteOf(cur()).currency ?? 'USD' }, { now: new Date() }); } catch (e) { S.flash = `Could not compute: ${e.message}`; } return render(); }
  if (name === 'doc') return addDocument(f, d);
}

async function addDocument(form, d) {
  const file = form.elements.file.files[0]; let text = d.text ?? ''; let pages = null; let note = '';
  S.busy = 'doc'; render();
  try {
    if (file && !text) {
      if (/\.txt$/i.test(file.name) || file.type.startsWith('text/')) text = await file.text();
      else if (S.token) { const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); const r = await api('/api/documents/extract', { method: 'POST', body: JSON.stringify({ fileName: file.name, mime: file.type, dataBase64: btoa(bin) }) }); text = r.text ?? ''; pages = r.pages ?? null; note = r.note ?? ''; }
      else note = 'Reading a PDF needs the server (add the access token, menu). Paste the text instead.';
    }
    S.flash = note;
    commit({ type: 'DOCUMENT', fileName: file?.name ?? 'pasted text', text, pages, claimedType: d.claimed || null, summary: 'document added' });
  } catch (e) { S.flash = `The document could not be read (${e.message}). Paste its text instead.`; }
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
  if (act === 'useprice') return commit({ type: 'SALE', sale: { sellingPriceGross: String(Number(key) / 100), vatRatePct: cur().sale?.vatRatePct ?? '21' } });
  if (act === 'show-sup') return showSupplier();
  if (act === 'copy-sup') { try { await navigator.clipboard.writeText(supplierText(S.A)); S.flash = 'Copied.'; } catch { S.flash = 'Copy is not available here: use "Show to supplier".'; } return render(); }
  if (act === 'close-overlay') { $('#overlay').hidden = true; $('#overlay').className = ''; return; }
  if (act === 'newcase') { const c = newCase({}); S.cases[c.id] = c; S.currentId = c.id; S.tab = 'case'; persist(); closeOverlay(); return render(); }
  if (act === 'opencase') { S.currentId = key; S.tab = 'decision'; persist(); closeOverlay(); return render(); }
  if (act === 'server-copy') { if (S.conflict) { S.cases[S.conflict.id] = S.conflict; S.conflict = null; S.flash = ''; persist(); closeOverlay(); render(); } return; }
  if (act === 'export') { const blob = new Blob([JSON.stringify(cur(), null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nordla-case-${cur().id}.json`; a.click(); return; }
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
    const bmp = await createImageBitmap(file); const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/jpeg', 0.7); const n = c.identity.photos.length; if (!ls.set(`nordla.sourcing.photo.${c.id}.${n}`, url)) S.flash = 'Photo too large for local storage: it was not saved.';
    commit({ type: 'PHOTO', ref: `photo-${n}`, note: file.name });
    if (S.token && S.online) { try { const r = await api('/api/ai/describe', { method: 'POST', body: JSON.stringify({ imageBase64: url.split(',')[1], imageMime: 'image/jpeg' }) }); if (r.status === 'DISABLED') { S.flash = r.note; render(); } } catch { /* optional */ } }
    else { S.flash = 'Photo saved. No AI reader is available offline: type what it is, then pick the category.'; render(); }
  } catch { S.flash = 'This photo could not be read.'; render(); }
}

document.addEventListener('click', onClick); document.addEventListener('submit', onSubmit); document.addEventListener('change', onPhoto);
$('#btn-cases').addEventListener('click', openMenu);
window.addEventListener('online', ping); window.addEventListener('offline', () => { S.online = false; paintHeader(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render(); ping();
