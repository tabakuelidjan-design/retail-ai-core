// HABB publications - phone app. Vanilla JS, no dependency. Everything user-controlled (captions, notes) is inserted with textContent.
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
let TOKEN = '';
let STATE = null;
let TAB = 'review';
const blobs = new Map();

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const PROBLEMS = {
  ASSET_MISSING: 'Visuel manquant', CAPTION_MISSING: 'Texte manquant',
  UNCONFIRMED_CLAIM_PRICE: 'Un prix apparaît dans le texte (non confirmé)', UNCONFIRMED_CLAIM_DISCOUNT: 'Une réduction / promo apparaît (non confirmée)',
  UNCONFIRMED_CLAIM_DELIVERY_DELAY: 'Un délai de livraison apparaît (non confirmé)', UNCONFIRMED_CLAIM_GUARANTEE: 'Une garantie / superlatif apparaît (non confirmé)',
  UNCONFIRMED_CLAIM_URGENCY: "Une urgence commerciale apparaît (non confirmée)",
};
const ALERTS = {
  REMOTE_CANCEL_PENDING: ["ATTENTION : la suppression de la copie programmée chez la plateforme n'est pas confirmée. Elle peut encore se publier. Vérifiez dans Meta Business Suite.", 'bad'],
  PLATFORM_SCHEDULE_MISSING: ['La plateforme ne montre plus cette publication programmée. Vérifiez dans Meta Business Suite.', 'bad'],
  OUTCOME_UNKNOWN: ["Résultat inconnu : la publication a peut-être eu lieu. Regardez la page, puis indiquez ce que vous voyez.", 'bad'],
  NO_CONNECTION_USE_MANUAL: ["Aucune connexion active : cette publication ne partira pas toute seule. Utilisez le pack de publication manuelle.", 'warn'],
  MANUAL_CANCEL_REQUIRED: ["ATTENTION : vous aviez programmé ce post à la main chez Meta. Supprimez cette programmation dans Meta Business Suite, puis confirmez ici.", 'bad'],
  MANUAL_SCHEDULED: ["Programmé à la main chez Meta : Nordla ne le publiera PAS lui-même (pas de doublon).", 'ok'],
  MANUAL_SCHEDULE_CHECK: ["L'heure est passée : regardez la page, puis collez le lien du post (« J'ai publié à la main »).", 'warn'],
  OVERDUE: ["L'heure prévue est passée.", 'warn'],
  MANUAL_ONLY: ["Ce post sera publié À LA MAIN (carrousel, story, ou visuel PNG pour Instagram) : Nordla ne l'enverra pas. Utilisez le pack manuel, puis « J'ai publié à la main ».", 'warn'],
};
const PLATFORM = { instagram: 'Instagram', facebook: 'Facebook' };
const FORMAT = { IMAGE: 'Photo', REEL: 'Reel', TEXT: 'Texte' };
const fmtWhen = (w) => (w ? `${new Date(`${w.date}T12:00:00`).toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' })} à ${w.time}` : 'sans date');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'x-social-token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { sessionStorage.removeItem('social_token'); throw Object.assign(new Error('Accès refusé : lien ou jeton invalide.'), { fatal: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Erreur ${res.status}`);
  return data;
}

async function visual(post) {
  const a = post.asset;
  if (!a) return null;
  const img = h('img', { class: 'visual', alt: `Visuel : ${post.subject.label || post.subject.ref}`, loading: 'lazy' });
  const url = `/api/asset?ref=${encodeURIComponent(a.ref)}&v=${a.version}&sha=${a.sha256}`;
  if (blobs.has(url)) img.src = blobs.get(url);
  else fetch(url, { headers: { 'x-social-token': TOKEN } }).then(async (r) => {
    if (!r.ok) { img.replaceWith(h('div', { class: 'alert bad' }, r.status === 409 ? "Le fichier ne correspond plus à la version approuvée." : 'Visuel introuvable sur cet appareil.')); return; }
    const u = URL.createObjectURL(await r.blob()); blobs.set(url, u); img.src = u;
  });
  return img;
}

function say(msg, kind = 'ok') {
  const b = $('#banner');
  b.textContent = msg; b.className = `banner ${kind === 'ok' ? 'warn' : kind}`; b.hidden = false;
  clearTimeout(say.t); say.t = setTimeout(() => { renderBanner(); }, 6000);
}
function renderBanner() {
  const b = $('#banner');
  const modes = new Set((STATE?.connections ?? []).map((c) => c.mode).filter(Boolean));
  if (modes.has('SIMULATION')) { b.textContent = "MODE SIMULATION : rien n'est réellement publié."; b.className = 'banner bad'; b.hidden = false; }
  else if (!modes.size) { b.textContent = "Aucune plateforme connectée : rien ne part tout seul. Pack de publication manuelle disponible sur chaque post approuvé."; b.className = 'banner warn'; b.hidden = false; }
  else b.hidden = true;
}

