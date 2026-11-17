// Paramètres › Général: the six rubrics (list on the left, form on the right; on a phone the list, then the form with "Retour").
// Everything comes from GET /api/general (+ one GET per rubric): the option lists, the values, the versions. All server text is inserted with textContent.
// A form keeps a DRAFT; "Enregistrer" is disabled while nothing changed or while saving; "Annuler" restores the saved value; leaving with changes asks first.
(() => {
  'use strict';
  const { h, api, shell, guard, app } = window.NordlaShell;
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (paths) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cx-ico gn-row-ico'); s.setAttribute('aria-hidden', 'true'); for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
  const ICON = {
    profile: ['M3 9l1.5-5h15L21 9', 'M4 9v11h16V9', 'M9 20v-6h6v6'], activity: ['M3 12l9-9h9v9l-9 9-9-9z', 'M16 8h.01'], establishments: ['M5 5h14v15H5z', 'M5 10h14', 'M9 3v4', 'M15 3v4'],
    selling_modes: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'], regional: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'], objectives: ['M12 21V4', 'M12 4h8l-2 3 2 3h-8'], legal: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h7', 'M9 17h7'],
  };
  const SLUG = { profile: 'profil', activity: 'activite', establishments: 'etablissements', selling_modes: 'modes-de-vente', regional: 'devise-fuseau', legal: 'legal', objectives: 'objectifs' };
  const OF = Object.fromEntries(Object.entries(SLUG).map(([k, v]) => [v, k]));
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const getp = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setp = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); let c = o; for (const k of ks) { if (c[k] == null || typeof c[k] !== 'object') c[k] = {}; c = c[k]; } c[last] = v; };
  const ERRORS = { FORBIDDEN_ROLE: 'Votre rôle ne permet pas de modifier ces informations.', TENANT_MISMATCH: 'Cette page appartient à une autre boutique.', VALIDATION: 'Des champs sont invalides : rien n’a été enregistré.', CONFLICT: 'Ces informations ont été modifiées entre-temps : rien n’a été remplacé.', PRIMARY_REQUIRED: 'Désignez d’abord un autre établissement principal.', ARCHIVED: 'Un établissement archivé ne se modifie pas : restaurez-le d’abord.', NOT_FOUND: 'Élément introuvable.' };

  let ov = null; let opts = null; let shellData = null; let current = null; let cur = null; let flash = null; let placeSel = null;

  // ------------------------------------------------------------------ form engine
  function makeForm({ section, read, build, submit }) {
    const f = { section, draft: clone(read.data), saved: JSON.stringify(read.data), version: read.version, saving: false, slots: new Map(), editable: read.canWrite };
    f.dirty = () => JSON.stringify(f.draft) !== f.saved;
    f.touch = () => { if (f.saveBtn) f.saveBtn.disabled = !f.editable || f.saving || !f.dirty(); if (f.cancelBtn) f.cancelBtn.disabled = f.saving || !f.dirty(); };
    f.slot = (path) => { const p = h('p', { class: 'gn-error', role: 'alert', hidden: true }); (f.slots.get(path) ?? f.slots.set(path, []).get(path)).push(p); return p; };
    f.showErrors = (errors) => { for (const list of f.slots.values()) for (const p of list) { p.hidden = true; p.textContent = ''; const input = p.parentElement?.querySelector('[aria-invalid]'); if (input) input.removeAttribute('aria-invalid'); } let first = null;
      for (const [path, msg] of Object.entries(errors ?? {})) { for (const p of f.slots.get(path) ?? []) { p.hidden = false; p.textContent = msg; const el = p.parentElement?.querySelector('input,select,textarea'); if (el) { el.setAttribute('aria-invalid', 'true'); first ??= el; } } }
      first?.focus(); };
    f.node = null; f.rebuild = () => { const n = f.build(f); f.node.replaceWith(n); f.node = n; };
    f.cancel = () => { f.draft = JSON.parse(f.saved); f.rebuild(); };
    f.save = async () => {
      f.saving = true; f.touch(); f.saveBtn.textContent = 'Enregistrement…'; f.showErrors({});
      let r; try { r = await f.submit(f); } catch { r = { ok: false, status: 0, json: { error: { code: 'NETWORK' } } }; }
      f.saving = false; f.saveBtn.textContent = 'Enregistrer';
      if (guard(r)) return;
      if (r.ok) { f.saved = JSON.stringify(r.json.data); f.draft = clone(r.json.data); f.version = r.json.version ?? null; flash = { tone: 'ok', text: 'Modifications enregistrées.' }; refreshOverview().then(() => renderList()); f.rebuildAll?.(); return; }
      const code = r.json?.error?.code; f.touch();
      if (code === 'VALIDATION') { f.msg({ tone: 'err', text: ERRORS.VALIDATION }); f.showErrors(r.json.errors); return; }
      if (code === 'CONFLICT') { f.msg({ tone: 'err', text: ERRORS.CONFLICT, reload: r.json.current }); return; }
      f.msg({ tone: 'err', text: code === 'NETWORK' ? 'Le serveur ne répond pas : rien n’a été enregistré.' : (ERRORS[code] ?? `Action refusée (${r.status}).`) });
    };
    return f;
  }
  const field = (f, path, label, control, { optional = false, help = null } = {}) => h('div', { class: 'gn-field' }, h('label', { class: 'gn-label', text: label }, optional ? h('span', { class: 'gn-opt', text: ' (facultatif)' }) : null), h('div', { class: 'gn-control' }, control, help ? h('p', { class: 'gn-help', text: help }) : null, f.slot(path)));
  const input = (f, path, { type = 'text', placeholder = '', maxlength = 200, list = null, inputmode = null } = {}) => h('input', { class: 'gn-input', type, value: getp(f.draft, path) ?? '', placeholder, maxlength, list, inputmode, autocomplete: 'off', disabled: !f.editable, on: { input: (e) => { setp(f.draft, path, e.target.value); f.touch(); } } });
  const area = (f, path, { maxlength = 280 } = {}) => h('textarea', { class: 'gn-textarea', maxlength, disabled: !f.editable, on: { input: (e) => { setp(f.draft, path, e.target.value); f.touch(); } } }, getp(f.draft, path) ?? '');
  const select = (f, path, map, { empty = 'À renseigner', onchange = null } = {}) => { const v = getp(f.draft, path) ?? ''; const s = h('select', { class: 'gn-select', disabled: !f.editable, on: { change: (e) => { setp(f.draft, path, e.target.value || null); f.touch(); onchange?.(e.target.value); } } }, empty !== null ? h('option', { value: '', text: empty }) : null, Object.entries(map).map(([k, lab]) => h('option', { value: k, text: lab }))); s.value = v; return s; };
  const bar = (f, extra = []) => { f.saveBtn = h('button', { class: 'cx-btn gn-btn-save', type: 'button', text: 'Enregistrer', disabled: true, on: { click: () => f.save() } }); f.cancelBtn = h('button', { class: 'cx-btn ghost', type: 'button', text: 'Annuler', disabled: true, on: { click: () => f.cancel() } }); setTimeout(f.touch, 0); return h('div', { class: 'gn-bar' }, extra, f.editable ? [f.cancelBtn, f.saveBtn] : h('p', { class: 'gn-help', text: 'Lecture seule : votre rôle ne permet pas de modifier ces informations.' })); };
  const head = (title, sub) => h('div', { class: 'gn-head' }, h('h2', { text: title }), sub ? h('p', { text: sub }) : null);

  // chips: [{ value, label? }] with an "Ajouter" select; `labelled` values (and "other") carry an editable precision, required for "other"
  function chips(f, path, map, { labelled = [], addText = 'Ajouter…' } = {}) {
    const box = h('div', { class: 'gn-chips' });
    const draw = () => {
      const list = getp(f.draft, path) ?? []; box.replaceChildren();
      for (const [i, it] of list.entries()) box.append(h('span', { class: 'gn-chip' }, h('span', { text: map[it.value] ?? it.value }),
        it.value === 'other' || labelled.includes(it.value) ? h('input', { type: 'text', value: it.label ?? '', maxlength: 60, placeholder: it.value === 'other' ? 'Précisez (obligatoire)' : 'Précision (facultatif)', 'aria-label': `Précision pour ${map[it.value] ?? it.value}`, disabled: !f.editable, on: { input: (e) => { if (e.target.value.trim()) it.label = e.target.value; else delete it.label; f.touch(); } } }) : null,
        f.editable ? h('button', { class: 'gn-x', type: 'button', 'aria-label': `Retirer ${map[it.value] ?? it.value}`, text: '×', on: { click: () => { list.splice(i, 1); setp(f.draft, path, list); f.touch(); draw(); } } }) : null));
      const rest = Object.entries(map).filter(([k]) => !list.some((x) => x.value === k));
      if (f.editable && rest.length) { const s = h('select', { class: 'gn-select gn-add-select', 'aria-label': addText, on: { change: (e) => { if (!e.target.value) return; list.push({ value: e.target.value }); setp(f.draft, path, list); f.touch(); draw(); } } }, h('option', { value: '', text: `+ ${addText}` }), rest.map(([k, lab]) => h('option', { value: k, text: lab }))); box.append(s); }
      if (!list.length && !f.editable) box.append(h('span', { class: 'gn-help', text: 'À renseigner' }));
    };
    draw(); return box;
  }
  // checks: a list of checkboxes; "other" asks for its label
  function checks(f, path, map) {
    const box = h('div', { class: 'gn-checks' });
    const draw = () => {
      const list = getp(f.draft, path) ?? []; box.replaceChildren();
      for (const [k, lab] of Object.entries(map)) {
        const on = list.find((x) => x.value === k);
        box.append(h('label', { class: 'gn-check' }, h('input', { type: 'checkbox', checked: !!on, disabled: !f.editable, on: { change: (e) => { const l = getp(f.draft, path) ?? []; if (e.target.checked) l.push({ value: k }); else l.splice(l.findIndex((x) => x.value === k), 1); setp(f.draft, path, l); f.touch(); draw(); } } }), h('span', { text: lab }),
          on && k === 'other' ? h('input', { class: 'gn-input', type: 'text', value: on.label ?? '', maxlength: 60, placeholder: 'Précisez (obligatoire)', 'aria-label': 'Précision pour Autre', disabled: !f.editable, on: { input: (e) => { if (e.target.value.trim()) on.label = e.target.value; else delete on.label; f.touch(); } } }) : null));
      }
    };
    draw(); return box;
  }

  // ------------------------------------------------------------------ the six forms
  // featured offers: a short list of free labels (the catalogue is not required)
  function offersEditor(f) {
    const box = h('div'); const draw = () => { const list = f.draft.featured_offers ?? (f.draft.featured_offers = []); box.replaceChildren();
      list.forEach((o, i) => box.append(h('div', { class: 'gn-slot gn-mt' }, h('input', { class: 'gn-input', type: 'text', value: o.label ?? '', maxlength: 80, placeholder: 'Offre ou produit à mettre en avant', 'aria-label': 'Offre ' + (i + 1), disabled: !f.editable, on: { input: (e) => { o.label = e.target.value; f.touch(); } } }), f.editable ? h('button', { class: 'gn-x', type: 'button', 'aria-label': 'Retirer cette offre', text: '×', on: { click: () => { list.splice(i, 1); f.touch(); draw(); } } }) : null)));
      if (f.editable && list.length < 10) box.append(h('button', { class: 'gn-add', type: 'button', text: '+ Ajouter une offre', on: { click: () => { list.push({ label: '' }); f.touch(); draw(); } } })); if (!list.length && !f.editable) box.append(h('span', { class: 'gn-help', text: 'À renseigner' })); };
    draw(); return box;
  }
  const BUILD = {
    objectives: (f) => { const prio = h('div'); const drawPrio = () => { f.draft.priority ??= null; const p = f.draft.priority; prio.replaceChildren(...[h('select', { class: 'gn-select', disabled: !f.editable, on: { change: (e) => { f.draft.priority = e.target.value ? { value: e.target.value } : null; f.touch(); drawPrio(); } } }, h('option', { value: '', text: 'À renseigner' }), Object.entries(opts.priorities).map(([k, l]) => h('option', { value: k, text: l, selected: p?.value === k }))),
        p?.value === 'other' ? h('input', { class: 'gn-input gn-mt', type: 'text', value: p.label ?? '', maxlength: 80, placeholder: 'Précisez (obligatoire)', 'aria-label': 'Précision pour Autre', disabled: !f.editable, on: { input: (e) => { p.label = e.target.value; f.touch(); } } }) : null,
        p ? h('input', { class: 'gn-input gn-mt', type: 'text', value: p.note ?? '', maxlength: 200, placeholder: 'Précision (facultatif)', 'aria-label': 'Précision sur la priorité', disabled: !f.editable, on: { input: (e) => { p.note = e.target.value; f.touch(); } } }) : null].filter(Boolean)); }; drawPrio();
      const bp = h('select', { class: 'gn-select gn-mt', 'aria-label': 'Période du budget', disabled: !f.editable, on: { change: (e) => { setp(f.draft, 'constraints.budget.period', e.target.value || null); f.touch(); } } }, h('option', { value: '', text: 'Période' }), Object.entries(opts.budgetPeriods).map(([k, l]) => h('option', { value: k, text: l }))); bp.value = getp(f.draft, 'constraints.budget.period') ?? '';
      return h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, head('Objectifs et priorités', 'Le contexte du moment pour les modules. Il ne prouve ni stock, ni délai, ni budget disponible.'), h('hr', { class: 'gn-rule' }),
        field(f, 'priority', 'Priorité du moment', prio), field(f, 'expected_result', 'Résultat attendu', input(f, 'expected_result', { maxlength: 200, placeholder: 'Par exemple : 20 commandes de coques ce mois-ci' }), { optional: true }),
        field(f, 'deadline', 'Échéance', input(f, 'deadline', { type: 'date' }), { optional: true }), field(f, 'featured_offers', 'Offres à mettre en avant', offersEditor(f), { optional: true }),
        h('h3', { text: 'Contraintes' }),
        field(f, 'constraints.budget.amount', 'Budget (' + (f.read.currency ?? 'devise de référence') + ')', h('div', {}, input(f, 'constraints.budget.amount', { type: 'number', inputmode: 'decimal', maxlength: 12 }), bp, f.slot('constraints.budget.period'), h('input', { class: 'gn-input gn-mt', type: 'text', value: getp(f.draft, 'constraints.budget.note') ?? '', maxlength: 200, placeholder: 'Précision (facultatif)', 'aria-label': 'Précision sur le budget', disabled: !f.editable, on: { input: (e) => { setp(f.draft, 'constraints.budget.note', e.target.value); f.touch(); } } })), { optional: true }),
        field(f, 'constraints.time.note', 'Temps disponible', input(f, 'constraints.time.note', { maxlength: 200 }), { optional: true }), field(f, 'constraints.stock.note', 'Stock', input(f, 'constraints.stock.note', { maxlength: 200 }), { optional: true }), field(f, 'constraints.production.note', 'Production', input(f, 'constraints.production.note', { maxlength: 200 }), { optional: true }), bar(f)); },
    profile: (f) => h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, head('Profil du commerce', 'Ces informations sont utilisées par les modules Nordla.'), h('hr', { class: 'gn-rule' }),
      field(f, 'name', 'Nom commercial', input(f, 'name', { maxlength: 80 })), field(f, 'description', 'Description courte', area(f, 'description'), { optional: true, help: 'Décrivez vos offres et services en termes concrets.' }),
      field(f, 'logo', 'Logo', h('p', { class: 'gn-note', text: f.read.logo?.reason ?? 'Non disponible.' }), { optional: true }),
      field(f, 'website', 'Site web', input(f, 'website', { type: 'url', placeholder: 'https://', maxlength: 300 }), { optional: true }), field(f, 'email', 'E-mail public', input(f, 'email', { type: 'email', maxlength: 254 }), { optional: true }),
      field(f, 'phone', 'Téléphone public', input(f, 'phone', { type: 'tel', maxlength: 30, inputmode: 'tel' }), { optional: true, help: 'Format international (+32 …) ; le format belge (081 …) est accepté pour la Belgique.' }), bar(f)),
    activity: (f) => h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, head('Activité et canaux de vente', 'Ces informations sont utilisées par les modules Nordla.'), h('hr', { class: 'gn-rule' }),
      field(f, 'main', 'Activité principale', (() => { const wrap = h('div'); const draw = () => { wrap.replaceChildren(...[h('select', { class: 'gn-select', disabled: !f.editable, on: { change: (e) => { f.draft.main = e.target.value ? { value: e.target.value } : null; f.touch(); draw(); } } }, h('option', { value: '', text: 'À renseigner' }), Object.entries(opts.mainActivities).map(([k, l]) => h('option', { value: k, text: l, selected: f.draft.main?.value === k }))), f.draft.main?.value === 'other' ? h('input', { class: 'gn-input gn-mt', type: 'text', value: f.draft.main.label ?? '', maxlength: 60, placeholder: 'Précisez (obligatoire)', 'aria-label': 'Précision pour Autre', disabled: !f.editable, on: { input: (e) => { f.draft.main.label = e.target.value; f.touch(); } } }) : null].filter(Boolean)); }; draw(); return wrap; })()),
      field(f, 'complementary', 'Activités complémentaires', chips(f, 'complementary', opts.sideActivities, { labelled: ['printing', 'personalisation', 'craft', 'repair', 'services'], addText: 'Ajouter une activité' })),
      field(f, 'channels', 'Canaux de vente', checks(f, 'channels', opts.channels), { help: 'Un canal déclaré décrit votre activité ; l’état réel des sources se voit dans Connexions.' }),
      field(f, 'clientele', 'Clientèle', select(f, 'clientele', opts.clientele), { optional: true }), bar(f)),
    selling_modes: (f) => h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, head('Mode de vente et de production', 'Comment votre offre est préparée ou fournie.'), h('hr', { class: 'gn-rule' }),
      field(f, 'modes', 'Modes de vente', chips(f, 'modes', opts.sellingModes, { addText: 'Ajouter un mode' }), { help: 'Ces modes sont un contexte : ils ne prouvent ni stock ni délai.' }),
      ...(f.read.catalogueFamilies?.length ? f.read.catalogueFamilies.map((fam) => field(f, `by_family.${fam}`, `Précision : ${fam}`, (() => { f.draft.by_family ??= {}; f.draft.by_family[fam] ??= []; return chips(f, `by_family.${fam}`, opts.sellingModes, { addText: 'Ajouter un mode' }); })(), { optional: true })) : [h('p', { class: 'gn-note', text: 'Aucune famille de produits n’existe encore dans le catalogue : la précision par famille s’affichera dès qu’il y en aura.' })]), bar(f)),
    regional: (f) => { const prev = h('div', { class: 'gn-preview', 'aria-live': 'polite' }); const upd = () => { const z = f.draft.timezone; try { prev.textContent = z ? `Il est actuellement ${new Intl.DateTimeFormat('fr-BE', { dateStyle: 'full', timeStyle: 'long', timeZone: z }).format(new Date())}.` : 'Choisissez un fuseau pour voir l’aperçu.'; } catch { prev.textContent = 'Fuseau inconnu : aucun aperçu.'; } }; upd();
      const names = (() => { try { return new Intl.DisplayNames(['fr'], { type: 'currency' }); } catch { return null; } })();
      const cur = h('select', { class: 'gn-select', disabled: !f.editable, on: { change: (e) => { f.draft.currency = e.target.value || null; f.touch(); } } }, h('option', { value: '', text: 'À renseigner' }), opts.currencies.map((c) => h('option', { value: c, text: `${c} — ${names?.of(c) ?? c}` }))); cur.value = f.draft.currency ?? '';
      const dl = h('datalist', { id: 'gn-tz' }, opts.timezones.map((z) => h('option', { value: z }))); const tz = input(f, 'timezone', { list: 'gn-tz', maxlength: 60, placeholder: 'Europe/Brussels' }); tz.addEventListener('input', upd);
      return h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, head('Devise et fuseau horaire', 'Utilisés pour les journées commerciales, les rapports et les horaires.'), h('hr', { class: 'gn-rule' }),
        field(f, 'currency', 'Devise de référence', cur, { help: 'Elle s’applique aux nouveaux réglages et rapports. Les ventes, achats et factures passés gardent leur devise d’origine ; aucun montant n’est converti.' }),
        field(f, 'timezone', 'Fuseau horaire du commerce', h('div', {}, tz, dl, prev)), field(f, 'display', 'Affichage', h('p', { class: 'gn-note', text: 'Selon l’utilisateur : les formats personnels de date, de nombre et la langue se règlent dans Préférences.' })), bar(f)); },
    legal: (f) => { const country = () => f.draft.country ?? ''; const lf = () => opts.legalForms[country()] ?? []; const dyn = h('div'); const drawDyn = () => dyn.replaceChildren(
        field(f, 'legal_form', 'Forme juridique', (() => { const w = h('div'); const m = Object.fromEntries([...lf().map((x) => [x, x]), ['other', 'Autre']]); const s = h('select', { class: 'gn-select', disabled: !f.editable, on: { change: (e) => { f.draft.legal_form = e.target.value ? { value: e.target.value } : null; f.touch(); drawDyn(); } } }, h('option', { value: '', text: 'À renseigner' }), Object.entries(m).map(([k, l]) => h('option', { value: k, text: l }))); s.value = f.draft.legal_form?.value ?? ''; w.append(s); if (f.draft.legal_form?.value === 'other') w.append(h('input', { class: 'gn-input gn-mt', type: 'text', value: f.draft.legal_form.label ?? '', maxlength: 60, placeholder: 'Précisez', 'aria-label': 'Précision forme juridique', disabled: !f.editable, on: { input: (e) => { f.draft.legal_form.label = e.target.value; f.touch(); } } })); return w; })(), { optional: true }),
        field(f, 'enterprise_number', country() === 'BE' ? 'Numéro d’entreprise (BCE)' : 'Identifiant d’entreprise', input(f, 'enterprise_number', { maxlength: 30, placeholder: country() === 'BE' ? '0000.000.000' : '' }), { optional: true }),
        field(f, 'vat_status', 'Identification TVA', (() => { const w = h('div'); w.append(select(f, 'vat_status', opts.vatStatus, { empty: null, onchange: drawDyn })); if (f.draft.vat_status === 'registered') w.append(h('input', { class: 'gn-input gn-mt', type: 'text', value: f.draft.vat_number ?? '', maxlength: 20, placeholder: country() === 'BE' ? 'BE0000000000' : 'Numéro de TVA', 'aria-label': 'Numéro de TVA', disabled: !f.editable, on: { input: (e) => { f.draft.vat_number = e.target.value; f.touch(); } } }), f.slot('vat_number')); return w; })(), { help: 'Ce statut décrit le profil ; il ne déclenche aucun calcul fiscal.' }),
        field(f, 'billing', 'Adresse de facturation', (() => { const w = h('div'); const use = f.draft.billing?.use_primary !== false; w.append(h('label', { class: 'gn-check' }, h('input', { type: 'checkbox', checked: use, disabled: !f.editable, on: { change: (e) => { f.draft.billing = e.target.checked ? { use_primary: true } : { use_primary: false, street: '', complement: '', postal_code: '', city: '', country: f.draft.country ?? '' }; f.touch(); drawDyn(); } } }), h('span', { text: 'Utiliser l’adresse de l’établissement principal' })));
          if (!use) for (const [k, l, ph] of [['street', 'Adresse', ''], ['complement', 'Complément', ''], ['postal_code', 'Code postal', ''], ['city', 'Ville', '']]) w.append(h('div', { class: 'gn-mt' }, h('input', { class: 'gn-input', type: 'text', value: f.draft.billing[k] ?? '', placeholder: l, 'aria-label': l, maxlength: 120, disabled: !f.editable, on: { input: (e) => { f.draft.billing[k] = e.target.value; f.touch(); } } }), f.slot(`billing.${k}`)));
          return w; })(), { optional: true })); drawDyn();
      return h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, head('Informations légales et facturation', 'Finance lit ces informations pour les futurs documents ; les factures déjà émises gardent leur identité.'), h('hr', { class: 'gn-rule' }),
        field(f, 'legal_name', 'Raison sociale', input(f, 'legal_name', { maxlength: 120 }), { optional: true }), field(f, 'country', 'Pays d’immatriculation', select(f, 'country', opts.countries, { onchange: () => { f.draft.legal_form = null; f.touch(); drawDyn(); } }), { optional: true }), dyn,
        field(f, 'email', 'E-mail de facturation', input(f, 'email', { type: 'email', maxlength: 254 }), { optional: true, help: 'Distinct de l’e-mail public.' }), bar(f)); },
  };

  // ------------------------------------------------------------------ establishments (list + one editor)
  const emptyHours = () => Object.fromEntries(opts.days.map((d) => [d.id, []]));
  const newPlace = () => ({ name: '', functions: [], address: { street: '', complement: '', postal_code: '', city: '', country: '' }, phone: '', email: '', visibility: 'internal', publish_contact: false, hours: emptyHours(), exceptions: [] });
  const placeData = (p) => { const { id, version, isPrimary, archived, ...d } = p; return { ...newPlace(), ...d, address: { ...newPlace().address, ...(d.address ?? {}) }, hours: { ...emptyHours(), ...(d.hours ?? {}) } }; };
  function slotsEditor(f, path) {
    const box = h('div', { class: 'gn-slots' });
    const draw = () => { const list = getp(f.draft, path) ?? []; box.replaceChildren(); list.forEach((s, i) => box.append(h('div', { class: 'gn-slot' }, h('input', { class: 'gn-input', type: 'time', value: s.from ?? '', 'aria-label': 'Début', disabled: !f.editable, on: { input: (e) => { s.from = e.target.value; f.touch(); } } }), '–', h('input', { class: 'gn-input', type: 'time', value: s.to ?? '', 'aria-label': 'Fin', disabled: !f.editable, on: { input: (e) => { s.to = e.target.value; f.touch(); } } }), f.editable ? h('button', { class: 'gn-x', type: 'button', 'aria-label': 'Retirer le créneau', text: '×', on: { click: () => { list.splice(i, 1); draw(); f.touch(); } } }) : null)));
      if (f.editable && list.length < 4) box.append(h('button', { class: 'gn-add', type: 'button', text: '+ Ajouter un créneau', on: { click: () => { list.push({ from: '10:00', to: '18:00' }); setp(f.draft, path, list); draw(); f.touch(); } } })); if (!list.length) box.prepend(h('span', { class: 'gn-help', text: 'Fermé' })); };
    draw(); return box;
  }
  function hoursEditor(f) {
    const box = h('div', { class: 'gn-hours' });
    const COPY = { weekdays: 'Du lundi au vendredi', all: 'Tous les jours', weekend: 'Samedi et dimanche' };
    for (const d of opts.days) {
      const to = (k) => (k === 'weekdays' ? ['mon', 'tue', 'wed', 'thu', 'fri'] : k === 'weekend' ? ['sat', 'sun'] : k === 'all' ? opts.days.map((x) => x.id) : [k]).filter((x) => x !== d.id);
      box.append(h('div', { class: 'gn-day' }, h('strong', { text: d.label }), h('div', {}, slotsEditor(f, `hours.${d.id}`), f.slot(`hours.${d.id}`),
        f.editable ? h('select', { class: 'gn-select gn-add-select', 'aria-label': `Copier ${d.label} vers d’autres jours`, on: { change: (e) => { const k = e.target.value; if (!k) return; for (const t of to(k)) f.draft.hours[t] = clone(f.draft.hours[d.id]); f.touch(); f.rebuild(); } } }, h('option', { value: '', text: 'Copier vers d’autres jours' }), Object.entries(COPY).map(([k, l]) => h('option', { value: k, text: l })), opts.days.filter((x) => x.id !== d.id).map((x) => h('option', { value: x.id, text: x.label }))) : null)));
    }
    return box;
  }
  function exceptionsEditor(f) {
    const box = h('div'); const draw = () => { const list = f.draft.exceptions ?? []; box.replaceChildren();
      list.forEach((x, i) => { x.slots ??= []; box.append(h('div', { class: 'gn-exc' }, h('div', { class: 'gn-subbar' }, h('input', { class: 'gn-input gn-auto', type: 'date', value: x.date ?? '', 'aria-label': 'Date', disabled: !f.editable, on: { input: (e) => { x.date = e.target.value; f.touch(); } } }), h('label', { class: 'gn-check' }, h('input', { type: 'checkbox', checked: !!x.closed, disabled: !f.editable, on: { change: (e) => { x.closed = e.target.checked; f.touch(); draw(); } } }), 'Fermé'), f.editable ? h('button', { class: 'gn-x', type: 'button', 'aria-label': 'Retirer cette date', text: '×', on: { click: () => { list.splice(i, 1); f.touch(); draw(); } } }) : null), f.slot(`exceptions.${i}.date`),
          x.closed ? null : [slotsEditor(f, `exceptions.${i}.slots`), f.slot(`exceptions.${i}.slots`)], h('input', { class: 'gn-input', type: 'text', value: x.reason ?? '', placeholder: 'Motif (facultatif)', 'aria-label': 'Motif', maxlength: 80, disabled: !f.editable, on: { input: (e) => { x.reason = e.target.value; f.touch(); } } }))); });
      if (f.editable) box.append(h('button', { class: 'gn-add', type: 'button', text: '+ Ajouter une date', on: { click: () => { (f.draft.exceptions ??= []).push({ date: '', closed: true, slots: [], reason: '' }); f.touch(); draw(); } } })); if (!list.length && !f.editable) box.append(h('span', { class: 'gn-help', text: 'Aucun horaire exceptionnel' })); };
    draw(); return box;
  }
  // supplier locations: tie a location Nordla received from a connected supplier to THIS place (by its stable Nordla id). Nothing is invented: only locations that exist are offered.
  function supplierBlock(p, canWrite) {
    const box = h('div', { class: 'gn-field-block', 'data-supplier-links': '' }); const SUP = { shopify: 'Shopify', google_business_profile: 'Google Business Profile' };
    const draw = async () => {
      const r = await api('/api/general/supplier-locations'); box.replaceChildren(h('h3', { text: 'Lieux du fournisseur' }));
      if (!r.ok) { box.append(h('p', { class: 'gn-help', text: 'Les lieux du fournisseur sont indisponibles pour le moment.' })); return; }
      const mine = r.json.locations.filter((l) => l.establishmentId === p.id); const free = r.json.locations.filter((l) => !l.establishmentId);
      if (!r.json.locations.length) { box.append(h('p', { class: 'gn-note', text: 'Aucun lieu fournisseur n’est connu de Nordla : le fournisseur n’est pas connecté (voir Connexions). L’association réelle reste à vérifier.' }), h('a', { class: 'cx-link', href: '/settings/connections', text: 'Ouvrir Connexions' })); return; }
      const act = async (l, action) => { const x = await api('/api/general/establishments/' + p.id + '/links', { provider: l.provider, external_id: l.externalId, action }); if (!x.ok) { flash = { tone: 'err', text: ERRORS[x.json?.error?.code] ?? x.json?.error?.message ?? 'Action refusée.' }; } else flash = { tone: 'ok', text: action === 'unlink' ? 'Association retirée.' : 'Lieu associé.' }; await openSection('establishments', true); };
      for (const l of mine) box.append(h('div', { class: 'gn-slot' }, h('span', { text: (SUP[l.provider] ?? l.provider) + ' : ' + (l.name || l.externalId) }), canWrite ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Retirer', on: { click: () => act(l, 'unlink') } }) : null));
      if (canWrite && free.length) { const sel = h('select', { class: 'gn-select gn-add-select', 'aria-label': 'Lieu du fournisseur à associer' }, h('option', { value: '', text: '+ Associer un lieu du fournisseur' }), free.map((l, i) => h('option', { value: String(i), text: (SUP[l.provider] ?? l.provider) + ' : ' + (l.name || l.externalId) }))); sel.addEventListener('change', () => { if (sel.value !== '') act(free[Number(sel.value)], 'link'); }); box.append(sel); }
      if (!mine.length && !free.length) box.append(h('p', { class: 'gn-help', text: 'Tous les lieux connus sont déjà associés.' }));
    };
    draw(); return box;
  }
  function placeForm(p, canWrite, isNew) {
    const f = makeForm({ section: 'establishments', read: { data: placeData(p ?? {}), version: p?.version ?? null, canWrite: canWrite && !p?.archived }, build: null, submit: null });
    f.build = (ff) => h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() }, 'data-place': p?.id ?? 'new' }, head(isNew ? 'Nouvel établissement' : (p.name || 'Établissement'), p?.archived ? 'Archivé : restaurez-le pour le modifier.' : (p?.isPrimary ? 'Établissement principal' : null)), h('hr', { class: 'gn-rule' }),
      field(ff, 'name', 'Nom du lieu', input(ff, 'name', { maxlength: 80 })), field(ff, 'functions', 'Fonctions du lieu', chips(ff, 'functions', opts.placeFunctions, { addText: 'Ajouter une fonction' })),
      field(ff, 'address.street', 'Adresse', input(ff, 'address.street', { maxlength: 120 })), field(ff, 'address.complement', 'Complément', input(ff, 'address.complement', { maxlength: 80 }), { optional: true }), field(ff, 'address.postal_code', 'Code postal', input(ff, 'address.postal_code', { maxlength: 12 })), field(ff, 'address.city', 'Ville', input(ff, 'address.city', { maxlength: 80 })), field(ff, 'address.country', 'Pays', select(ff, 'address.country', opts.countries)),
      field(ff, 'phone', 'Téléphone', input(ff, 'phone', { type: 'tel', maxlength: 30, inputmode: 'tel' }), { optional: true }), field(ff, 'email', 'E-mail', input(ff, 'email', { type: 'email', maxlength: 254 }), { optional: true }),
      field(ff, 'visibility', 'Visibilité', select(ff, 'visibility', { public: 'Lieu accueillant le public', internal: 'Lieu interne' }, { empty: null, onchange: () => { if (ff.draft.visibility !== 'public') ff.draft.publish_contact = false; ff.rebuild(); } })),
      ff.draft.visibility === 'public' ? field(ff, 'publish_contact', 'Brouillons', h('label', { class: 'gn-check' }, h('input', { type: 'checkbox', checked: !!ff.draft.publish_contact, disabled: !ff.editable, on: { change: (e) => { ff.draft.publish_contact = e.target.checked; ff.touch(); } } }), h('span', { text: 'Reprendre l’adresse et les coordonnées dans les brouillons publics' }))) : h('p', { class: 'gn-note', text: 'Un lieu interne ne fournit pas son adresse aux brouillons publics.' }),
      !isNew && !p?.archived ? supplierBlock(p, canWrite) : null,
      h('h3', { text: 'Horaires réguliers' }), hoursEditor(ff), h('h3', { text: 'Horaires exceptionnels' }), h('p', { class: 'gn-help', text: 'Ils priment sur les horaires réguliers pour la date concernée.' }), exceptionsEditor(ff),
      bar(ff, !isNew && canWrite ? [p.archived ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Restaurer', on: { click: () => placeAction(p.id, 'restore') } }) : [!p.isPrimary ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Définir comme principal', on: { click: () => placeAction(p.id, 'primary') } }) : null, h('button', { class: 'cx-btn ghost', type: 'button', text: 'Archiver', on: { click: () => { if (window.confirm('Archiver ce lieu ? Les références des ventes et stocks passés sont conservées.')) placeAction(p.id, 'archive'); } } })]] : []));
    f.submit = async (ff) => { const r = await api('/api/general/establishments', { establishment: { ...ff.draft, ...(p?.id ? { id: p.id } : {}) }, expectedVersion: ff.version }); if (!r.ok) return r; const saved = r.json.data.establishments.find((x) => x.id === r.json.id); placeSel = r.json.id; return { ...r, json: { data: placeData(saved), version: saved.version } }; };
    return f;
  }
  async function placeAction(id, action) { const r = await api(`/api/general/establishments/${id}/${action}`, {}); if (guard(r)) return; flash = r.ok ? { tone: 'ok', text: action === 'primary' ? 'Établissement principal mis à jour.' : action === 'archive' ? 'Établissement archivé.' : 'Établissement restauré.' } : { tone: 'err', text: ERRORS[r.json?.error?.code] ?? `Action refusée (${r.status}).` }; placeSel = r.ok && action === 'archive' ? null : placeSel; await openSection('establishments', true); }

  // ------------------------------------------------------------------ page
  const dirtyAsk = () => !cur?.dirty?.() || window.confirm('Des modifications ne sont pas enregistrées. Quitter sans les enregistrer ?');
  window.addEventListener('beforeunload', (e) => { if (cur?.dirty?.()) { e.preventDefault(); e.returnValue = ''; } });
  const detail = h('section', { class: 'cx-detail', id: 'gn-detail' }); const listBox = h('div', { class: 'cx-list' }); const side = h('div');
  const stateOf = (s) => (s.locked ? ['Réservé', 'lock'] : s.filled ? ['Renseigné', 'ok'] : ['À renseigner', 'todo']);
  function renderList() {
    listBox.replaceChildren(...ov.sections.map((s) => { const [t, tone] = stateOf(s); return h('a', { class: 'cx-row', href: `/settings/general/${SLUG[s.id]}`, 'aria-current': current === s.id ? 'true' : null, on: { click: (e) => { e.preventDefault(); go(s.id); } } }, icon(ICON[s.id]), h('span', { class: 'cx-row-name', text: s.label }), h('span', { class: 'gn-state', 'data-tone': tone, text: t })); }));
    side.replaceChildren(h('div', { class: 'gn-consumers' }, h('h3', { text: 'Qui lit Général' }), h('ul', {}, ov.consumers.map((c) => h('li', {}, h('span', { class: 'gn-state', 'data-tone': c.state === 'READS' ? 'ok' : 'todo', text: c.state === 'READS' ? 'Lit déjà' : 'À raccorder' }), h('strong', { text: `${c.module} : ` }), c.note)))));
  }
  const msgNode = (m, f) => h('div', { class: `gn-msg ${m.tone}`, role: m.tone === 'err' ? 'alert' : 'status' }, m.text, m.reload && f ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Recharger les valeurs enregistrées', on: { click: () => { openSection(f.section, true); } } }) : null);
  async function refreshOverview() { const r = await api('/api/general'); if (r.ok) { ov = r.json; } }
  async function openSection(id, force = false) {
    if (!force && !dirtyAsk()) return false;
    let node;
    if (id === 'establishments') {
      const r = await api('/api/general/establishments'); if (guard(r)) return; if (!r.ok) { cur = null; detail.replaceChildren(h('p', { class: 'cx-msg err', text: 'Cette rubrique est indisponible pour le moment.' })); return; }
      const list = r.json.data.establishments; const canWrite = r.json.canWrite; placeSel = placeSel && (placeSel === 'new' || list.some((p) => p.id === placeSel)) ? placeSel : (list.find((p) => p.isPrimary && !p.archived) ?? list.find((p) => !p.archived) ?? list[0])?.id ?? (canWrite ? 'new' : null);
      const p = placeSel && placeSel !== 'new' ? list.find((x) => x.id === placeSel) : null;
      const f = placeSel ? placeForm(p, canWrite, placeSel === 'new') : null; cur = f;
      const picker = h('div', {}, list.map((x) => h('button', { class: 'gn-place', type: 'button', 'aria-current': placeSel === x.id ? 'true' : null, on: { click: () => { if (!dirtyAsk()) return; placeSel = x.id; openSection('establishments', true); } } }, h('span', {}, h('strong', { text: x.name || 'Lieu' }), h('small', { text: [x.isPrimary ? 'Principal' : null, x.archived ? 'Archivé' : null, x.address?.city].filter(Boolean).join(' · ') }))) ), canWrite ? h('button', { class: 'cx-btn ghost', type: 'button', text: '+ Ajouter un établissement', on: { click: () => { if (!dirtyAsk()) return; placeSel = 'new'; openSection('establishments', true); } } }) : null, !list.length && !canWrite ? h('p', { class: 'gn-note', text: 'Aucun établissement renseigné.' }) : null);
      node = [picker, h('hr', { class: 'gn-rule' })]; if (f) { f.read = r.json; f.msg = (m) => { f.node.parentElement.querySelector('.gn-msg')?.remove(); f.node.before(msgNode(m, f)); }; f.rebuildAll = () => openSection('establishments', true); f.node = f.build(f); node.push(f.node); }
    } else {
      const r = await api(`/api/general/${id}`); if (guard(r)) return;
      if (!r.ok) { cur = null; detail.replaceChildren(h('p', { class: 'cx-msg err', text: r.json?.error?.code === 'FORBIDDEN_ROLE' ? 'Cette rubrique est réservée au propriétaire et aux administrateurs.' : 'Cette rubrique est indisponible pour le moment.' })); return; }
      const f = makeForm({ section: id, read: r.json, build: null, submit: null }); f.read = r.json; cur = f;
      f.build = BUILD[id]; f.submit = async (ff) => api(`/api/general/${id}`, { data: ff.draft, expectedVersion: ff.version });
      f.msg = (m) => { f.node.parentElement.querySelector('.gn-msg')?.remove(); f.node.before(msgNode(m, f)); };
      f.rebuildAll = () => { f.node.parentElement.querySelectorAll('.gn-msg').forEach((x) => x.remove()); const n = BUILD[id](f); f.node.replaceWith(n); f.node = n; f.node.before(msgNode(flash ?? { tone: 'ok', text: 'Modifications enregistrées.' }, null)); flash = null; };
      f.node = BUILD[id](f); node = [f.node];
    }
    current = id; const sm = ov.sections.find((s) => s.id === id);
    detail.replaceChildren(...[!wide() ? h('button', { class: 'cx-back', type: 'button', text: '‹ Retour', on: { click: () => go(null) } }) : null, flash ? msgNode(flash, null) : null, ...node].filter(Boolean)); flash = null; renderList(); layout(); if (sm) document.title = `Nordla AI · Paramètres · ${sm.label}`;
    return true;
  }
  function layout() { const split = document.getElementById('gn-split'); if (!split) return; const showDetail = wide() || current; listBox.hidden = !wide() && !!current; side.hidden = listBox.hidden; detail.hidden = !showDetail; }
  async function go(id) { if (id === null) { if (!dirtyAsk()) return; cur = null; current = null; history.pushState(null, '', '/settings/general'); renderList(); layout(); window.scrollTo(0, 0); return; } if (!(await openSection(id))) return; history.pushState(null, '', `/settings/general/${SLUG[id]}`); window.scrollTo(0, 0); }
  window.addEventListener('popstate', () => { const slug = location.pathname.split('/')[3]; if (OF[slug]) openSection(OF[slug], true); else { current = null; cur = null; renderList(); layout(); } });
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => { if (wide() && !current) openSection(ov.sections.find((s) => !s.locked)?.id ?? 'profile', true); else layout(); });

  async function start() {
    const r = await api('/api/general'); if (guard(r)) return;
    if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Général' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    ov = r.json; opts = r.json.options; shellData = r.json.shell ?? { nav: [{ id: 'settings', label: 'Paramètres', href: '/settings', icon: 'settings' }], merchant: null, environment: null };
    const wanted = OF[location.pathname.split('/')[3]] ?? null;
    const split = h('div', { class: 'cx-split', id: 'gn-split' }, h('div', {}, listBox, side), detail);
    app.replaceChildren(shell(shellData, 'settings', [h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/settings', text: 'Paramètres' }), ' / ', h('strong', { text: 'Général' })), h('h1', { text: 'Général' }), split]));
    // the first block of the split is the list column
    renderList();
    const first = wanted ?? (wide() ? (ov.sections.find((s) => !s.locked)?.id ?? 'profile') : null);
    if (first) await openSection(first, true); else layout();
  }
  start();
})();
