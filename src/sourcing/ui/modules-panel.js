// "Nordla" - the single entry: the seven modules as the SERVER reports them right now (GET /api/core/modules), each with what it can do
// here and what is missing. Nothing is shown as available that the server does not confirm. Offline, only China Sourcing works and the
// screen says so. Actions are read-only questions, a brand check, a campaign PROPOSAL and human decisions: nothing is published or paid.
import { esc } from './dom.js';

const BADGE = { DISPONIBLE: '#1b7f3b', 'LECTURE SEULE': '#1b5e7f', LIMITÉ: '#8a6d00', 'À APPROUVER': '#8a6d00', 'À VÉRIFIER': '#8a6d00', BLOQUÉ: '#a12', 'NON RACCORDÉ': '#666', 'NON CONFIGURÉ': '#666' };
const QUICK = { finance: [['Factures fournisseurs à payer', 'quelles factures fournisseurs dois-je payer et quelles sont les échéances ?'], ['Trésorerie', 'ma trésorerie'], ['Achats du mois', 'mes achats du mois']], analytics: [['Évolution des ventes', 'comment évoluent mes ventes et pourquoi certaines performances changent-elles ?']] };

export function createModulesPanel({ S, api, refresh }) {
  const st = (S.nx ??= { modules: null, branding: null, campaigns: null, answer: null, check: null, busy: false, error: '' });
  const fail = (e) => { st.error = e?.body?.message ?? (e?.status === 401 ? 'Session expirée : reconnectez-vous.' : 'Le serveur n’a pas pu répondre. Rien n’a été changé.'); };
  async function load() {
    try { const [m, b, c] = await Promise.all([api('/api/core/modules'), api('/api/core/branding'), api('/api/core/campaigns')]); st.modules = m.modules; st.branding = b; st.campaigns = c.campaigns; st.error = ''; } catch (e) { fail(e); }
    refresh();
  }
  async function post(path, body, after) { st.busy = true; st.error = ''; refresh(); try { const r = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); after?.(r); /* NOT after?.(await api()): optional chaining would skip the request itself when there is no callback */ } catch (e) { fail(e); } st.busy = false; await load(); }
  const val = (id) => document.getElementById(id)?.value.trim() ?? '';

  if (typeof document !== 'undefined') document.addEventListener('click', (ev) => {
    const t = ev.target.closest?.('[data-act^="nx-"]'); if (!t || st.busy) return;
    const a = t.dataset.act; st.open = t.closest('[data-nx-module]')?.dataset.nxModule ?? st.open; // keep the section the person works in open after the redraw
    if (a === 'nx-load') return load();
    if (a === 'nx-ask') return post('/api/core/ask', { text: t.dataset.q }, (r) => { st.answer = { q: t.dataset.label, ...r }; });
    if (a === 'nx-check') return post('/api/core/branding/check', { text: val('nx-copy') }, (r) => { st.check = r; });
    if (a === 'nx-approve-brand') { if (!window.confirm('Approuver ces règles de marque comme règles OFFICIELLES de votre marque ?')) return; return post('/api/core/branding/approve', {}); }
    if (a === 'nx-campaign') return post('/api/core/campaigns', { product: val('nx-product'), objective: val('nx-objective'), audience: val('nx-audience'), channel: val('nx-channel'), copy: val('nx-copy') });
    if (a === 'nx-decide') { const reason = val(`nx-reason-${t.dataset.i}`); if (!reason) { st.error = 'Écrivez la raison de votre décision.'; return refresh(); } return post(`/api/core/campaigns/${encodeURIComponent(t.dataset.id)}/decision`, { decision: t.dataset.decision, reason }); }
  });

  const answerCard = (r) => `<div class="card" data-nx-answer><p class="small muted">${esc(r.q ?? '')}</p>${String(r.answer ?? '').split('\n').map((l) => `<p class="small">${esc(l)}</p>`).join('')}${r.sources?.length ? `<p class="small muted">Sources : ${esc(r.sources.map((s) => `${s.ref} (${s.source ?? ''}${s.asOf ? `, au ${String(s.asOf).slice(0, 10)}` : ''})`).join(' ; '))}</p>` : ''}${r.limits?.length ? `<p class="small muted">Limites : ${esc(r.limits.join(' '))}</p>` : ''}</div>`;
  const campaignCard = (c, i) => `<div class="card" data-nx-campaign><p class="small"><b>${esc(c.input.product)}</b> — ${esc(c.input.objective)} · ${esc(c.input.channel)}</p><p class="small">« ${esc(c.input.copy)} »</p>
    ${c.opportunity?.product_fact ? `<p class="small">Données : ${esc(c.opportunity.product_fact.label)} en ${esc(c.opportunity.product_fact.direction)} (${esc(c.opportunity.source)}, ${esc(c.opportunity.period.from)}→${esc(c.opportunity.period.to)}).</p>` : `<p class="small muted">${esc(c.opportunity?.note ?? c.opportunity?.unavailable ?? 'Analytics non raccordé.')}</p>`}
    ${c.blockers.map((b) => `<p class="small warn">${esc(b)}</p>`).join('')}<p class="small muted">Diffusion : impossible depuis Nordla (aucune publication, aucune dépense).</p>
    ${c.decision ? `<p class="small"><b>Décision : ${esc(c.decision.decision)}</b> — « ${esc(c.decision.reason)} »</p>` : `<label class="small">Votre raison<input id="nx-reason-${i}"></label><div class="row">${[['APPROVED_FOR_CREATION', 'Valider pour création'], ['DEFERRED', 'Reporter'], ['REJECTED', 'Rejeter']].map(([d, l]) => `<button class="btn sec" data-act="nx-decide" data-i="${i}" data-id="${esc(c.id)}" data-decision="${d}">${l}</button>`).join('')}</div>`}</div>`;

  function section() {
    const head = '<h2>Nordla</h2>';
    if (!S.online || !S.token) return `${head}<p class="small muted">Hors ligne : seul China Sourcing fonctionne (vos dossiers et photos restent sur ce téléphone). Les six autres modules demandent le serveur.</p>`;
    if (!st.modules) return `${head}${st.error ? `<p class="warn">${esc(st.error)}</p>` : ''}<button class="btn" data-act="nx-load">Ouvrir Nordla (7 modules)</button>`;
    const by = Object.fromEntries(st.modules.map((m) => [m.key, m]));
    const mod = (m, body = '') => `<details class="card" data-nx-module="${esc(m.key)}" ${st.open === m.key ? 'open' : ''}><summary><b>${esc(m.label)}</b> <span class="small" style="color:#fff;background:${BADGE[m.state] ?? '#666'};border-radius:4px;padding:1px 6px">${esc(m.state)}</span>${m.offline ? ' <span class="small muted">hors ligne</span>' : ''}</summary><p class="small muted">${esc(m.detail)}</p>${body}</details>`;
    const quick = (k) => (QUICK[k] ?? []).map(([l, q]) => `<button class="btn sec" data-act="nx-ask" data-label="${esc(l)}" data-q="${esc(q)}" ${['LECTURE SEULE'].includes(by[k]?.state) ? '' : 'disabled'}>${esc(l)}</button>`).join(' ');
    const b = st.branding;
    const brandBody = b?.status === 'PROPOSED_NOT_APPROVED' || b?.status === 'APPROVED' ? `<p class="small">Positionnement : ${esc(b.positioning)}</p><p class="small">Interdits proposés : ${esc(b.rules.map((r) => `« ${r.forbidden} » (${r.severity === 'BLOCK' ? 'bloquant' : 'à revoir'})`).join(', '))}</p>${b.status === 'APPROVED' ? `<p class="small">Approuvé le ${esc(String(b.approvedAt).slice(0, 16).replace('T', ' '))}.</p>` : `<p class="small muted">Questions ouvertes : ${esc(b.questions.join(' '))}</p><button class="btn sec" data-act="nx-approve-brand">Approuver ces règles (propriétaire)</button>`}` : '';
    const check = st.check ? `<div class="card" data-nx-check><p class="small"><b>${st.check.official ? `Vérification officielle : ${esc(st.check.outcome)}` : 'Aperçu indicatif (règles non approuvées)'}</b></p>${(st.check.findings ?? []).map((f) => `<p class="small warn">${esc(f.forbidden ?? f.rule)} — ${esc(f.why ?? f.reason ?? f.outcome)}</p>`).join('') || '<p class="small">Rien de signalé.</p>'}</div>` : '';
    const form = `<label class="small">Produit<input id="nx-product"></label><label class="small">Objectif<input id="nx-objective" placeholder="ex. ventes en boutique à Namur"></label><label class="small">Public<input id="nx-audience" placeholder="ex. parents cherchant un cadeau"></label><label class="small">Canal<input id="nx-channel" placeholder="ex. Instagram"></label><label class="small">Texte proposé<textarea id="nx-copy" rows="2"></textarea></label><div class="row"><button class="btn sec" data-act="nx-check">Vérifier la marque</button><button class="btn" data-act="nx-campaign">Préparer la proposition</button></div>`;
    return `${head}${st.error ? `<p class="warn" role="status">${esc(st.error)}</p>` : ''}<p class="small muted">État réel des modules sur ce serveur. Rien n’est publié, payé ni commandé par Nordla.</p>
      ${mod(by.core, '<p class="small muted">Voir « Nordla Core » plus bas (décisions d’achat, suivi).</p>')}
      ${mod(by.finance, quick('finance'))}${mod(by.analytics, quick('analytics'))}
      ${mod(by.sourcing, '<p class="small muted">Écran principal de l’application.</p>')}
      ${mod(by.branding, brandBody)}${mod(by.marketing, `${form}${check}${(st.campaigns ?? []).slice(0, 5).map(campaignCard).join('')}`)}${mod(by.creative)}
      ${st.answer ? answerCard(st.answer) : ''}`;
  }
  return { section, load };
}