async function act(post, action, params = {}) {
  try { await api(`/api/posts/${post.id}/act`, { method: 'POST', body: { action, params } }); await load(); say('Enregistré.'); } catch (e) { say(e.message, 'bad'); await load(); }
}
async function edit(post, patch) {
  try { await api(`/api/posts/${post.id}/edit`, { method: 'POST', body: { patch } }); await load(); say("Modifié. Toute approbation précédente est annulée."); } catch (e) { say(e.message, 'bad'); }
}
const ask = (text, def = '') => window.prompt(text, def);

function postCard(post, { compact = false } = {}) {
  const card = h('article', { class: 'card', 'data-post': post.id });
  const imgHolder = h('div');
  visual(post).then((img) => { if (img) imgHolder.append(img); });
  const pills = [
    h('span', { class: 'pill' }, PLATFORM[post.platform]), h('span', { class: 'pill' }, FORMAT[post.format]),
    h('span', { class: `pill ${['PUBLISHED', 'VERIFIED'].includes(post.state) ? 'ok' : ['ERROR', 'PUBLICATION_UNKNOWN', 'REJECTED'].includes(post.state) ? 'bad' : 'warn'}` }, post.state_label),
    h('span', { class: 'pill' }, fmtWhen(post.when_brussels)),
  ];
  card.append(h('h3', {}, post.subject.label || post.subject.ref), h('div', { class: 'meta' }, pills), imgHolder);
  if (post.asset?.ai_generated) card.append(h('div', { class: 'meta' }, h('span', { class: 'pill' }, 'Visuel généré par IA (sera déclaré)')));
  card.append(h('div', { class: 'caption', 'aria-label': 'Texte exact qui sera publié' }, post.full_caption || '(pas de texte)'));
  for (const code of post.problems) card.append(h('div', { class: 'alert warn' }, PROBLEMS[code] ?? code));
  for (const a of post.alerts) { const [text, kind] = ALERTS[a] ?? [a, 'warn']; card.append(h('div', { class: `alert ${kind}` }, text)); }
  if (post.mode_label) card.append(h('div', { class: `alert ${post.publication.mode === 'SIMULATION' ? 'bad' : 'ok'}` }, post.mode_label, post.publication.permalink ? [' — ', h('a', { href: post.publication.permalink, rel: 'noopener noreferrer', target: '_blank' }, 'voir le post')] : ''));
  if (post.publication?.last_error && ['ERROR', 'SCHEDULED'].includes(post.state)) card.append(h('div', { class: 'alert warn' }, `Dernier incident : ${post.publication.last_error}`));
  if (post.publication?.platform_schedule) card.append(h('div', { class: 'alert ok' }, `Programmé chez ${PLATFORM[post.platform]} (part même si Nordla est éteint).`));
  if (!compact) card.append(actionsFor(post));
  card.append(historyOf(post));
  return card;
}

function dateEditor(post) {
  const date = h('input', { type: 'date', value: post.when_brussels?.date ?? '' });
  const time = h('input', { type: 'time', value: post.when_brussels?.time ?? '18:00' });
  return h('details', {}, h('summary', {}, post.publish_at ? 'Changer la date (heure de Belgique)' : 'Choisir la date (heure de Belgique)'),
    h('label', {}, 'Date'), date, h('label', {}, 'Heure'), time,
    h('div', { class: 'actions' }, h('button', { class: 'btn sec', onclick: () => date.value && edit(post, { publish_local: { date: date.value, time: time.value } }) }, 'Enregistrer la date')));
}

