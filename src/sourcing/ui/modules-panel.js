// "Nordla" - the single entry: the seven modules as the SERVER reports them right now (GET /api/core/modules), each with what it can do
// here and what is missing. Nothing is shown as available that the server does not confirm. Offline, only China Sourcing works and the
// screen says so. Actions are read-only questions, a brand check, a campaign PROPOSAL, a local visual and human decisions: nothing is published or paid.
import { esc } from './dom.js';
import { coreDisabledReason, coreErrorMessage } from './core-journal-errors.js';

const BADGE = { DISPONIBLE: '#1b7f3b', 'LECTURE SEULE': '#1b5e7f', LIMITÉ: '#8a6d00', 'À APPROUVER': '#8a6d00', 'À VÉRIFIER': '#8a6d00', BLOQUÉ: '#a12', 'NON RACCORDÉ': '#666', 'NON CONFIGURÉ': '#666' };
const QUICK = { finance: [['Factures fournisseurs à payer', 'quelles factures fournisseurs dois-je payer et quelles sont les échéances ?'], ['Trésorerie', 'ma trésorerie'], ['Achats du mois', 'mes achats du mois']], analytics: [['Évolution des ventes', 'comment évoluent mes ventes et pourquoi certaines performances changent-elles ?']] };

export function createModulesPanel({ S, api, refresh }) {
  const st = (S.nx ??= { modules: null, branding: null, campaigns: null, creation: null, photo: null, answer: null, check: null, busy: false, error: '' });
  const fail = (e) => { st.error = coreErrorMessage(e); };
  async function load({ preserveError = false } = {}) {
    try { const [m, b, c, v] = await Promise.all([api('/api/core/modules'), api('/api/core/branding'), api('/api/core/campaigns'), api('/api/core/creation')]); st.modules = m.modules; st.branding = b; st.campaigns = c.campaigns; st.creation = v;
      st.financeInbox = m.modules.find((x) => x.key === 'finance')?.state === 'LECTURE SEULE' ? await api('/api/core/finance/inbox').catch(() => null) : null; /* read-only, own session: no token */ if (!preserveError) st.error = ''; } catch (e) { if (!preserveError || !st.error) fail(e); }
    refresh();
  }
  async function post(path, body, after) { st.busy = true; st.error = ''; refresh(); let failed = false; try { const r = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); after?.(r); /* NOT after?.(await api()): optional chaining would skip the request itself when there is no callback */ } catch (e) { failed = true; fail(e); } st.busy = false; await load({ preserveError: failed }); }
  const val = (id) => document.getElementById(id)?.value.trim() ?? '';
  // The photo is reduced ON THE PHONE (longest edge 1600 px, orientation applied, JPEG), like a Sourcing photo; the server then uses it as received.
  const shrink = async (file) => { const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); return cv.toDataURL('image/jpeg', 0.9); };
  if (typeof document !== 'undefined') document.addEventListener('change', async (ev) => {
    if (ev.target?.id !== 'nx-photo' || !ev.target.files?.[0]) return;
    st.open = 'creative'; try { st.photo = { name: ev.target.files[0].name, data: await shrink(ev.target.files[0]) }; st.error = ''; } catch { st.photo = null; st.error = 'Photo illisible sur ce téléphone.'; } refresh();
  });

  if (typeof document !== 'undefined') document.addEventListener('click', (ev) => {
    const t = ev.target.closest?.('[data-act^="nx-"]'); if (!t || st.busy) return;
    const a = t.dataset.act; st.open = t.closest('[data-nx-module]')?.dataset.nxModule ?? st.open; // keep the section the person works in open after the redraw
    if (a === 'nx-load') return load();
    if (a === 'nx-parle') return parle(document.getElementById('nx-q')?.value);
    if (a === 'nx-parle-ex') { st.askInput = t.dataset.label; return parle(t.dataset.q, t.dataset.label); }
    if (a === 'nx-open-finance') { const w = window.open('', '_blank'); if (w) w.opener = null; st.busy = true; st.error = ''; refresh(); return api('/api/core/finance/open', { method: 'POST', body: '{}' }).then((r) => { if (w) w.location.href = r.url; else window.location.href = r.url; }, (e) => { if (w) w.close(); fail(e); }).finally(() => { st.busy = false; refresh(); });
    }
    if (a === 'nx-ask') return post('/api/core/ask', { text: t.dataset.q }, (r) => { st.answer = { q: t.dataset.label, ...r }; });
    if (a === 'nx-check') return post('/api/core/branding/check', { text: val('nx-copy') }, (r) => { st.check = r; });
    if (a === 'nx-approve-brand') { if (!window.confirm('Approuver ces règles de marque comme règles OFFICIELLES de votre marque ?')) return; return post('/api/core/branding/approve', {}); }
    if (a === 'nx-campaign') return post('/api/core/campaigns', { product: val('nx-product'), objective: val('nx-objective'), audience: val('nx-audience'), channel: val('nx-channel'), copy: val('nx-copy') });
    if (a === 'nx-render') { if (!st.photo) { st.error = 'Choisissez d’abord une photo.'; return refresh(); } return post('/api/core/creation', { photo: st.photo.data, headline: val('nx-headline') }, () => { st.photo = null; }); }
    if (a === 'nx-cr-decide') { const reason = val(`nx-cr-reason-${t.dataset.i}`); if (!reason) { st.error = 'Écrivez la raison de votre décision.'; return refresh(); } return post(`/api/core/creation/${encodeURIComponent(t.dataset.id)}/decision`, { decision: t.dataset.decision, reason }); }
    if (a === 'nx-decide') { const reason = val(`nx-reason-${t.dataset.i}`); if (!reason) { st.error = 'Écrivez la raison de votre décision.'; return refresh(); } return post(`/api/core/campaigns/${encodeURIComponent(t.dataset.id)}/decision`, { decision: t.dataset.decision, reason }); }
  });

  const answerCard = (r) => `<div class="card" data-nx-answer><p class="small muted">${esc(r.q ?? '')}</p>${String(r.answer ?? '').split('\n').map((l) => `<p class="small">${esc(l)}</p>`).join('')}${r.sources?.length ? `<p class="small muted">Sources : ${esc(r.sources.map((s) => `${s.ref} (${s.source ?? ''}${s.asOf ? `, au ${String(s.asOf).slice(0, 10)}` : ''})`).join(' ; '))}</p>` : ''}${r.limits?.length ? `<p class="small muted">Limites : ${esc(r.limits.join(' '))}</p>` : ''}</div>`;
  const campaignCard = (c, i) => `<div class="card" data-nx-campaign><p class="small"><b>${esc(c.input.product)}</b> — ${esc(c.input.objective)} · ${esc(c.input.channel)}</p><p class="small">« ${esc(c.input.copy)} »</p>
    ${c.opportunity?.product_fact ? `<p class="small">Données : ${esc(c.opportunity.product_fact.label)} en ${esc(c.opportunity.product_fact.direction)} (${esc(c.opportunity.source)}, ${esc(c.opportunity.period.from)}→${esc(c.opportunity.period.to)}).</p>` : `<p class="small muted">${esc(c.opportunity?.note ?? c.opportunity?.unavailable ?? 'Analytics non raccordé.')}</p>`}
    ${c.blockers.map((b) => `<p class="small warn">${esc(b)}</p>`).join('')}<p class="small muted">Diffusion : impossible depuis Nordla (aucune publication, aucune dépense).</p>
    ${c.decision ? `<p class="small"><b>Décision : ${esc(c.decision.decision)}</b> — « ${esc(c.decision.reason)} »</p>` : `<label class="small">Votre raison<input id="nx-reason-${i}"></label><div class="row">${[['APPROVED_FOR_CREATION', 'Valider pour création'], ['DEFERRED', 'Reporter'], ['REJECTED', 'Rejeter']].map(([d, l]) => `<button class="btn sec" data-act="nx-decide" data-i="${i}" data-id="${esc(c.id)}" data-decision="${d}">${l}</button>`).join('')}</div>`}</div>`;
  const SHOWN = { PASS: 'conforme', FAIL: 'NON conforme', NOT_MEASURABLE: 'non mesuré' };
  const creationCard = (c, i) => `<div class="card" data-nx-creation><p class="small"><b>« ${esc(c.headline)} »</b> — ${esc(c.status === 'TO_OWNER_REVIEW' ? 'à valider' : c.status === 'BLOCKED_BY_BRAND' ? 'bloqué par la marque' : 'fidélité NON prouvée')}</p>
    ${c.png ? (S.authMode === 'session' ? `<img src="/api/core/creation/${esc(c.id)}.png" alt="Visuel ${esc(c.id)}" style="width:100%;border:1px solid #ccc">` : '<p class="small muted">Aperçu visible sur Nordla hébergé.</p>') : ''}
    ${(c.fidelity ?? []).map((f) => `<p class="small ${f.outcome === 'FAIL' ? 'warn' : ''}">${esc(f.check)} : ${esc(SHOWN[f.outcome] ?? f.outcome)}${f.reason ? ` (${esc(f.reason)})` : ''}</p>`).join('')}
    <p class="small muted">Marque : ${esc(c.brand?.official ? `vérification officielle ${c.brand.outcome}` : 'aperçu indicatif (règles non approuvées)')}. ${esc((c.limits ?? []).join(' '))} Rien n’est publié.</p>
    ${c.status !== 'TO_OWNER_REVIEW' ? '' : c.decision ? `<p class="small"><b>Décision : ${esc(c.decision.decision)}</b> — « ${esc(c.decision.reason)} »</p>` : `<label class="small">Votre raison<input id="nx-cr-reason-${i}"></label><div class="row">${[['APPROVED', 'Valider'], ['REJECTED', 'Rejeter']].map(([d, l]) => `<button class="btn sec" data-act="nx-cr-decide" data-i="${i}" data-id="${esc(c.id)}" data-decision="${d}">${l}</button>`).join('')}</div>`}</div>`;
  const creationBody = () => (st.creation?.status !== 'LOCAL_AVAILABLE' ? '' : `<p class="small">Typographie : ${esc(st.creation.typography)} · couleurs de marque : ${esc(st.creation.brand_colours)}.</p>
    <label class="small">Photo du produit<input type="file" id="nx-photo" accept="image/jpeg,image/png"></label>${st.photo ? `<p class="small">Photo prête : ${esc(st.photo.name)}</p>` : ''}
    <label class="small">Titre (80 caractères max.)<input id="nx-headline" maxlength="80"></label><button class="btn" data-act="nx-render">Composer le visuel</button>
    ${(st.creation.creations ?? []).slice(0, 5).map(creationCard).join('')}`);

  const creatorLink = (m) => (m?.creator_screen ? '<p class="small"><a class="btn" href="/creator">Ouvrir le Créateur</a> <span class="muted">— mode TEST : résultats archivés, aucun fournisseur, rien n’est publié.</span></p>' : '');
  const videoLink = (m) => (m?.video_screen ? '<p class="small"><a class="btn" href="/videos">Ajouter une vidéo</a> <span class="muted">— un MP4 de CapCut et ses légendes TikTok et Instagram, en brouillon.</span></p>' : '');
  const settingsBar = (m) => (m?.connections_screen ? '<p class="small" data-nx-settings><a class="btn" href="/settings">Paramètres</a> <a class="btn sec" href="/settings/connections">Connexions</a> <span class="muted">— comptes reliés et leur état réel, en lecture seule.</span></p>' : '');
  const growthLink = (m) => (m?.growth_url && /^https:\/\//.test(m.growth_url) ? `<p class="small" data-nx-growth><a class="btn" href="${esc(m.growth_url)}/#/dropoff" target="_blank" rel="noopener">Où les visiteurs abandonnent</a> <a class="btn sec" href="${esc(m.growth_url)}/#/opportunities" target="_blank" rel="noopener">Opportunités</a> <span class="muted">— nouvel onglet ; Nordla ne publie, ne modifie et ne dépense rien.</span></p>` : '');
  const gbpLink = (m) => (m?.gbp_screen ? '<p class="small"><a class="btn" href="/gbp">Voir et approuver les publications Google</a> <span class="muted">— deux brouillons ; Nordla ne publie rien sur Google.</span></p>' : '');
  const financeOpenButton = (m) => (m?.dashboard ? ` <button class="btn" data-act="nx-open-finance">Ouvrir le tableau de bord Finance</button>` : '');
  // ---- Parle à Nordla: one input, one answer zone, on the person's own session (the server resolves the merchant). Read-only: Nordla answers, it executes nothing.
  const EXAMPLES = [['Ma trésorerie ?', 'ma trésorerie'], ['Quelles factures dois-je payer ?', 'quelles factures fournisseurs dois-je payer et quelles sont les échéances ?'], ['Chiffre d’affaires des 30 derniers jours', 'quel est mon chiffre d’affaires des 30 derniers jours ?']];
  async function parle(text, label) {
    const q = String(text ?? '').trim();
    if (!q) { st.askError = 'Écrivez une question.'; return refresh(); }
    st.asking = true; st.askError = ''; st.answer = null; refresh();
    try { const r = await api('/api/core/ask', { method: 'POST', body: JSON.stringify({ text: q.slice(0, 1000) }) }); st.answer = { q: label ?? q, ...r }; }
    catch (e) { st.askError = coreErrorMessage(e); }
    st.asking = false; refresh();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('input', (ev) => { if (ev.target?.id === 'nx-q') st.askInput = ev.target.value; });
    document.addEventListener('keydown', (ev) => { if (ev.target?.id === 'nx-q' && ev.key === 'Enter' && !st.asking) { ev.preventDefault(); parle(ev.target.value); } });
  }
  const parleCard = () => `<section class="card" data-nx-parle><h3>Parle à Nordla</h3><p class="small muted">Posez une question sur votre activité. Nordla répond en lecture seule, sur les données de votre boutique : il ne commande, ne paie et ne publie rien.</p>
    <div class="row"><input id="nx-q" maxlength="1000" placeholder="Ex. : Ma trésorerie ?" value="${esc(st.askInput ?? '')}" aria-label="Votre question"><button class="btn" data-act="nx-parle" ${st.asking ? 'disabled' : ''}>Demander</button></div>
    <div class="row">${EXAMPLES.map(([l, q]) => `<button class="btn sec" data-act="nx-parle-ex" data-label="${esc(l)}" data-q="${esc(q)}" ${st.asking ? 'disabled' : ''}>${esc(l)}</button>`).join(' ')}</div>
    ${st.asking ? '<p class="small muted" role="status" data-nx-waiting>Nordla cherche la réponse…</p>' : ''}${st.askError ? `<p class="warn" role="alert" data-nx-ask-error>${esc(st.askError)}</p>` : ''}${st.answer ? answerCard(st.answer) : ''}</section>`;

  const FIN_STATUS = { RECEIVED: 'reçue', TO_REVIEW: 'à vérifier', VALIDATED: 'validée', TO_PAY: 'à payer', PAID: 'payée', REJECTED: 'rejetée' };
  const financeInboxCard = () => { const i = st.financeInbox; if (!i) return ''; const money = (c, cur) => (Number.isInteger(c) ? `${(c / 100).toFixed(2)} ${esc(cur ?? '')}` : 'montant à saisir'); return `<div class="card" data-nx-finance-inbox><p class="small"><b>Boîte factures fournisseurs</b> — ${i.total} fiche(s), ${i.toReview} à vérifier <span class="muted">(${esc(i.source)})</span></p>${i.items.slice(0, 10).map((r) => `<p class="small">${esc(FIN_STATUS[r.status] ?? r.status)} · ${esc(r.supplier ?? 'fournisseur ?')} · ${esc(r.invoiceNumber ?? 'n° de facture à saisir')}${r.orderReference ? ` · bon ${esc(r.orderReference)}` : ''} · ${money(r.grossCents, r.currency)}</p>`).join('') || '<p class="small muted">Aucune fiche.</p>'}<p class="small muted">Lecture seule : rien n’est validé ni payé depuis Nordla.</p></div>`; };
  function section() {
    const head = '<h2 id="nx-head">Nordla</h2>';
    if (!S.online || !S.token) return `${head}<p class="small muted">Hors ligne : seul China Sourcing fonctionne (vos dossiers et photos restent sur ce téléphone). Les six autres modules demandent le serveur.</p>`;
    if (!st.modules) return `${head}${parleCard()}${st.error ? `<p class="warn">${esc(st.error)}</p>` : ''}<button class="btn" data-act="nx-load">Ouvrir Nordla (7 modules)</button>`;
    const by = Object.fromEntries(st.modules.map((m) => [m.key, m]));
    const mod = (m, body = '') => `<details class="card" data-nx-module="${esc(m.key)}" ${st.open === m.key ? 'open' : ''}><summary><b>${esc(m.label)}</b> <span class="small" style="color:#fff;background:${BADGE[m.state] ?? '#666'};border-radius:4px;padding:1px 6px">${esc(m.state)}</span>${m.offline ? ' <span class="small muted">hors ligne</span>' : ''}</summary><p class="small muted">${esc(m.key === 'core' && m.state === 'NON CONFIGURÉ' ? coreDisabledReason(m.detail) : m.detail)}</p>${body}</details>`;
    const quick = (k) => (QUICK[k] ?? []).map(([l, q]) => `<button class="btn sec" data-act="nx-ask" data-label="${esc(l)}" data-q="${esc(q)}" ${['LECTURE SEULE'].includes(by[k]?.state) ? '' : 'disabled'}>${esc(l)}</button>`).join(' ');
    const b = st.branding;
    const brandBody = b?.status === 'PROPOSED_NOT_APPROVED' || b?.status === 'APPROVED' ? `<p class="small">Positionnement : ${esc(b.positioning)}</p><p class="small">Interdits proposés : ${esc(b.rules.map((r) => `« ${r.forbidden} » (${r.severity === 'BLOCK' ? 'bloquant' : 'à revoir'})`).join(', '))}</p>${b.status === 'APPROVED' ? `<p class="small">Approuvé le ${esc(String(b.approvedAt).slice(0, 16).replace('T', ' '))}.</p>` : `<p class="small muted">Questions ouvertes : ${esc(b.questions.join(' '))}</p><button class="btn sec" data-act="nx-approve-brand">Approuver ces règles (propriétaire)</button>`}` : '';
    const check = st.check ? `<div class="card" data-nx-check><p class="small"><b>${st.check.official ? `Vérification officielle : ${esc(st.check.outcome)}` : 'Aperçu indicatif (règles non approuvées)'}</b></p>${(st.check.findings ?? []).map((f) => `<p class="small warn">${esc(f.forbidden ?? f.rule)} — ${esc(f.why ?? f.reason ?? f.outcome)}</p>`).join('') || '<p class="small">Rien de signalé.</p>'}</div>` : '';
    const form = `<label class="small">Produit<input id="nx-product"></label><label class="small">Objectif<input id="nx-objective" placeholder="ex. ventes en boutique à Namur"></label><label class="small">Public<input id="nx-audience" placeholder="ex. parents cherchant un cadeau"></label><label class="small">Canal<input id="nx-channel" placeholder="ex. Instagram"></label><label class="small">Texte proposé<textarea id="nx-copy" rows="2"></textarea></label><div class="row"><button class="btn sec" data-act="nx-check">Vérifier la marque</button><button class="btn" data-act="nx-campaign">Préparer la proposition</button></div>`;
    return `${head}${parleCard()}${settingsBar(by.core)}${st.error ? `<p class="warn" role="status">${esc(st.error)}</p>` : ''}<p class="small muted">État réel des modules sur ce serveur. Rien n’est publié, payé ni commandé par Nordla.</p>
      ${mod(by.core, `<p class="small muted">Voir « Nordla Core » plus bas (décisions d’achat, suivi).</p>`)}
      ${mod(by.finance, quick('finance') + financeOpenButton(by.finance) + financeInboxCard())}${by.procurement ? mod(by.procurement, '<p class="small"><a href="/procurement/">Ouvrir Stock / Achats</a></p>') : ''}${mod(by.analytics, quick('analytics'))}
      ${mod(by.sourcing, '<p class="small muted">Écran principal de l’application.</p>')}
      ${mod(by.branding, brandBody)}${mod(by.marketing, `${form}${check}${(st.campaigns ?? []).slice(0, 5).map(campaignCard).join('')}${gbpLink(by.marketing)}${videoLink(by.marketing)}`)}${mod(by.creative, creationBody() + creatorLink(by.creative))}${by.growth ? mod(by.growth, growthLink(by.growth)) : ''}
      `;
  }
  return { section, load, ask: parle };
}
