// FIELD workflow shell (early, honest): Discover -> Talk -> Capture -> Complete -> Analyze -> Decide -> Negotiate, built over the EXISTING engines and screens (they stay one tap away
// under the other tabs). Anything not built yet says NOT AVAILABLE YET. Wording is for a person holding a phone in front of a supplier: no event names, no JSON, no provider names.
// RENDERING INVARIANT: this screen is rebuilt from the case + a few UI fields on every render; nothing important lives only in the DOM. The half-typed capture text is kept in S.captureDraft
// (and in local storage by app.js), so a status update, a sync or a step change can never wipe it.
import { esc, chip, list, VERDICT_TEXT } from '../dom.js';
import { S } from '../state.js';
import { fieldProgress } from '/core/field-progress.js';
import { summarizeConversation, userQuestionView } from '/core/conversation.js';
import { describeCandidate, describeConflict } from '/core/candidate-view.js';
import { negotiation } from './ask.js';

const STATUS_TEXT = { DONE: 'done', IN_PROGRESS: 'in progress', TODO: 'to do', NOT_AVAILABLE: 'not yet' };
const words = (x) => String(x ?? '').replace(/_/g, ' ');
const btn = (label, act, key, extra = '', cls = 'btn sec') => `<button type="button" class="${cls}" data-act="${act}" ${key !== undefined ? `data-key="${esc(key)}"` : ''} ${extra} style="min-height:40px;padding:6px 12px">${label}</button>`;

function stepper(p, current) {
  return `<nav class="fsteps" aria-label="Workflow steps">${p.steps.map((s, i) => `<button type="button" class="fstep s-${s.status}" data-act="fstep" data-key="${s.id}" aria-current="${s.id === current}"><span class="n">${i + 1}</span><span class="l">${esc(s.label)}</span><span class="t">${esc(STATUS_TEXT[s.status])}</span></button>`).join('')}</nav>`;
}