function actionsFor(post) {
  const box = h('div');
  const row = h('div', { class: 'actions' });
  const hash = post.current_hash;
  const blocked = post.problems.length > 0;
  const manualSchedule = () => { if (!post.publication?.manual_schedule) row.append(h('button', { class: 'btn sec', onclick: () => { if (confirm("Confirmez-vous l'avoir programmé vous-même dans Meta Business Suite, à la date et l'heure indiquées ? Nordla ne le publiera alors pas.")) act(post, 'mark_manual_schedule', { where: 'Meta Business Suite' }); } }, "Je l'ai programmé dans Meta")); };
  const manual = () => row.append(h('button', { class: 'btn sec', onclick: () => manualPack(post) }, 'Pack de publication manuelle'));
  const attest = () => row.append(h('button', { class: 'btn sec', onclick: () => {
    const link = ask("Collez le lien du post publié à la main (https://…)");
    if (link) act(post, 'attest_manual', { permalink: link });
  } }, "J'ai publié à la main"));
  switch (post.state) {
    case 'READY_FOR_REVIEW':
      box.append(dateEditor(post));
      row.append(
        h('button', { class: 'btn', disabled: blocked || null, onclick: async () => { await act(post, 'approve', { expected_hash: hash }); } }, 'Approuver cette version'),
        h('button', { class: 'btn sec', onclick: () => { const n = ask('Que faut-il corriger ?'); if (n) act(post, 'request_changes', { expected_hash: hash, note: n }); } }, 'À corriger…'),
        h('button', { class: 'btn bad', onclick: () => { const n = ask('Pourquoi refusez-vous ? (facultatif)') ?? null; if (n !== null) act(post, 'reject', { expected_hash: hash, note: n }); } }, 'Refuser'),
      );
      break;
    case 'APPROVED':
      row.append(
        h('button', { class: 'btn', disabled: !post.publish_at || null, onclick: () => act(post, 'schedule', { expected_hash: hash }) }, post.publish_at ? 'Programmer' : 'Choisissez une date'),
        h('button', { class: 'btn sec', onclick: () => act(post, 'revoke_approval', {}) }, "Retirer mon approbation"),
      );
      box.append(dateEditor(post)); manual(); manualSchedule(); attest();
      break;
    case 'SCHEDULED':
      row.append(
        h('button', { class: 'btn sec', onclick: () => act(post, 'unschedule') }, 'Ne plus programmer'),
        h('button', { class: 'btn sec', onclick: () => act(post, 'revoke_approval', {}) }, "Retirer mon approbation"),
        h('button', { class: 'btn bad', onclick: () => { if (confirm('Annuler définitivement cette publication ?')) act(post, 'cancel', {}); } }, 'Annuler'),
      );
      manual(); manualSchedule(); attest();
      if (post.publication?.manual_cancel_required) row.append(h('button', { class: 'btn', onclick: () => act(post, 'confirm_manual_cancel') }, "J'ai supprimé la copie chez Meta"));
      break;
    case 'ERROR':
      row.append(h('button', { class: 'btn', onclick: () => act(post, 'retry') }, 'Réessayer'));
      manual(); attest();
      break;
    case 'PUBLICATION_UNKNOWN':
      row.append(
        h('button', { class: 'btn', onclick: () => { const l = ask('Le post existe sur la page. Collez son lien (https://…)'); if (l) act(post, 'reconcile', { outcome: 'published', permalink: l }); } }, "C'est publié (lien)"),
        h('button', { class: 'btn sec', onclick: () => { if (confirm("Confirmez-vous que RIEN n'a été publié ? Nordla pourra réessayer.")) act(post, 'reconcile', { outcome: 'not_published' }); } }, "Rien n'est publié"),
      );
      break;
    case 'PUBLISHED':
      if (post.publication?.mode === 'MANUAL') row.append(h('button', { class: 'btn', onclick: () => act(post, 'verify_manual') }, "J'ai vérifié le post en ligne"));
      break;
    case 'NEEDS_CHANGES': case 'REJECTED': case 'DRAFT':
      row.append(h('span', { class: 'empty' }, 'En attente de correction côté création.'));
      break;
    default: break;
  }
  box.append(row);
  return box;
}

