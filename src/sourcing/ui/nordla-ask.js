// Parle à Nordla - the screen (text). Structured answers, the conversation kept on this phone, blockers shown as what they are, the recommendation justified.
// Everything the person reads was computed by the SERVER (src/core-pilot): this file only presents it. Nothing here orders, pays or decides; the screen says so.
// Pure rendering (renderAsk / renderTurn: data in, HTML out, every value escaped) + a small controller. No network call of its own: it uses the panel's `post`.
// own escaper (the same five characters as dom.js): dom.js imports a browser-absolute path, so importing it would make this file untestable in Node
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MAX_TURNS = 10;
const CASE_CHIPS = [['Qu’est-ce qui manque ?', 'Ce qui manque'], ['Quels sont les risques ?', 'Risques'], ['Quelle est la marge estimée ?', 'Marge'], ['Est-ce que je peux commander ce produit ?', 'Puis-je commander ?'], ['Quelle est la prochaine étape ?', 'Prochaine étape'], ['Quelles questions dois-je poser au fournisseur ?', 'Questions à poser'], ['Pourquoi cette recommandation ?', 'Pourquoi cette recommandation ?']];
// Only questions the server already answers (the same ones the Core home offers): no figure is promised that the data cannot give.
const NO_CASE_CHIPS = [['ma trésorerie', 'Ma trésorerie ?'], ['quelles factures fournisseurs dois-je payer et quelles sont les échéances ?', 'Quelles factures dois-je payer ?'], ['quel est mon chiffre d’affaires des 30 derniers jours ?', 'Chiffre d’affaires des 30 derniers jours']];
const SECTIONS = [['known', null], ['unknown', 'Ce que nous ne savons pas'], ['risks', 'Risques'], ['consequences', 'Pourquoi c’est important'], ['next', 'Prochaine vérification']];
const SOURCE_KIND = { sourcing_case: 'dossier', core_journal: 'journal', rulebook: 'règles', finance: 'Finance', analytics: 'Analyses' };
const VERDICT_UI = { GO: 'GO', CONDITIONAL_GO: 'Sous conditions', CONDITIONAL_GO_BLOCKED: 'Sous conditions, commande bloquée', NO_GO: 'NO-GO', INSUFFICIENT_INFORMATION: 'Informations insuffisantes' };
const when = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v ?? 'inconnue') : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const STATUS_NOTE = { ASK: 'Précision demandée', NOT_UNDERSTOOD: 'Pas compris', MODULE_NOT_CONNECTED: 'Module non relié', ACTION_REFUSED: 'Action refusée', CORE_NOT_CONFIGURED: 'Core non configuré' };
// Small pictograms of the conversation page: bars for the suggestion cards, a bubble in the composer, arrows.
const BARS = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M5 19v-6M12 19V8M19 19V4" fill="none" stroke="#2E8B7A" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" fill="none" stroke="#0F1B2D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_W = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BUBBLE_SMALL = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="#5B6678" stroke-width="1.8" stroke-linejoin="round"/></svg>';
// Speech-bubble mark of the empty state (navy outline, gold rays), drawn inline: no image to load.
const BUBBLE = '<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false"><path d="M12 10h40a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H24l-10 8v-8h-2a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6z" fill="none" stroke="#0F1B2D" stroke-width="2.6" stroke-linejoin="round"/><circle cx="20" cy="26" r="2.4" fill="#0F1B2D"/><circle cx="32" cy="26" r="2.4" fill="#0F1B2D"/><circle cx="44" cy="26" r="2.4" fill="#0F1B2D"/><path d="M50 3l2 4M58 7l-3.5 2.5M60 16h-4" fill="none" stroke="#B8862B" stroke-width="2.4" stroke-linecap="round"/></svg>';