function discover(A, c, p) {
  const id = A.identity; const known = [['Name', c.identity.workingName], ['Model', id.model], ['Brand', id.brand], ['Manufacturer', id.manufacturer], ['Supplier', c.supplier?.name]].filter(([, v]) => v);
  return `<div class="card"><h2>DISCOVER - what is it?</h2><p class="small muted">Start with the product itself: a photo, the label, or just its name. Nothing is guessed: Nordla only keeps what you or the supplier say.</p>
  ${known.length ? `<table>${known.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n"><b>${esc(v)}</b></td></tr>`).join('')}</table>` : '<p class="muted">Nothing entered yet.</p>'}
  <p class="small">${esc(p.steps[0].summary)}</p>
  <div class="row">${btn('Quick: name, price, quantity', 'tab', 'quick', '', 'btn')}${btn('Case: photo and details', 'tab', 'case')}</div></div>`;
}

function talk(A, c, p) {
  const open = A.questions.filter((q) => q.priority === 'P1').slice(0, 5); const uqs = c.userQuestions ?? [];
  return `<div class="card"><h2>TALK - ask the supplier</h2><p class="small muted">${esc(p.steps[1].summary)}. These come from what is still missing.</p>
  ${open.map((q) => `<div class="q-item"><span class="pri ${q.priority}">${q.priority}</span><b>${esc(q.topic)}</b><div>${esc(q.en)}</div><div class="zh" lang="zh-Hans">${esc(q.zh)}</div></div>`).join('') || '<p class="muted">Nothing important left to ask.</p>'}
  <div class="row" style="margin-top:8px">${btn('Show to supplier (EN + 中文)', 'show-sup', undefined, '', 'btn')}${btn('All questions', 'tab', 'ask')}</div></div>
  <div class="card"><h2>ASK MY OWN QUESTION</h2><p class="small muted">Write it in your own words. Chinese is shown only when it really exists: Nordla has no translator yet, so for your own questions you show the English (or use your translation app).</p>
  <form data-form="free-question"><label>Your question<textarea name="text" placeholder="How many colours do you have for this model, and can I mix colours in the 100-piece MOQ?"></textarea></label>
  <label>Language you wrote it in<select name="lang"><option value="en">English</option><option value="fr">Francais</option><option value="nl">Nederlands</option><option value="zh">中文</option></select></label><button class="btn" style="margin-top:8px">Save question</button></form>
  ${uqs.map((q) => { const v = userQuestionView(q); return `<div class="q-item"><span class="pri P2">${esc(q.state)}</span><div lang="${esc(q.lang)}">${esc(v.original)}</div>${v.zh ? `<div class="zh" lang="zh-Hans">${esc(v.zh)}</div>` : `<div class="small muted">${esc(v.zhNote)}</div>`}
    <div class="row" style="margin-top:6px">${btn('Show it', 'show-uq', q.id)}${q.state !== 'ASKED' ? btn('Mark as asked', 'uq-state', q.id, 'data-val="&quot;ASKED&quot;"') : ''}${q.state !== 'ANSWERED' ? btn('Answered', 'uq-state', q.id, 'data-val="&quot;ANSWERED&quot;"') : ''}</div></div>`; }).join('')}</div>`;
}

function candidateRow(cd) {
  const v = describeCandidate(cd); const open = S.correcting === cd.id;
  return `<div class="cand ${v.kind === 'CLAIM' ? 'claim' : ''}"><div><b>${esc(v.label)}</b>: <span class="val">${esc(v.valueText)}</span></div>
    <div class="small muted" lang="${esc(v.lang)}">from: &ldquo;${esc(v.from)}&rdquo;</div>${v.note ? `<div class="small note">${esc(v.note)}</div>` : ''}${v.warnings.map((w) => `<div class="small warnline">${esc(w)}</div>`).join('')}
    <div class="row" style="margin-top:6px">${v.canConfirm ? btn('Confirm', 'cand-confirm', cd.id, '', 'btn') : ''}${v.canCorrect ? btn(open ? 'Cancel' : 'Correct', 'cand-correct-open', cd.id) : ''}${btn('Reject', 'cand-reject', cd.id)}</div>
    ${open ? `<form data-form="cand-correct" data-id="${esc(cd.id)}"><label>The right value<input name="value" value="${esc(v.suggestion ?? (cd.value !== null && typeof cd.value !== 'object' ? cd.value : ''))}" autocomplete="off"></label><button class="btn" style="margin-top:6px">Save correction</button></form>` : ''}
    ${!v.canConfirm && !v.canCorrect ? '<div class="small muted">Reject this one and type the value in the Money tab.</div>' : ''}</div>`;
}

function summaryCard(c, A, conv) {
  const s = summarizeConversation(c, conv.id, A);
  return `<div class="card"><h2>SUPPLIER CONVERSATION - SUMMARY</h2><p><b>${s.factsFound}</b> found - <b>${s.confirmed}</b> confirmed - <b>${s.stillToReview}</b> still to review - <b>${s.missingImportant}</b> important missing - <b>${s.conflicts}</b> to clarify</p>
  <h3>What we learned (confirmed by you)</h3>${list(s.learned.map((l) => esc(l.text)))}
  <h3>Still missing</h3>${list(s.missing.map((m) => esc(m.en)))}${s.documentClaimsNotReceived.length ? `<p class="small">Documents the supplier talks about but that were not received: <b>${esc(s.documentClaimsNotReceived.map((d) => d.claim === 'UN383' ? 'UN 38.3' : d.claim).join(', '))}</b></p>` : ''}
  <h3>Contradictions and risks</h3>${list(s.contradictions.map((x) => esc(x.text)))}
  <p class="small muted">Only what you confirmed was added to the case. The supplier's original words are kept unchanged.</p></div>`;
}

function capture(A, c) {
  const convs = c.conversations ?? []; const open = convs.find((x) => x.status === 'OPEN'); const last = convs.at(-1);
  const pending = (c.candidates ?? []).filter((x) => x.state === 'PROPOSED'); const conflicts = (c.conflicts ?? []).filter((x) => x.state === 'OPEN');
  const draft = (S.captureDraft ??= {})[c.id] ?? '';
  const form = open ? `<form data-form="capture"><label>What was said (type or paste; English or 中文)<textarea name="text" placeholder="For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit and balance before shipment." data-draft="capture">${esc(draft)}</textarea></label>
    <div class="row"><label>Who said it<select name="speaker"><option value="supplier">The supplier</option><option value="me">My own note</option></select></label><label>Language<select name="lang"><option value="auto">Automatic</option><option value="en">English</option><option value="zh">中文</option></select></label></div>
    <button class="btn" style="margin-top:8px">Add and find the facts</button></form><p class="small muted">Nordla reads the text on this phone (no internet, nothing is sent anywhere) and PROPOSES facts. Nothing changes in the case until you confirm.</p>`
    : `<p class="muted">${last ? 'The last conversation is finished.' : 'No conversation yet.'}</p><div>${btn('Start a conversation', 'conv-start', undefined, '', 'btn')}</div>`;
  const items = (open ?? last)?.items ?? [];
  return `<div class="card"><h2>CAPTURE - what the supplier says</h2>${form}</div>
  ${items.length ? `<div class="card"><h2>THE ORIGINAL WORDS (kept unchanged)</h2>${items.map((it) => `<div class="orig-item"><span class="small muted">${it.speaker === 'supplier' ? 'Supplier' : 'My note'}</span><div class="orig" lang="${esc(it.lang === 'zh' ? 'zh-Hans' : it.lang)}">${esc(it.original)}</div></div>`).join('')}</div>` : ''}
  <div class="card"><h2>TO REVIEW (${pending.length})</h2>${pending.length ? pending.map(candidateRow).join('') : '<p class="muted">Nothing waiting for your decision.</p>'}</div>
  ${conflicts.length ? `<div class="card"><h2>NEEDS CLARIFICATION (${conflicts.length})</h2>${conflicts.map((x) => { const v = describeConflict(x); return `<div class="cand"><b>${esc(v.title)}</b><p class="small">${esc(v.help)}</p>${v.question ? `<p class="small">Ask: <i>${esc(v.question)}</i></p><p class="small muted">${esc(v.zhNote ?? '')}</p>` : ''}<div class="row">${v.choices.map((ch) => btn(esc(ch.label), 'conflict-resolve', x.id, `data-val="&quot;${ch.choice}&quot;"`)).join('')}</div></div>`; }).join('')}</div>` : ''}
  ${open ? `<div class="card"><h2>FINISHED TALKING?</h2><p class="small muted">Shows what you learned, what is still missing and what contradicts. You keep reviewing afterwards.</p>${btn('Finish the conversation', 'conv-finish', open.id, '', 'btn')}</div>` : ''}
  ${last && last.status !== 'OPEN' ? summaryCard(c, A, last) : ''}`;
}

function complete(p) {
  const s = p.steps[3];
  return `<div class="card"><h2>COMPLETE - what is still missing</h2><p class="small muted">${esc(s.summary)}</p>${list(s.items.map((i) => `<span class="chip">${esc({ CONFLICT: 'to clarify', DOCUMENT_MODEL: 'document problem', DOCUMENT_CLAIM: 'not received', QUESTION: 'to ask' }[i.kind])}</span> ${esc(i.text)}`))}
  <div class="row" style="margin-top:8px">${btn('Documents', 'tab', 'docs')}${btn('Case details', 'tab', 'case')}${btn('Review facts', 'fstep', 'capture')}</div></div>`;
}

function analyze(A, p) {
  const L = A.landed; const E = A.economics;
  return `<div class="card"><h2>ANALYZE - what Nordla can work out now</h2><p class="small muted">${esc(p.steps[4].summary)}</p><table>
    <tr><td>Product identified</td><td class="n"><b>${esc(A.identity.confidence.level)}</b></td></tr>
    <tr><td>EU rules that apply</td><td class="n"><b>${A.rules.summary.applies}</b> <span class="muted small">(${A.rules.summary.unresolved} unresolved)</span></td></tr>
    <tr><td>Safety Gate</td><td class="n"><b>${esc(words(A.safety.status))}</b> <span class="muted small">${esc(words(A.dataMode))}</span></td></tr>
    <tr><td>Landed cost per unit</td><td class="n"><b>${esc(L.status === 'INFORMATION_INSUFFICIENT' ? 'UNKNOWN' : `${(L.totals.landedPerUnitEurMinor / 100).toFixed(2)} EUR`)}</b></td></tr>
    <tr><td>Profit per unit</td><td class="n"><b>${esc(E.contributionMinor != null ? `${(E.contributionMinor / 100).toFixed(2)} EUR` : 'UNKNOWN')}</b></td></tr></table>
  <p class="small muted">Unknown stays unknown: nothing is assumed to make a number appear.</p><div class="row">${btn('Money details', 'tab', 'money')}${btn('Rules details', 'tab', 'compliance')}</div></div>`;
}

function decide(A, c, p) {
  const d = A.decision; const [en] = VERDICT_TEXT[d.verdict];
  return `<section class="verdict v-${d.verdict}"><p class="q">COMPLIANCE AND ECONOMICS VERDICT</p><div class="v">${esc(words(d.verdict))}</div><p class="a">${esc(en)}</p><p style="margin:0">${esc(d.nextAction)}</p></section>
  ${d.hardBlockers.length ? `<div class="warn"><strong>What blocks an order</strong>${list(d.hardBlockers.map((b) => `<b>${esc(words(b.code))}</b> - ${esc(b.detail)}`))}</div>` : ''}
  <div class="card"><h2>BUSINESS DECISION</h2><p><b>NOT AVAILABLE YET</b></p><p class="small muted">${esc(p.businessDecision.reason)} The verdict above only covers safety, compliance and the margin on this one product.</p>
  <h3>What could change the verdict</h3>${list(d.conditions.slice(0, 5).map(esc))}${btn('Full verdict', 'tab', 'decision')}</div>`;
}

function negotiate(A, p) {
  const s = p.steps[6];
  return `<div class="card"><h2>NEGOTIATE</h2>${s.status === 'NOT_AVAILABLE' ? `<p><b>NOT AVAILABLE YET</b></p><p class="small muted">${esc(s.summary)}</p>` : negotiation(A)}<div class="row" style="margin-top:8px">${btn('Questions for the supplier', 'show-sup', undefined, '', 'btn')}${btn('Money details', 'tab', 'money')}</div></div>`;
}

export function fieldScreen(A, c) {
  const p = fieldProgress(c, A); const current = S.fstep && p.steps.some((s) => s.id === S.fstep) ? S.fstep : p.nextStep.step;
  const body = { discover: () => discover(A, c, p), talk: () => talk(A, c, p), capture: () => capture(A, c), complete: () => complete(p), analyze: () => analyze(A, p), decide: () => decide(A, c, p), negotiate: () => negotiate(A, p) }[current]();
  return `<div class="card next"><p class="q">NEXT BEST STEP</p><b>${esc(p.nextStep.text)}</b><div style="margin-top:6px">${p.nextStep.step !== current ? btn('Go to this step', 'fstep', p.nextStep.step, '', 'btn') : ''}</div></div>
  ${stepper(p, current)}${body}
  <details class="card"><summary>NOT AVAILABLE YET (${p.unavailable.length})</summary>${list(p.unavailable.map((u) => `<b>${esc(u.label)}</b> - ${esc(u.note)}`))}<p class="small muted">${chip('', 'NOT AVAILABLE YET', 'UNKNOWN')} These are shown so that nothing looks finished that is not.</p></details>`;
}
