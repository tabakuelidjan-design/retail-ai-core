// "Nordla Core" in the menu: the purchase decision of the open case (Subject -> options -> recommendation -> YOUR decision -> follow-up)
// and Parle à Nordla in text. Everything here is computed and recorded by the SERVER (src/core-pilot): the phone only shows it and sends
// the person's choice. Offline it says so and changes nothing local. Nordla never orders or pays: the screen says it.
import { esc } from './dom.js';
import { coreDisabledReason, coreErrorMessage } from './core-journal-errors.js';

const KIND = { ACTION: 'Action', COMBINED: 'Actions combinées', TEST_SMALL: 'Tester petit (échantillon, documents) avant d’engager de l’argent', DO_NOTHING: 'Ne rien faire' };
const RESULTS = [['CONFIRMED', 'Confirmé'], ['SUGGESTIVE', 'Plutôt confirmé'], ['REFUTED', 'Démenti'], ['NOT_MEASURABLE', 'Pas mesurable'], ['UNKNOWN', 'Pas encore su']];
const DECIDED = { APPROVED: 'Validé', APPROVED_ALTERNATIVE: 'Autre option choisie', REJECTED: 'Rejeté', DEFERRED: 'Reporté' };
const val = (v) => (v === null || v === undefined ? 'inconnu' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v));