const CSS = `.nxa{margin:0 0 12px}.nxa-chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.nxa-chip{font:inherit;font-size:14px;min-height:44px;padding:8px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.nxa-chip:focus-visible,.nxa button:focus-visible,.nxa input:focus-visible{outline:3px solid #4b8df0;outline-offset:2px}.nxa-form{display:flex;gap:8px;align-items:flex-end}.nxa-form label{flex:1;min-width:0}.nxa-form input{width:100%;box-sizing:border-box;min-height:44px;font:inherit}
.nxa-case{font-size:13px;color:var(--muted);margin:2px 0 6px}.nxa-turn{overflow-wrap:anywhere;border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 10px;background:var(--card)}.nxa-q{font-size:13px;color:var(--muted);margin:0 0 6px}
.nxa-block{border-left:4px solid var(--red);background:var(--red-bg);padding:8px 10px;margin:0 0 8px;border-radius:0 8px 8px 0;font-size:14px}.nxa-block b{display:block}.nxa-head{font-weight:700;margin:0 0 6px}
.nxa-sec h4{margin:10px 0 2px;font-size:13px;letter-spacing:.02em;color:var(--muted);text-transform:uppercase}.nxa-sec ul{margin:0;padding-left:18px}.nxa-sec li{font-size:14px;line-height:20px;margin:2px 0}
.nxa-next{border-left:4px solid var(--accent);padding-left:10px;margin-top:10px}.nxa-src{font-size:13px;color:var(--muted);margin:8px 0 0}.nxa details{margin-top:6px;font-size:13px}.nxa-tools{display:flex;justify-content:space-between;align-items:center;margin:4px 0}`;
// Conversation page (Parle à Nordla as its own screen): white card, navy text, gold read-only mark, teal activity, one clear composer.
const CSS_PAGE = `.nxa{max-width:100%;overflow-wrap:anywhere}
.nxa-page{display:flex;flex-direction:column;min-height:calc(100vh - 32px);max-width:880px;margin:0 auto;box-sizing:border-box}
.nxa-bar{display:flex;justify-content:flex-start;margin:0 0 8px}
.nxa-page-body{display:flex;flex-direction:column;flex:1;min-height:0;color:#0F1B2D}
.nxa-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:0}
.nxa-title{margin:0;font-size:26px;line-height:32px;letter-spacing:-.01em;color:#0F1B2D}
.nxa-lead{margin:4px 0 0;font-size:14px;line-height:20px;color:#5B6678}
.nxa-ro{display:inline-flex;align-items:center;font-size:12px;font-weight:600;color:#7A5A12;background:#FBF4E4;border:1px solid #E8D7A8;border-radius:999px;padding:4px 10px;white-space:nowrap}
.nxa-page .nxa-case{font-size:13px;color:#5B6678;margin:10px 0 0}
.nxa-stage{flex:1;display:flex;flex-direction:column;gap:10px;margin-top:12px;background:#fff;border:1px solid #E3E7EE;border-radius:16px;padding:16px;min-height:260px;box-sizing:border-box}
.nxa-feed{flex:1;display:flex;flex-direction:column;gap:12px;min-width:0}
.nxa-empty{margin:auto;text-align:center;padding:24px 8px}
.nxa-empty-title{margin:10px 0 4px;font-size:20px;line-height:26px;color:#0F1B2D}
.nxa-empty-sub{margin:0;font-size:14px;line-height:20px;color:#5B6678}
.nxa-mark{display:inline-flex}
.nxa-page .nxa-turn{background:#F7F9FC;border-color:#E3E7EE;color:#0F1B2D;margin:0}
.nxa-page .nxa-q{color:#5B6678}
.nxa-page .nxa-sec h4{color:#5B6678}
.nxa-page .nxa-next{border-left-color:#2E8B7A}
.nxa-loading{display:flex;align-items:center;gap:10px;font-size:14px;color:#5B6678}
.nxa-dots{display:inline-flex;gap:4px}
.nxa-dots i{width:7px;height:7px;border-radius:50%;background:#2E8B7A;animation:nxa-bounce 1.1s infinite ease-in-out}
.nxa-dots i:nth-child(2){animation-delay:.15s}.nxa-dots i:nth-child(3){animation-delay:.3s}
@keyframes nxa-bounce{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.nxa-dots i{animation:none;opacity:.7}}
.nxa-dock{position:sticky;bottom:0;background:#F4F6F9;padding:10px 0 4px;margin-top:12px;display:flex;flex-direction:column;gap:8px}
.nxa-dock .nxa-chips{margin:0}
.nxa-dock .nxa-chip{background:#fff;color:#0F1B2D;border-color:#D5DCE6;min-height:40px;font-size:13px}
.nxa-dock .nxa-form{align-items:stretch}
.nxa-dock .nxa-form input{background:transparent;color:#0F1B2D;border:0;padding:10px 0;min-height:0}
.nxa-field{flex:1;min-width:0;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #C9D1DD;border-radius:12px;padding:0 14px}
.nxa-field:focus-within{border-color:#0F1B2D}
.nxa-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:auto;padding-top:8px}
.nxa-card{display:flex;align-items:center;gap:12px;min-height:64px;padding:14px;border:1px solid #DDE3EC;border-radius:14px;background:#fff;color:#0F1B2D;font:inherit;font-size:15px;font-weight:600;text-align:left;cursor:pointer}
.nxa-card:hover{border-color:#B8C3D2}
.nxa-card:disabled{opacity:.55;cursor:default}
.nxa-card-ico,.nxa-card-arr{display:inline-flex;flex:0 0 auto}
.nxa-card-txt{flex:1;min-width:0;line-height:20px}
.nxa-send{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:0 20px;border:0;border-radius:12px;background:#0F1B2D;color:#fff;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.nxa-send:disabled{opacity:.55;cursor:default}
.nxa-dock .nxa-form{display:flex;flex-direction:row;align-items:center;gap:8px;background:#fff;border:1px solid #CBD3DF;border-radius:14px;padding:6px 6px 6px 14px}.nxa-dock .nxa-field{flex:1;min-width:0;border:0;padding:0;background:transparent}.nxa-dock .nxa-send{width:auto;min-height:44px;border-radius:10px;padding:0 22px;white-space:nowrap}@media (max-width:480px){.nxa-cards{grid-template-columns:1fr}.nxa-stage{padding:12px;border-radius:14px}.nxa-title{font-size:22px;line-height:28px}.nxa-form{flex-direction:column}.nxa-send{width:100%}.nxa-page{min-height:calc(100vh - 32px)}}`;
function ensureStyle() { if (typeof document === 'undefined' || document.getElementById('nxa-style')) return; const el = document.createElement('style'); el.id = 'nxa-style'; el.textContent = CSS + CSS_PAGE; document.head.appendChild(el); }

