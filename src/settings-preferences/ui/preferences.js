// Paramètres › Préférences: three rubrics (Langue, Format régional, Vues par défaut). List on the left and detail on the right on a computer; on a phone the list, then the detail with "Retour".
// Everything personal comes from GET /api/preferences (the SESSION's own preferences: no id of a person ever travels). All server text is inserted with textContent.
// The page speaks the language the person saved (FR / NL / EN); with no saved choice it is French, as before. The regional preview uses the SAME formatter module as Stock / Achats.
const { h, csrf, shell, guard, app } = window.NordlaShell;
// Own request helper: the shared one only knows GET and POST, and this page also needs PUT / PATCH / DELETE. It never throws: no answer = status 0.
const api = async (path, body, method) => {
  const m = method ?? (body !== undefined ? 'POST' : 'GET');
  try {
    const r = await fetch(path, { method: m, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(m !== 'GET' ? { 'x-nordla-csrf': csrf() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* empty or non-JSON body */ }
    return { ok: r.ok, status: r.status, json };
  } catch { return { ok: false, status: 0, json: null }; }
};

const T = {
  fr: {
    title: 'Préférences', crumb: 'Paramètres', sectionNames: { language: 'Langue', region: 'Format régional', views: 'Vues par défaut' },
    personal: 'Réglages personnels', personalText: 'Ces réglages ne concernent que votre compte, pour ce commerce. Ils ne changent aucun droit d’accès et les autres membres ne les voient pas.',
    back: 'Retour', save: 'Enregistrer', saving: 'Enregistrement…', cancel: 'Annuler', unavailable: 'Cette page est indisponible pour le moment.',
    saved: 'Réglage enregistré.', netErr: 'Le serveur ne répond pas : rien n’a été enregistré.', invalid: 'Valeur refusée : rien n’a été enregistré.', refused: (s) => `Action refusée (${s}). Rien n’a été enregistré.`, leave: 'Des modifications ne sont pas enregistrées. Quitter sans les enregistrer ?',
    langTitle: 'Langue de l’interface', langIntro: 'Langue dans laquelle Nordla s’affiche pour vous. Elle ne change pas la langue des factures, des communications aux clients ni des contenus Marketing : ceux-ci suivent leurs propres réglages ou briefs.',
    langDefault: 'Langue par défaut (Français)', langDefaultHelp: 'La langue utilisée jusqu’ici par Nordla.', where: 'Où ce choix s’applique', module: 'Module', langCol: 'Langue', regionCol: 'Format régional',
    st: { APPLIED: 'Appliqué', KEPT: 'Reste en français', OWN: 'Réglage propre, non relié', NONE: 'Format conservé' },
    regionTitle: 'Format régional', regionIntro: 'Présentation des dates, des heures, des nombres et des montants. Il est indépendant de la langue de l’interface : vous pouvez avoir l’interface en anglais avec le format belge.',
    regionDefault: 'Format par défaut (Français (Belgique))', regionDefaultHelp: 'Le format utilisé jusqu’ici par Nordla.', preview: 'Aperçu en direct', pDate: 'Date', pTime: 'Heure', pNumber: 'Nombre', pMoney: 'Montant',
    fixed: (c, z) => `Devise du commerce : ${c} · Fuseau horaire : ${z} (réglés dans Général). Le format régional ne change que la présentation : aucun montant n’est converti, l’heure de référence et les périodes de calcul des rapports restent celles du commerce.`,
    fixedUnset: 'La devise et le fuseau horaire du commerce ne sont pas encore renseignés dans Général : l’aperçu utilise EUR et Europe/Brussels. Aucun montant n’est converti.',
    viewsTitle: 'Vues par défaut', viewsIntro: 'Vues enregistrées depuis les écrans de travail. Elles sont personnelles, rattachées à votre compte, à ce commerce et à l’écran. Elles ne donnent aucun droit supplémentaire.',
    viewsEmpty: 'Aucune vue enregistrée. Dans Stock / Achats › Produits, faites une recherche puis choisissez « Enregistrer cette vue ».', merchant: 'Commerce', screen: 'Écran', filters: 'Filtres', noFilter: 'aucun',
    open: 'Ouvrir', rename: 'Renommer', renamePrompt: 'Nouveau nom de la vue', unsetDefault: 'Retirer le défaut', setDefault: 'Définir par défaut', fav: 'Ajouter aux favoris', unfav: 'Retirer le favori', del: 'Supprimer', delConfirm: (n) => `Supprimer la vue « ${n} » ?`,
    bDefault: 'Par défaut', bFav: 'Favori', bUnavail: 'Ne s’applique plus', nameTaken: 'Une vue porte déjà ce nom pour cet écran.', viewDone: 'Vue mise à jour.', viewGone: 'Vue supprimée.',
    reasons: { FILTER_REMOVED: 'l’un de ses filtres n’existe plus', MODULE_INACCESSIBLE: 'ce module n’est plus accessible avec votre rôle', MODULE_REMOVED: 'cet écran n’existe plus' }, reasonLead: 'Cette vue ne s’applique plus :', stateDefault: 'Par défaut', stateViews: (n) => (n === 0 ? 'Aucune' : `${n} vue${n > 1 ? 's' : ''}`),
  },
  nl: {
    title: 'Voorkeuren', crumb: 'Instellingen', sectionNames: { language: 'Taal', region: 'Regionaal formaat', views: 'Standaardweergaven' },
    personal: 'Persoonlijke instellingen', personalText: 'Deze instellingen gelden alleen voor uw account, voor deze winkel. Ze wijzigen geen toegangsrechten en andere leden zien ze niet.',
    back: 'Terug', save: 'Opslaan', saving: 'Bezig met opslaan…', cancel: 'Annuleren', unavailable: 'Deze pagina is momenteel niet beschikbaar.',
    saved: 'Instelling opgeslagen.', netErr: 'De server antwoordt niet: er is niets opgeslagen.', invalid: 'Waarde geweigerd: er is niets opgeslagen.', refused: (s) => `Actie geweigerd (${s}). Er is niets opgeslagen.`, leave: 'Er zijn niet-opgeslagen wijzigingen. Toch verlaten?',
    langTitle: 'Taal van de interface', langIntro: 'De taal waarin Nordla voor u wordt weergegeven. Ze wijzigt niet de taal van facturen, klantcommunicatie of marketinginhoud: die volgen hun eigen instellingen of briefs.',
    langDefault: 'Standaardtaal (Frans)', langDefaultHelp: 'De taal die Nordla tot nu toe gebruikte.', where: 'Waar deze keuze geldt', module: 'Module', langCol: 'Taal', regionCol: 'Regionaal formaat',
    st: { APPLIED: 'Toegepast', KEPT: 'Blijft Frans', OWN: 'Eigen instelling, niet gekoppeld', NONE: 'Formaat behouden' },
    regionTitle: 'Regionaal formaat', regionIntro: 'Weergave van datums, tijden, getallen en bedragen. Het staat los van de interfacetaal: u kunt de interface in het Engels hebben met het Belgische formaat.',
    regionDefault: 'Standaardformaat (Frans (België))', regionDefaultHelp: 'Het formaat dat Nordla tot nu toe gebruikte.', preview: 'Live voorbeeld', pDate: 'Datum', pTime: 'Tijd', pNumber: 'Getal', pMoney: 'Bedrag',
    fixed: (c, z) => `Munteenheid van de winkel: ${c} · Tijdzone: ${z} (ingesteld in Algemeen). Het regionale formaat wijzigt alleen de weergave: geen enkel bedrag wordt omgerekend, het referentietijdstip en de rapportageperiodes blijven die van de winkel.`,
    fixedUnset: 'Munteenheid en tijdzone van de winkel zijn nog niet ingevuld in Algemeen: het voorbeeld gebruikt EUR en Europe/Brussels. Er wordt geen bedrag omgerekend.',
    viewsTitle: 'Standaardweergaven', viewsIntro: 'Weergaven die u in werkschermen hebt opgeslagen. Ze zijn persoonlijk en gekoppeld aan uw account, deze winkel en het scherm. Ze geven geen extra rechten.',
    viewsEmpty: 'Geen opgeslagen weergaven. Zoek in Voorraad / Inkoop › Producten en kies « Deze weergave opslaan ».', merchant: 'Winkel', screen: 'Scherm', filters: 'Filters', noFilter: 'geen',
    open: 'Openen', rename: 'Hernoemen', renamePrompt: 'Nieuwe naam van de weergave', unsetDefault: 'Standaard verwijderen', setDefault: 'Als standaard instellen', fav: 'Aan favorieten toevoegen', unfav: 'Favoriet verwijderen', del: 'Verwijderen', delConfirm: (n) => `De weergave « ${n} » verwijderen?`,
    bDefault: 'Standaard', bFav: 'Favoriet', bUnavail: 'Niet meer van toepassing', nameTaken: 'Er bestaat al een weergave met deze naam voor dit scherm.', viewDone: 'Weergave bijgewerkt.', viewGone: 'Weergave verwijderd.',
    reasons: { FILTER_REMOVED: 'een van de filters bestaat niet meer', MODULE_INACCESSIBLE: 'deze module is niet meer toegankelijk met uw rol', MODULE_REMOVED: 'dit scherm bestaat niet meer' }, reasonLead: 'Deze weergave is niet meer van toepassing:', stateDefault: 'Standaard', stateViews: (n) => (n === 0 ? 'Geen' : `${n} weergave${n > 1 ? 's' : ''}`),
  },
  en: {
    title: 'Preferences', crumb: 'Settings', sectionNames: { language: 'Language', region: 'Regional format', views: 'Default views' },
    personal: 'Personal settings', personalText: 'These settings apply to your account only, for this business. They change no access right and other members cannot see them.',
    back: 'Back', save: 'Save', saving: 'Saving…', cancel: 'Cancel', unavailable: 'This page is not available right now.',
    saved: 'Setting saved.', netErr: 'The server is not answering: nothing was saved.', invalid: 'Value refused: nothing was saved.', refused: (s) => `Action refused (${s}). Nothing was saved.`, leave: 'You have unsaved changes. Leave without saving?',
    langTitle: 'Interface language', langIntro: 'The language Nordla is displayed in for you. It does not change the language of invoices, customer communications or Marketing content: those follow their own settings or briefs.',
    langDefault: 'Default language (French)', langDefaultHelp: 'The language Nordla has used so far.', where: 'Where this choice applies', module: 'Module', langCol: 'Language', regionCol: 'Regional format',
    st: { APPLIED: 'Applied', KEPT: 'Stays in French', OWN: 'Own setting, not linked', NONE: 'Format kept' },
    regionTitle: 'Regional format', regionIntro: 'How dates, times, numbers and amounts are displayed. It is independent of the interface language: you can have the interface in English with the Belgian format.',
    regionDefault: 'Default format (French (Belgium))', regionDefaultHelp: 'The format Nordla has used so far.', preview: 'Live preview', pDate: 'Date', pTime: 'Time', pNumber: 'Number', pMoney: 'Amount',
    fixed: (c, z) => `Business currency: ${c} · Time zone: ${z} (set in General). The regional format only changes presentation: no amount is converted, and the reference time and reporting periods stay those of the business.`,
    fixedUnset: 'The business currency and time zone are not set in General yet: the preview uses EUR and Europe/Brussels. No amount is converted.',
    viewsTitle: 'Default views', viewsIntro: 'Views saved from the working screens. They are personal, tied to your account, this business and the screen. They give no extra right.',
    viewsEmpty: 'No saved view. In Stock / Purchasing › Products, run a search then choose “Save this view”.', merchant: 'Business', screen: 'Screen', filters: 'Filters', noFilter: 'none',
    open: 'Open', rename: 'Rename', renamePrompt: 'New name for the view', unsetDefault: 'Remove default', setDefault: 'Set as default', fav: 'Add to favourites', unfav: 'Remove favourite', del: 'Delete', delConfirm: (n) => `Delete the view “${n}”?`,
    bDefault: 'Default', bFav: 'Favourite', bUnavail: 'No longer applies', nameTaken: 'A view with this name already exists for this screen.', viewDone: 'View updated.', viewGone: 'View deleted.',
    reasons: { FILTER_REMOVED: 'one of its filters no longer exists', MODULE_INACCESSIBLE: 'this module is no longer accessible with your role', MODULE_REMOVED: 'this screen no longer exists' }, reasonLead: 'This view no longer applies:', stateDefault: 'Default', stateViews: (n) => (n === 0 ? 'None' : `${n} view${n > 1 ? 's' : ''}`),
  },
};

const SLUG = { language: 'langue', region: 'format-regional', views: 'vues' };
const OF = Object.fromEntries(Object.entries(SLUG).map(([k, v]) => [v, k]));
const ORDER = ['language', 'region', 'views'];
const NS = 'http://www.w3.org/2000/svg';
const icon = (paths) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cx-ico pf-row-ico'); s.setAttribute('aria-hidden', 'true'); for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
const ICON = { language: ['M4 5h9', 'M8.5 3v2', 'M6 5c1 4 3 6 6 7', 'M12 5c-1 4-3 6-7 8', 'M12 20l4-9 4 9', 'M13.5 17h5'], region: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'], views: ['M3 5h18v14H3z', 'M3 10h18', 'M9 10v9'] };
const wide = () => window.matchMedia('(min-width: 900px)').matches;

let ov = null; let L = T.fr; let shellData = null; let current = null; let formatLib = null; let draft = null; let flash = null; let saving = false;
const detail = h('section', { class: 'cx-detail', id: 'pf-detail' }); const listBox = h('div', { class: 'cx-list' });
const dirty = () => draft != null && ((current === 'language' && draft.language !== (ov.language.saved ?? null)) || (current === 'region' && draft.region !== (ov.region.saved ?? null)));
const leaveOk = () => !dirty() || window.confirm(L.leave);
window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

const langLabel = (id) => ov.languages.find((l) => l.id === id)?.label ?? id;
const regionLabel = (id) => ov.regions.find((r) => r.id === id)?.label ?? id;
const msgNode = (m) => h('div', { class: `pf-msg ${m.tone}`, role: m.tone === 'err' ? 'alert' : 'status', text: m.text });
const head = (title, intro) => h('div', { class: 'pf-head' }, h('h2', { text: title }), h('p', { text: intro }));
const personal = () => h('div', { class: 'pf-personal' }, h('span', {}, h('strong', { text: L.personal }), L.personalText));

function renderList() {
  const stateOf = { language: [langLabel(ov.language.value), ov.language.saved ? 'ok' : 'todo'], region: [ov.region.saved ? regionLabel(ov.region.value) : `${L.stateDefault}`, ov.region.saved ? 'ok' : 'todo'], views: [L.stateViews(ov.views.length), ov.views.length ? 'ok' : 'todo'] };
  listBox.replaceChildren(...ORDER.map((id) => h('a', { class: 'cx-row', href: `/settings/preferences/${SLUG[id]}`, 'aria-current': current === id ? 'true' : null, on: { click: (e) => { e.preventDefault(); go(id); } } },
    icon(ICON[id]), h('span', { class: 'cx-row-name', text: L.sectionNames[id] }), h('span', { class: 'pf-state', 'data-tone': stateOf[id][1], text: stateOf[id][0] }))));
}

function applyTable(kind) {
  const col = kind === 'language' ? 'language' : 'region';
  return h('div', {}, h('h3', { class: 'pf-h3', text: L.where }), h('table', { class: 'pf-table' }, h('thead', {}, h('tr', {}, h('th', { text: L.module }), h('th', { text: kind === 'language' ? L.langCol : L.regionCol }))),
    h('tbody', {}, ov.applies.map((a) => h('tr', {}, h('td', { text: a.label }), h('td', {}, h('span', { class: 'pf-state', 'data-tone': a[col] === 'APPLIED' ? 'ok' : a[col] === 'OWN' ? 'wait' : 'todo', text: L.st[a[col]] })))))));
}

async function savePrefs(patch) {
  saving = true; draw();
  let r; try { r = await api('/api/preferences', patch, 'PUT'); } catch { r = { ok: false, status: 0, json: null }; }
  saving = false;
  if (guard(r)) return;
  if (r.ok) { ov = { ...ov, language: r.json.language, region: r.json.region, merchant: r.json.merchant ?? ov.merchant }; L = T[ov.language.value] ?? T.fr; document.documentElement.lang = ov.language.value; draft = null; flash = { tone: 'ok', text: L.saved }; await refreshShell(); renderPage(); return; }
  const code = r.json?.error?.code;
  flash = { tone: 'err', text: r.status === 0 ? L.netErr : code === 'VALIDATION' ? L.invalid : L.refused(r.status) }; draw();
}

const choice = (value, checked, label, help, onPick) => h('label', { class: 'pf-choice', 'data-on': String(checked) }, h('input', { type: 'radio', name: 'pf-choice', value, checked, on: { change: onPick } }), h('span', {}, label, help ? h('small', { text: help }) : null));
const actions = (onSave, onCancel) => h('div', { class: 'pf-bar' }, h('button', { class: 'cx-btn ghost', type: 'button', text: L.cancel, disabled: saving || !dirty(), on: { click: onCancel } }), h('button', { class: 'cx-btn pf-save', type: 'button', text: saving ? L.saving : L.save, disabled: saving || !dirty(), on: { click: onSave } }));

function languagePane() {
  draft ??= { language: ov.language.saved ?? null };
  const pick = (v) => () => { draft.language = v; draw(); };
  return [head(L.langTitle, L.langIntro), personal(),
    h('div', { class: 'pf-choices', role: 'radiogroup', 'aria-label': L.langTitle },
      ov.languages.map((l) => choice(l.id, draft.language === l.id, l.label, null, pick(l.id))),
      choice('', draft.language === null, L.langDefault, L.langDefaultHelp, pick(null))),
    actions(() => savePrefs({ language: draft.language }), () => { draft = null; draw(); }), applyTable('language')];
}

function previewBox() {
  const region = draft.region ?? ov.region.default; const m = ov.merchant ?? {};
  const box = h('div', { class: 'pf-preview', 'aria-live': 'polite' });
  if (!formatLib) { box.append(h('p', { class: 'pf-empty', text: '…' })); return box; }
  const f = formatLib.createFormatter({ region, timeZone: m.timezone ?? null, currency: m.currency ?? null }); const p = f.preview();
  box.append(h('dl', {}, h('dt', { text: L.pDate }), h('dd', { text: p.date }), h('dt', { text: L.pTime }), h('dd', { text: p.time }), h('dt', { text: L.pNumber }), h('dd', { text: p.number }), h('dt', { text: L.pMoney }), h('dd', { text: p.money })));
  return box;
}
function regionPane() {
  draft ??= { region: ov.region.saved ?? null };
  const pick = (v) => () => { draft.region = v; draw(); }; const m = ov.merchant ?? {};
  return [head(L.regionTitle, L.regionIntro), personal(),
    h('div', { class: 'pf-choices', role: 'radiogroup', 'aria-label': L.regionTitle },
      ov.regions.map((r) => choice(r.id, draft.region === r.id, r.label, null, pick(r.id))),
      choice('', draft.region === null, L.regionDefault, L.regionDefaultHelp, pick(null))),
    h('h3', { class: 'pf-h3', text: L.preview }), previewBox(),
    h('p', { class: 'pf-note', text: m.currency && m.timezone ? L.fixed(m.currency, m.timezone) : L.fixedUnset }),
    actions(() => savePrefs({ region: draft.region }), () => { draft = null; draw(); }), applyTable('region')];
}

async function viewAction(v, patch, okText) {
  const r = await api(`/api/preferences/views/${v.id}`, patch, 'PATCH'); if (guard(r)) return;
  if (r.ok) { flash = { tone: 'ok', text: okText }; await reloadViews(); return; }
  flash = { tone: 'err', text: r.status === 0 ? L.netErr : r.json?.error?.code === 'NAME_TAKEN' ? L.nameTaken : L.refused(r.status) }; draw();
}
async function reloadViews() { const r = await api('/api/preferences'); if (r.ok) ov = { ...ov, views: r.json.views }; renderList(); draw(); }
function viewCard(v) {
  const merchant = shellData?.merchant?.name ?? '';
  const btn = (text, fn, ghost = true) => h('button', { class: `cx-btn${ghost ? ' ghost' : ''}`, type: 'button', text, on: { click: fn } });
  const filters = Object.entries(v.filters ?? {}).map(([k, val]) => `${k === 'q' ? '🔍' : k} ${val}`).join(' · ');
  return h('article', { class: 'pf-view' }, h('h3', { text: v.name }),
    h('div', { class: 'pf-view-badges' }, v.isDefault ? h('span', { class: 'pf-state', 'data-tone': 'ok', text: L.bDefault }) : null, v.isFavorite ? h('span', { class: 'pf-state', 'data-tone': 'wait', text: `★ ${L.bFav}` }) : null, v.status !== 'OK' ? h('span', { class: 'pf-state', 'data-tone': 'bad', text: L.bUnavail }) : null),
    h('p', { class: 'pf-view-meta', text: `${L.merchant} : ${merchant} · ${v.moduleLabel} › ${v.screenLabel ?? ''} · ${L.filters} : ${filters || L.noFilter}` }),
    v.status !== 'OK' ? h('p', { class: 'pf-view-meta', text: `${L.reasonLead} ${L.reasons[v.reason] ?? ''}` }) : null,
    h('div', { class: 'pf-view-actions' },
      v.status === 'OK' && v.href ? h('a', { class: 'cx-btn', href: `${v.href.replace(/#.*$/, '')}?view=${encodeURIComponent(v.id)}`, text: L.open }) : null,
      btn(L.rename, () => { const n = window.prompt(L.renamePrompt, v.name); if (n != null && n.trim() && n.trim() !== v.name) viewAction(v, { name: n.trim() }, L.viewDone); }),
      v.isDefault ? btn(L.unsetDefault, () => viewAction(v, { isDefault: false }, L.viewDone)) : (v.status === 'OK' ? btn(L.setDefault, () => viewAction(v, { isDefault: true }, L.viewDone)) : null),
      btn(v.isFavorite ? L.unfav : L.fav, () => viewAction(v, { isFavorite: !v.isFavorite }, L.viewDone)),
      btn(L.del, async () => { if (!window.confirm(L.delConfirm(v.name))) return; const r = await api(`/api/preferences/views/${v.id}`, undefined, 'DELETE'); if (guard(r)) return; flash = r.ok ? { tone: 'ok', text: L.viewGone } : { tone: 'err', text: r.status === 0 ? L.netErr : L.refused(r.status) }; await reloadViews(); })));
}
const viewsPane = () => [head(L.viewsTitle, L.viewsIntro), personal(), ov.views.length ? h('div', {}, ov.views.map(viewCard)) : h('p', { class: 'pf-empty', text: L.viewsEmpty })];

function draw() {
  if (!current) return;
  const body = current === 'language' ? languagePane() : current === 'region' ? regionPane() : viewsPane();
  detail.replaceChildren(...[!wide() ? h('button', { class: 'cx-back', type: 'button', text: `‹ ${L.back}`, on: { click: () => go(null) } }) : null, flash ? msgNode(flash) : null, ...body].filter(Boolean));
  renderList(); layout(); document.title = `Nordla AI · ${L.crumb} · ${L.sectionNames[current]}`;
}
function layout() { const split = document.getElementById('pf-split'); if (!split) return; const showDetail = wide() || current; listBox.hidden = !wide() && !!current; detail.hidden = !showDetail; }
async function go(id) {
  if (id === null) { if (!leaveOk()) return; draft = null; current = null; history.pushState(null, '', '/settings/preferences'); renderList(); layout(); window.scrollTo(0, 0); return; }
  if (id !== current && !leaveOk()) return; draft = null; flash = null; current = id; history.pushState(null, '', `/settings/preferences/${SLUG[id]}`); draw(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => { if (!ov) return; draft = null; flash = null; const slug = location.pathname.split('/')[3]; current = OF[slug] ?? null; if (current) draw(); else { renderList(); layout(); } });
window.matchMedia('(min-width: 900px)').addEventListener('change', () => { if (!ov) return; if (wide() && !current) { current = 'language'; draw(); } else layout(); });

async function refreshShell() { const r = await api('/api/preferences'); if (r.ok && r.json.shell) shellData = r.json.shell; }
function renderPage() {
  const split = h('div', { class: 'cx-split', id: 'pf-split' }, h('div', {}, listBox), detail);
  app.replaceChildren(shell(shellData, 'settings', [h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/settings', text: L.crumb }), ' / ', h('strong', { text: L.title })), h('h1', { text: L.title }), split]));
  renderList(); if (!current && wide()) current = 'language'; if (current) draw(); else layout();
}

async function start() {
  const r = await api('/api/preferences'); if (guard(r)) return;
  if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: T.fr.title }), h('p', { class: 'cx-msg err', text: T.fr.unavailable })));
  ov = r.json; L = T[ov.language.value] ?? T.fr; document.documentElement.lang = ov.language.value;
  shellData = r.json.shell ?? { nav: [{ id: 'settings', label: L.crumb, href: '/settings' }], merchant: null, environment: null };
  try { formatLib = await import('/preferences-assets/format.js'); } catch { formatLib = null; } // the preview is the one part that needs the shared formatter; the rest works without it
  current = OF[location.pathname.split('/')[3]] ?? null;
  renderPage();
}
start();