async function manualPack(post) {
  const pack = await api(`/api/posts/${post.id}/export`);
  const dlg = h('div', { class: 'card' },
    h('h3', {}, 'Publier à la main'),
    h('p', {}, `À publier sur ${PLATFORM[pack.platform]} — ${fmtWhen(pack.when_brussels)} (heure de Belgique).`),
    pack.approved ? h('div', { class: 'alert ok' }, 'Cette version est approuvée.') : h('div', { class: 'alert bad' }, "Cette version n'est PAS approuvée : ne la publiez pas."),
    h('label', {}, 'Texte à coller tel quel'), h('textarea', { rows: 8, readonly: true }, pack.caption_full),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: async () => { await navigator.clipboard?.writeText(pack.caption_full); say('Texte copié.'); } }, 'Copier le texte'),
      pack.asset ? h('button', { class: 'btn sec', onclick: async () => {
        const r = await fetch(pack.asset.download, { headers: { 'x-social-token': TOKEN } });
        if (!r.ok) return say("Fichier indisponible ou modifié depuis l'approbation.", 'bad');
        const a = h('a', { href: URL.createObjectURL(await r.blob()), download: `habb-${post.platform}-${post.id.slice(5, 13)}.${pack.asset.content_type.split('/')[1].replace('jpeg', 'jpg')}` }); document.body.append(a); a.click(); a.remove();
      } }, 'Télécharger le visuel') : null),
    h('ol', {}, pack.steps_fr.map((s) => h('li', {}, s))),
    h('div', { class: 'actions' }, h('button', { class: 'btn sec', onclick: () => { dlg.remove(); } }, 'Fermer')));
  document.querySelector(`[data-post="${post.id}"]`).after(dlg);
  dlg.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function historyOf(post) {
  const ACTION = { submit: 'Proposé', approve: 'Approuvé', reject: 'Refusé', request_changes: 'Correction demandée', revoke_approval: 'Approbation retirée', schedule: 'Programmé', unschedule: 'Déprogrammé', cancel: 'Annulé', retry: 'Nouvel essai demandé', claim: 'Publication lancée', mark_published: 'Publié', platform_scheduled: 'Programmé chez la plateforme', retry_later: 'Nouvel essai plus tard', mark_error: 'Erreur', mark_unknown: 'Résultat inconnu', mark_verified: 'Vérifié', verify_manual: 'Vérifié par vous', attest_manual: 'Publié à la main', mark_manual_schedule: 'Programmé à la main chez Meta', confirm_manual_cancel: 'Copie Meta supprimée', reconcile: 'Rapproché par vous', edit: 'Modifié', edit_notes: 'Note modifiée', annotate: 'Information', withdraw: 'Retiré' };
  return h('details', {}, h('summary', {}, `Historique (${post.history.length})`),
    h('ul', { class: 'hist' }, post.history.slice().reverse().map((e) => h('li', {}, `${new Date(e.at).toLocaleString('fr-BE', { timeZone: 'Europe/Brussels', dateStyle: 'short', timeStyle: 'short' })} — ${ACTION[e.action] ?? e.action} (${e.actor.role === 'owner' ? 'vous' : e.actor.id})${e.note ? ` : ${e.note}` : ''}${e.detail?.approval_invalidated ? ' — approbation annulée' : ''}`))));
}

const section = (title, posts, opts) => [h('h2', {}, `${title} (${posts.length})`), ...(posts.length ? posts.map((p) => postCard(p, opts)) : [h('div', { class: 'empty' }, 'Rien ici.')])];
const byDate = (a, b) => (a.publish_at ?? 'z').localeCompare(b.publish_at ?? 'z');