const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
const sourceText = (s) => `${SOURCE_KIND[s.kind] ?? s.kind} ${s.ref}`;

/** One question and its answer. `t` = { text, ...serverAnswer }. */
export function renderTurn(t, { newest = false } = {}) {
  const r = t; const lines = String(r.answer ?? '').split('\n'); const structured = !!r.sections;
  const banner = r.status === 'ACTION_REFUSED' ? '<div class="nxa-block" role="alert"><b>Action refusée</b>Nordla répond aux questions ; il ne commande, ne paie ni ne modifie rien.</div>'
    : (structured && r.orderBlocked ? `<div class="nxa-block" role="alert"><b>Commande impossible à ce stade</b>${r.blockers?.length ? esc(r.blockers.map((b) => b.label).join(' · ')) : 'le dossier n’autorise pas d’engager de l’argent'}. Nordla ne commande et ne paie rien.</div>` : '');
  const status = STATUS_NOTE[r.status] && r.status !== 'ACTION_REFUSED' ? `<p class="small muted">${esc(STATUS_NOTE[r.status])}</p>` : '';
  let body;
  if (structured) {
    const sec = SECTIONS.map(([k, title]) => {
      const items = r.sections[k]; if (!items?.length) return '';
      const heading = k === 'known' ? (r.knownTitle ?? 'Ce que nous savons') : title;
      return `<div class="nxa-sec${k === 'next' ? ' nxa-next' : ''}"><h4>${esc(heading)}</h4>${list(items)}</div>`;
    }).join('');
    body = `<p class="nxa-head">${esc(lines[0])}</p>${sec}`;
  } else body = lines.map((l) => `<p class="small">${esc(l)}</p>`).join('');
  const sources = r.sources?.length ? `<p class="nxa-src">Sources : ${esc(r.sources.map(sourceText).join(', '))}</p>` : '';
  const limits = r.limits?.length ? `<details><summary>Limites et fraîcheur des données</summary>${list(r.limits)}</details>` : '';
  const caseLine = structured && r.case ? `<p class="nxa-case">Dossier « ${esc(r.case.productName)} » — mis à jour le ${esc(when(r.case.version))}${r.verdict ? ` — verdict : <b>${esc(VERDICT_UI[r.verdict] ?? r.verdict)}</b>` : ''}</p>` : '';
  return `<div class="nxa-turn" ${newest ? 'data-core-answer' : 'data-core-answer-old'}><p class="nxa-q">« ${esc(r.text)} »</p>${banner}${status}${caseLine}${body}${sources}${limits}</div>`;
}

