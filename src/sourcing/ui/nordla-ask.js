// Parle à Nordla - the screen (text). Structured answers, the conversation kept on this phone, blockers shown as what they are, the recommendation justified.
// Everything the person reads was computed by the SERVER (src/core-pilot): this file only presents it. Nothing here orders, pays or decides; the screen says so.
// Pure rendering (renderAsk / renderTurn: data in, HTML out, every value escaped) + a small controller. No network call of its own: it uses the panel's `post`.
// own escaper (the same five characters as dom.js): dom.js imports a browser-absolute path, so importing it would make this file untestable in Node
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MAX_TURNS = 10;
const CASE_CHIPS = [['Qu’est-ce qui manque ?', 'Ce qui manque'], ['Quels sont les risques ?', 'Risques'], ['Quelle est la marge estimée ?', 'Marge'], ['Est-ce que je peux commander ce produit ?', 'Puis-je commander ?'], ['Quelle est la prochaine étape ?', 'Prochaine étape'], ['Quelles questions dois-je poser au fournisseur ?', 'Questions à poser'], ['Pourquoi cette recommandation ?', 'Pourquoi cette recommandation ?']];
const NO_CASE_CHIPS = [['Quelles décisions attendent mon approbation ?', 'Décisions à valider'], ['Quels modules sont connectés ?', 'Modules connectés']];
const SECTIONS = [['known', null], ['unknown', 'Ce que nous ne savons pas'], ['risks', 'Risques'], ['consequences', 'Pourquoi c’est important'], ['next', 'Prochaine vérification']];
const SOURCE_KIND = { sourcing_case: 'dossier', core_journal: 'journal', rulebook: 'règles', finance: 'Finance', analytics: 'Analyses' };
const VERDICT_UI = { GO: 'GO', CONDITIONAL_GO: 'Sous conditions', CONDITIONAL_GO_BLOCKED: 'Sous conditions, commande bloquée', NO_GO: 'NO-GO', INSUFFICIENT_INFORMATION: 'Informations insuffisantes' };
const when = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v ?? 'inconnue') : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const STATUS_NOTE = { ASK: 'Précision demandée', NOT_UNDERSTOOD: 'Pas compris', MODULE_NOT_CONNECTED: 'Module non relié', ACTION_REFUSED: 'Action refusée', CORE_NOT_CONFIGURED: 'Core non configuré' };

const CSS = `.nxa{margin:0 0 12px}.nxa-chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.nxa-chip{font:inherit;font-size:14px;min-height:44px;padding:8px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.nxa-chip:focus-visible,.nxa button:focus-visible,.nxa input:focus-visible{outline:3px solid #4b8df0;outline-offset:2px}.nxa-form{display:flex;gap:8px;align-items:flex-end}.nxa-form label{flex:1;min-width:0}.nxa-form input{width:100%;box-sizing:border-box;min-height:44px;font:inherit}
.nxa-case{font-size:13px;color:var(--muted);margin:2px 0 6px}.nxa-turn{border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 10px;background:var(--card)}.nxa-q{font-size:13px;color:var(--muted);margin:0 0 6px}
.nxa-block{border-left:4px solid var(--red);background:var(--red-bg);padding:8px 10px;margin:0 0 8px;border-radius:0 8px 8px 0;font-size:14px}.nxa-block b{display:block}.nxa-head{font-weight:700;margin:0 0 6px}
.nxa-sec h4{margin:10px 0 2px;font-size:13px;letter-spacing:.02em;color:var(--muted);text-transform:uppercase}.nxa-sec ul{margin:0;padding-left:18px}.nxa-sec li{font-size:14px;line-height:20px;margin:2px 0}
.nxa-next{border-left:4px solid var(--accent);padding-left:10px;margin-top:10px}.nxa-src{font-size:13px;color:var(--muted);margin:8px 0 0}.nxa details{margin-top:6px;font-size:13px}.nxa-tools{display:flex;justify-content:space-between;align-items:center;margin:4px 0}`;
function ensureStyle() { if (typeof document === 'undefined' || document.getElementById('nxa-style')) return; const el = document.createElement('style'); el.id = 'nxa-style'; el.textContent = CSS; document.head.appendChild(el); }

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

/** The whole block. `model` = { turns[newest first], notice, draft, busy, active:{id,name}|null }. */
export function renderAsk({ turns = [], notice = '', draft = '', busy = false, active = null } = {}) {
  const chips = (active ? CASE_CHIPS : NO_CASE_CHIPS).map(([text, label]) => `<button type="button" class="nxa-chip" data-act="core-ask-chip" data-text="${esc(text)}" data-case="${esc(active?.id ?? '')}" ${busy ? 'disabled' : ''}>${esc(label)}</button>`).join('');
  const where = active ? `Dossier ouvert : ${esc(active.name || active.id)}` : 'Aucun dossier ouvert : les questions sur un produit demandent d’en ouvrir un.';
  return `<div class="nxa"><h3>Parle à Nordla</h3><p class="nxa-case">${where}</p><div class="nxa-chips" role="group" aria-label="Questions fréquentes">${chips}</div>
    <div class="nxa-form"><label class="small">Votre question<input id="core-ask-text" value="${esc(draft)}" autocomplete="off" placeholder="Posez votre question"></label><button type="button" class="btn" data-act="core-ask" data-case="${esc(active?.id ?? '')}" ${busy ? 'disabled' : ''}>Demander</button></div>
    ${notice ? `<p class="small muted" role="status">${esc(notice)}</p>` : ''}
    ${turns.length ? `<div class="nxa-tools"><span class="small muted">${turns.length} question${turns.length > 1 ? 's' : ''} dans cette conversation</span><button type="button" class="btn sec" data-act="core-ask-reset">Nouvelle conversation</button></div>` : ''}
    <div aria-live="polite">${turns.map((t, i) => renderTurn(t, { newest: i === 0 })).join('')}</div></div>`;
}

/** Controller: keeps the conversation on the phone (turns + the server's state) and asks through the panel's `post`. */
export function createAskUi({ st, post }) {
  ensureStyle();
  const nx = (st.nx ??= { turns: [], conversation: null, notice: '', draft: '' });
  function ask(text, caseId) {
    const q = String(text ?? '').trim(); if (!q) return true;
    const body = { text: q, caseId: caseId || null, conversation: nx.conversation }; // null = start; the server rebuilds whatever comes back, it never trusts it
    nx.draft = '';
    post('/api/core/ask', body, (r) => {
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
    render(active, busy) { return renderAsk({ turns: nx.turns, notice: nx.notice, draft: nx.draft, busy, active: active ? { id: active.id, name: active.name ?? active.workingName ?? '' } : null }); },
  };
}