const VIEWS = {
  review() {
    const P = STATE.posts;
    return [
      ...section('À approuver, refuser ou corriger', P.filter((p) => p.state === 'READY_FOR_REVIEW').sort(byDate)),
      ...section('En attente de correction côté création', P.filter((p) => ['NEEDS_CHANGES', 'REJECTED', 'DRAFT'].includes(p.state)).sort(byDate), { compact: true }),
    ];
  },
  calendar() {
    const c = STATE.calendar;
    const out = [h('div', { class: 'meta' }, [
      ['programmable', 'Approuvés'], ['awaiting_approval', 'À approuver'], ['needs_correction', 'À corriger'], ['missing_asset', 'Visuels manquants'], ['published', 'Publiés'],
    ].map(([k, label]) => h('span', { class: 'pill' }, `${label} : ${STATE.counts[k]}`)))];
    for (const d of c.days) {
      out.push(h('div', { class: 'day' }, h('h3', {}, `${d.weekday} ${new Date(`${d.date}T12:00:00`).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' })}`),
        d.entries.length ? d.entries.map((e) => h('div', { class: 'entry' }, h('strong', {}, e.time), `${PLATFORM[e.platform]} · ${FORMAT[e.format]} · ${e.subject}`, h('span', { class: `pill ${e.bucket === 'programmable' || e.bucket === 'published' ? 'ok' : e.bucket === 'awaiting_approval' ? 'warn' : 'bad'}` }, STATE.posts.find((p) => p.id === e.post_id).state_label))) : h('div', { class: 'meta' }, '—')));
    }
    const undated = STATE.posts.filter((p) => !p.publish_at && !['CANCELLED'].includes(p.state));
    if (undated.length) out.push(...section('Sans date', undated, { compact: true }));
    return out;
  },
  scheduled() { return section('Programmés et en cours', STATE.posts.filter((p) => ['APPROVED', 'SCHEDULED', 'PUBLISHING', 'ERROR', 'PUBLICATION_UNKNOWN'].includes(p.state)).sort(byDate)); },
  published() { return section('Publiés', STATE.posts.filter((p) => ['PUBLISHED', 'VERIFIED'].includes(p.state)).sort((a, b) => byDate(b, a))); },
  connections() {
    const cards = STATE.connections.map((c) => h('article', { class: 'card' },
      h('h3', {}, c.platform === 'instagram' ? 'Instagram' : 'Facebook (Page)'),
      h('div', { class: 'meta' }, h('span', { class: `pill ${c.connected ? (c.mode === 'LIVE' ? 'ok' : 'bad') : 'warn'}` }, !c.connected ? 'Non connecté' : c.mode === 'LIVE' ? 'Connecté (réel)' : 'SIMULATION'),
        h('span', { class: 'pill' }, c.state === 'NOT_CONFIGURED' ? 'Aucun jeton' : c.state === 'EXPIRED' ? 'Jeton EXPIRÉ' : c.state === 'EXPIRES_SOON' ? `Jeton : ${c.days_left} j restants` : c.days_left != null ? `Jeton : ${c.days_left} j` : 'Expiration inconnue')),
      c.capabilities ? h('p', {}, c.capabilities.native_scheduling ? "Programmation faite par la plateforme : la publication part même si Nordla est éteint." : "Nordla publie à l'heure prévue : Nordla doit être allumé et joignable à ce moment-là.") : h('p', {}, 'Publication à la main avec le pack manuel.')));
    const check = h('button', { class: 'btn sec', onclick: async () => {
      try { const r = await api('/api/connections/check', { method: 'POST' }); say(r.results.length ? r.results.map((x) => `${PLATFORM[x.platform]} : ${x.ok ? 'OK' : `PROBLÈME (${x.reason})`}`).join(' · ') : 'Aucune connexion à tester.', r.results.every((x) => x.ok) ? 'ok' : 'bad'); } catch (e) { say(e.message, 'bad'); }
    } }, 'Tester les connexions maintenant');
    return [h('h2', {}, 'Connexions'), ...cards, h('div', { class: 'actions' }, check), h('p', { class: 'meta' }, "Le test lit le compte en direct. Il ne publie rien. Aucun jeton n'est affiché."),
      h('h2', {}, 'Plan de secours'), h('p', {}, "Si une connexion tombe (réseau, jeton expiré) : ouvrez le post approuvé → « Pack de publication manuelle » → publiez ou programmez depuis Meta Business Suite → revenez coller le lien. Rien n'est perdu et chaque étape reste dans l'historique.")];
  },
};

function renderTabs() {
  const n = (k) => STATE?.counts[k] ?? 0;
  const tabs = [['review', 'À examiner', STATE ? STATE.posts.filter((p) => p.state === 'READY_FOR_REVIEW').length : 0], ['calendar', 'Calendrier', 0], ['scheduled', 'Programmés', 0], ['published', 'Publiés', 0], ['connections', 'Connexions', 0]];
  void n;
  const nav = $('#tabs'); nav.replaceChildren(...tabs.map(([k, label, count]) => h('button', { 'aria-current': TAB === k ? 'true' : 'false', onclick: () => { TAB = k; render(); } }, label, count ? h('span', { class: 'badge' }, count) : null)));
}
function render() {
  renderTabs(); renderBanner();
  view.replaceChildren(...(STATE ? VIEWS[TAB]() : [h('div', { class: 'empty' }, 'Chargement…')]));
}
async function load() {
  try { STATE = await api('/api/state'); render(); } catch (e) { view.replaceChildren(h('div', { class: 'alert bad' }, e.message)); if (e.fatal) askToken(); }
}
function askToken() {
  const input = h('input', { type: 'password', placeholder: "Jeton d'accès", autocomplete: 'off' });
  view.append(h('div', { class: 'card' }, h('label', {}, "Collez votre jeton d'accès"), input, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { TOKEN = input.value.trim(); sessionStorage.setItem('social_token', TOKEN); load(); } }, 'Entrer'))));
}

const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromHash) { sessionStorage.setItem('social_token', fromHash); history.replaceState(null, '', location.pathname); }
TOKEN = sessionStorage.getItem('social_token') ?? '';
$('#refresh').addEventListener('click', load);
renderTabs();
if (TOKEN) load(); else askToken();
setInterval(() => { if (TOKEN && document.visibilityState === 'visible' && !document.querySelector('details[open], input:focus, textarea:focus')) load(); }, 60_000);