/** The whole block, as the conversation page: title, read-only mark, the answers, a loading / error / empty state, and the composer always in reach. `model` = { turns[newest first], notice, draft, busy, active:{id,name}|null }. */
export function renderAsk({ turns = [], notice = '', draft = '', busy = false, active = null, error = '', caseLine = true } = {}) {
  const where = active ? `Dossier ouvert : ${esc(active.name || active.id)}` : 'Aucun dossier ouvert : les questions sur un produit demandent d’en ouvrir un.';
  const suggestions = active ? CASE_CHIPS : NO_CASE_CHIPS;
  const cards = suggestions.map(([text, label]) => `<button type="button" class="nxa-card" data-act="core-ask-chip" data-text="${esc(text)}" data-case="${esc(active?.id ?? '')}" ${busy ? 'disabled' : ''}><span class="nxa-card-ico">${BARS}</span><span class="nxa-card-txt">${esc(label)}</span><span class="nxa-card-arr">${ARROW}</span></button>`).join('');
  const pills = suggestions.map(([text, label]) => `<button type="button" class="nxa-chip" data-act="core-ask-chip" data-text="${esc(text)}" data-case="${esc(active?.id ?? '')}" ${busy ? 'disabled' : ''}>${esc(label)}</button>`).join('');
  const empty = !turns.length && !busy && !error ? `<div class="nxa-empty"><div class="nxa-mark">${BUBBLE}</div><h4 class="nxa-empty-title">Que souhaitez-vous savoir ?</h4><p class="nxa-empty-sub">Nordla répond à partir des données accessibles à votre entreprise.</p></div>` : '';
  const loading = busy ? '<div class="nxa-loading" role="status"><span class="nxa-dots" aria-hidden="true"><i></i><i></i><i></i></span>Nordla prépare la réponse à partir des données…</div>' : '';
  const alert = error ? `<p class="nxa-block" role="alert"><b>La question n’a pas pu partir</b>${esc(error)} Votre question est conservée : réessayez.</p>` : '';
  const note = notice ? `<p class="small muted" role="status">${esc(notice)}</p>` : '';
  const tools = turns.length ? `<div class="nxa-tools"><span class="small muted">${turns.length} question${turns.length > 1 ? 's' : ''} dans cette conversation</span><button type="button" class="btn sec" data-act="core-ask-reset">Nouvelle conversation</button></div>` : '';
  return `<div class="nxa nxa-page-body"><div class="nxa-head"><div><h3 class="nxa-title">Parle à Nordla</h3><p class="nxa-lead">Nordla répond à partir des données accessibles à votre entreprise, en lecture seule.</p></div><span class="nxa-ro">Lecture seule</span></div>
    ${caseLine ? `<p class="nxa-case">${where}</p>` : ''}
    <div class="nxa-stage"><div class="nxa-feed" aria-live="polite">${empty}${turns.map((t, i) => renderTurn(t, { newest: i === 0 })).join('')}${loading}</div>${alert}${note}${tools}${turns.length ? '' : `<div class="nxa-cards" role="group" aria-label="Questions suggérées">${cards}</div>`}</div>
    <div class="nxa-dock">${turns.length ? `<div class="nxa-chips" role="group" aria-label="Questions fréquentes">${pills}</div>` : ''}
      <div class="nxa-form"><div class="nxa-field">${BUBBLE_SMALL}<input id="core-ask-text" aria-label="Votre question" value="${esc(draft)}" maxlength="1000" autocomplete="off" placeholder="Posez votre question"></div><button type="button" class="nxa-send" data-act="core-ask" data-case="${esc(active?.id ?? '')}" ${busy ? 'disabled' : ''}>Demander ${ARROW_W}</button></div></div></div>`;
}