export function createCorePanel({ S, api, refresh }) {
  const st = (S.core ??= { status: null, byCase: {}, ask: null, busy: false, error: '' });
  const fail = (e) => { st.error = coreErrorMessage(e); };
  async function load(caseId) {
    try { st.status = await api('/api/core/status'); if (caseId && st.status.enabled) st.byCase[caseId] = (await api(`/api/core/decisions?case=${encodeURIComponent(caseId)}`)).decisions; st.error = ''; } catch (e) { fail(e); }
    refresh();
  }
  async function post(path, body, after) {
    st.busy = true; st.error = ''; refresh();
    try { const r = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); after?.(r); } catch (e) { fail(e); }
    st.busy = false; refresh();
  }

  if (typeof document !== 'undefined') document.addEventListener('click', (ev) => {
    const t = ev.target.closest?.('[data-act^="core-"]'); if (!t || st.busy) return;
    const act = t.dataset.act; const id = t.dataset.key; const caseId = t.dataset.case;
    const reason = () => document.getElementById(`core-reason-${id}`)?.value.trim() ?? '';
    const remember = (r) => { const d = r.decision; if (!d) return; const list = (st.byCase[d.case_id] ??= []).filter((x) => x.id !== d.id); st.byCase[d.case_id] = [d, ...list]; };
    if (act === 'core-load') return load(caseId);
    if (act === 'core-analyse') return post(`/api/core/cases/${encodeURIComponent(caseId)}/analyse`, {}, (r) => { if (r.status === 'SUPPRESSED') st.error = `Sujet mis de côté récemment : ${r.reason}`; remember(r); });
    if (['core-approve', 'core-reject', 'core-defer', 'core-alt'].includes(act)) {
      if (!reason()) { st.error = 'Écrivez la raison de votre décision : elle est gardée dans le journal.'; return refresh(); }
      const decision = { 'core-approve': 'APPROVED', 'core-reject': 'REJECTED', 'core-defer': 'DEFERRED', 'core-alt': 'APPROVED_ALTERNATIVE' }[act];
      return post(`/api/core/decisions/${encodeURIComponent(id)}/human`, { decision, reason: reason(), ...(decision === 'APPROVED_ALTERNATIVE' ? { chosen_lever_ids: [t.dataset.lever] } : {}) }, remember);
    }
    if (act === 'core-result') return post(`/api/core/decisions/${encodeURIComponent(id)}/result`, { result: t.dataset.result, evidence_level: ['NOT_MEASURABLE', 'UNKNOWN'].includes(t.dataset.result) ? undefined : 'WEAK', /* the owner's own statement, no measured data: weak evidence */ notes: document.getElementById(`core-notes-${id}`)?.value ?? '' }, remember);
    if (act === 'core-ask') { const text = document.getElementById('core-ask-text')?.value.trim() ?? ''; if (!text) return; return post('/api/core/ask', { text, caseId: caseId || null }, (r) => { st.ask = { text, ...r }; }); }
  });

  function decisionCard(d) {
    const rec = d.recommendation; const open = !d.human_decision && rec;
    const approved = d.human_decision && ['APPROVED', 'APPROVED_ALTERNATIVE'].includes(d.human_decision.decision);
    return `<div class="card" data-core-decision="${esc(d.id)}"><p class="small muted">Analyse du ${esc(d.created_at.slice(0, 16).replace('T', ' '))} — dossier version ${esc(String(d.case_version ?? '').split('@')[1] ?? '')}</p>
      ${rec ? `<p><b>Recommandation : ${esc(rec.label)}</b><br><span class="small">${esc(KIND[rec.kind] ?? rec.kind)}</span></p>${rec.rationale.map((x) => `<p class="small">• ${esc(x)}</p>`).join('')}` : '<p class="warn">Aucune recommandation : des données bloquantes manquent (voir ci-dessous).</p>'}
      <p class="small"><b>Options examinées</b></p>${d.options.map((o) => `<p class="small">${o.status === 'ELIGIBLE' ? '✓' : '✗'} ${esc(o.label)}${o.reasons.length ? ` — <span class="muted">${esc(o.reasons.join(' ; '))}</span>` : ''}${open && o.status === 'ELIGIBLE' && !rec.lever_ids.includes(o.lever_id) ? ` <button class="btn sec" data-act="core-alt" data-key="${esc(d.id)}" data-lever="${esc(o.lever_id)}">Choisir celle-ci</button>` : ''}</p>`).join('')}
      <details><summary class="small">Faits utilisés et sources</summary>${d.facts.map((f) => `<p class="small">${esc(f.key)} : ${esc(val(f.value))}${f.unit ? ` ${esc(f.unit)}` : ''} <span class="muted">(${esc(f.source ?? 'source inconnue')})</span></p>`).join('')}${d.missing_data.map((m) => `<p class="small warn">Manque : ${esc(m.field)} — ${esc(m.reason)}</p>`).join('')}<p class="small muted">Règles du propriétaire appliquées : ${d.rules.length ? esc(d.rules.map((r) => r.label).join(', ')) : 'aucune configurée'}.</p></details>
      ${open ? `<label class="small">Votre raison (obligatoire)<textarea id="core-reason-${esc(d.id)}" rows="2"></textarea></label><div class="row"><button class="btn" data-act="core-approve" data-key="${esc(d.id)}">Valider la recommandation</button><button class="btn sec" data-act="core-defer" data-key="${esc(d.id)}">Reporter</button><button class="btn danger" data-act="core-reject" data-key="${esc(d.id)}">Rejeter</button></div>` : ''}
      ${d.human_decision ? `<p class="small"><b>${esc(DECIDED[d.human_decision.decision] ?? d.human_decision.decision)}</b> le ${esc(d.human_decision.decided_at.slice(0, 16).replace('T', ' '))} — « ${esc(d.human_decision.reason)} »</p>` : ''}
      ${approved && !d.result ? `<p class="small"><b>Suivi</b> : qu’a donné cette décision ?</p><label class="small">Notes<input id="core-notes-${esc(d.id)}"></label><div class="row">${RESULTS.map(([k, l]) => `<button class="btn sec" data-act="core-result" data-key="${esc(d.id)}" data-result="${k}">${l}</button>`).join('')}</div>` : ''}
      ${d.result ? `<p class="small"><b>Résultat : ${esc(RESULTS.find(([k]) => k === d.result.result)?.[1] ?? d.result.result)}</b>${d.result.notes ? ` — ${esc(d.result.notes)}` : ''}</p>` : ''}
      <p class="small muted">Nordla ne commande et ne paie rien : toute commande reste votre action, hors de Nordla.</p></div>`;
  }

  /** The menu section. `active` = the open case (or null). */
  function section(active) {
    const head = '<h2>Nordla Core</h2>';
    if (!S.online || !S.token) return `${head}<p class="small muted">Nordla Core et Parle à Nordla demandent le serveur${S.online ? ' (connectez-vous)' : ' : hors ligne maintenant'}. Rien n’est perdu : vos dossiers restent sur ce téléphone.</p>`;
    const err = st.error ? `<p class="warn" role="status">${esc(st.error)}</p>` : '';
    if (!st.status) return `${head}${err}<button class="btn sec" data-act="core-load" data-case="${esc(active?.id ?? '')}">Ouvrir Nordla Core</button>`;
    if (!st.status.enabled) return `${head}${err}<p class="warn">Nordla Core n’est pas actif sur ce serveur : ${esc(coreDisabledReason(st.status.reason))}</p>`;
    const list = active ? st.byCase[active.id] : null;
    const caseBlock = !active ? '<p class="small muted">Ouvrez un dossier pour analyser son achat.</p>'
      : list === undefined ? `<button class="btn sec" data-act="core-load" data-case="${esc(active.id)}">Voir les décisions de ce dossier</button>`
        : `${list.length ? decisionCard(list[0]) : '<p class="small muted">Pas encore analysé par Nordla Core.</p>'}<button class="btn" data-act="core-analyse" data-case="${esc(active.id)}" ${st.busy ? 'disabled' : ''}>Analyser l’achat de ce dossier (version serveur)</button>`;
    const a = st.ask;
    const askBlock = `<h3>Parle à Nordla (texte)</h3><label class="small">Votre question<input id="core-ask-text" placeholder="ex. résume ce dossier ; dois-je acheter ce produit ? ; décisions en attente"></label><button class="btn sec" data-act="core-ask" data-case="${esc(active?.id ?? '')}" ${st.busy ? 'disabled' : ''}>Demander</button>
      ${a ? `<div class="card" data-core-answer><p class="small muted">« ${esc(a.text)} »</p>${String(a.answer ?? '').split('\n').map((l) => `<p class="small">${esc(l)}</p>`).join('')}${a.sources?.length ? `<p class="small muted">Sources : ${esc(a.sources.map((s) => `${s.kind === 'sourcing_case' ? 'dossier' : 'journal'} ${s.ref}`).join(', '))}</p>` : ''}${a.limits?.length ? `<p class="small muted">Limites : ${esc(a.limits.join(' '))}</p>` : ''}</div>` : ''}`;
    return `${head}${err}<p class="small muted">Décisions en attente : ${esc(st.status.awaiting_human ?? 0)} — en suivi : ${esc(st.status.in_follow_up ?? 0)}. Règles du propriétaire : ${st.status.owner_rules === 'CONFIGURED' ? 'configurées' : 'aucune configurée'}.</p>${caseBlock}${askBlock}`;
  }
  return { section, load };
}