/** Offline (or signed out): the server is unreachable, but the answers already on the screen are still worth reading chez le fournisseur. Read-only, with the reason. */
export function renderHistory(turns = [], { online = false } = {}) {
  if (!turns.length) return '';
  return `<div class="nxa"><h3>Parle à Nordla</h3><p class="nxa-case">${online ? 'Reconnectez-vous pour poser une nouvelle question.' : 'Hors ligne : vos réponses précédentes restent lisibles ; une nouvelle question demande le serveur.'}</p>${turns.map((t, i) => renderTurn(t, { newest: i === 0 })).join('')}</div>`;
}

/** Controller: keeps the conversation on the phone (turns + the server's state) and asks through the panel's `post`. */
export function createAskUi({ st, post }) {
  ensureStyle();
  const nx = (st.nx ??= { turns: [], conversation: null, notice: '', draft: '' });
  function ask(text, caseId) {
    const q = String(text ?? '').trim(); if (!q) return true;
    const body = { text: q, caseId: caseId || null, conversation: nx.conversation }; // null = start; the server rebuilds whatever comes back, it never trusts it
    nx.pending = true; // set until an answer arrives: if the call fails, render() shows the error in THIS block
    post('/api/core/ask', body, (r) => {
      nx.pending = false; nx.draft = ''; // cleared only once the answer is here: after a network error the person's question is still in the box
      nx.turns = [{ text: q, ...r }, ...nx.turns].slice(0, MAX_TURNS); nx.notice = r.notice ?? '';
      nx.conversation = r.conversation ?? null; // a server without conversation support simply returns none: every question then stands alone
    });
    return true;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('input', (ev) => { if (ev.target?.id === 'core-ask-text') nx.draft = ev.target.value; });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target?.id === 'core-ask-text') { ev.preventDefault(); document.querySelector('[data-act="core-ask"]')?.click(); } });
  }
  return {
    /** @returns true when the click was an ask action (the panel stops there) */
    handle(act, t, caseId) {
      if (act === 'core-ask') return ask(document.getElementById('core-ask-text')?.value, caseId);
      if (act === 'core-ask-chip') return ask(t.dataset.text, caseId);
      if (act === 'core-ask-reset') { nx.turns = []; nx.conversation = null; nx.notice = ''; nx.draft = ''; return 'reset'; }
      return false;
    },
    history(online) { return renderHistory(nx.turns, { online }); },
    render(active, busy, error, { caseLine = true } = {}) { return renderAsk({ caseLine, turns: nx.turns, notice: nx.notice, draft: nx.draft, busy, error: nx.pending && !busy ? error : '', active: active ? { id: active.id, name: active.name ?? active.workingName ?? '' } : null }); },
  };
}
