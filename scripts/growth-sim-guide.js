'use strict';
// SIMULATION ONLY (served by scripts/growth-sim.mjs, never by the product): a short guide to find every Growth option of lots _01 to _11 on this screen, and the switches of the simulated scenarios.
(() => {
  const h = (tag, attrs, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f); else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat(Infinity)) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c))); return el; };
  const hit = async (url) => { try { await fetch(url); } catch (e) { /* the reload shows the state */ } location.reload(); };
  const sw = (label, url) => h('button', { type: 'button', class: 'simg-sw', on: { click: () => hit(url) } }, label);
  const STEPS = [
    ['Actions prioritaires, preuves, « Préparer »', 'Menu Opportunités → bloc « Actions prioritaires » : cliquez une ligne pour voir sa preuve, puis le bouton « Préparer ».'],
    ['Dossier de correction', 'Opportunités → repli « À corriger maintenant » (cliquez pour l’ouvrir) → bouton « Télécharger le dossier de correction » : un exemple .md sur 7 produits fictifs (tous, ou par catégorie).'],
    ['Campagne e-mail', 'Opportunités → ligne « segment » (clients fidèles, nouveaux, à réactiver) → « Préparer » : le brouillon s’affiche. Ensuite « Marquer comme envoyée » : l’envoi est SIMULÉ, rien n’est envoyé. Puis « Résultat » : la revue de campagne.'],
    ['« À revoir » avec un résultat calculé', 'Bloc « À revoir » → ligne « Casque Sim » → « Revoir » : le résultat est calculé par Growth (unités nettes avant / après). Les lignes « Site » et « Abonnés » du même bloc se revoient de la même façon.'],
    ['Diagnostic d’une campagne publicitaire', 'Repli « Campagnes publicitaires » → une campagne : le diagnostic, la preuve et l’action (données Meta Ads simulées).'],
    ['Site indépendant, avant / après', 'Repli « Site indépendant » → page /demander-un-devis. La comparaison avant / après est dans « À revoir » (ligne « Page /demander-un-devis » → « Revoir »).'],
    ['Test Instagram / TikTok, brief, publication, revue', 'Repli « Abonnés » → test Instagram → « Copier le brief » / « Télécharger le brief » → panneau « Publication sociale » (états ci-dessous) → « Revoir » (À revoir). Le brief s’importe dans Creator (lien ci-dessous).'],
    ['Demandes → Suite commerciale', 'Repli « Demandes » → ligne « Demandes qualifiées (Instagram) » → déjà préparée : « Conversations de la période » (qualifier) puis « Suite commerciale » : une demande qualifiée, un devis, une vente, une réservation directe, une vente d’origine inconnue. « Enregistrer une étape » pour en ajouter.'],
  ];
  const panel = h('div', { class: 'simg-panel', hidden: true, role: 'dialog', 'aria-label': 'Guide de la simulation' });
  const links = h('p', { class: 'simg-links' });
  const render = () => panel.replaceChildren(
    h('div', { class: 'simg-banner', role: 'note' }, h('strong', null, 'SIMULATION'), ' — boutique, comptes, clients et chiffres FICTIFS (« Boutique de simulation », @atelier_sim). Rien n’est lu ni écrit sur HABB, rien n’est publié, envoyé ou payé. Vos essais restent dans ce navigateur.'),
    h('h2', null, 'Où trouver chaque option'), h('ol', { class: 'simg-steps' }, STEPS.map(([t, d]) => h('li', null, h('strong', null, t), h('span', null, ` ${d}`)))),
    h('h2', null, 'Changer le scénario'),
    h('p', { class: 'simg-row' }, h('span', null, 'Publication sociale :'), sw('Brouillon', '/sim/social?step=draft'), sw('Validé', '/sim/social?step=validated'), sw('Planifié', '/sim/social?step=scheduled'), sw('Publié (simulé)', '/sim/social?step=published'), sw('Incertain', '/sim/social?step=uncertain')),
    h('p', { class: 'simg-row' }, h('span', null, 'Conversations :'), sw('Normal', '/sim/inbox?name=default'), sw('Sans attribution', '/sim/inbox?name=no-attribution'), sw('Zéro', '/sim/inbox?name=zero'), sw('Non connecté', '/sim/inbox?name=not-connected'), sw('Indisponible', '/sim/inbox?name=unavailable')),
    h('p', { class: 'simg-row' }, h('span', null, 'Abonnés :'), sw('Normal', '/sim/scenario?name=default'), sw('Sans attribution par publication', '/sim/scenario?name=no-attribution'),
      h('button', { type: 'button', class: 'simg-sw simg-reset', on: { click: () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('nordla.growth.')) localStorage.removeItem(k); } catch (e) { /* nothing */ } location.reload(); } } }, 'Réinitialiser mes essais')),
    h('h2', null, 'Ouvrir ailleurs (simulation)'), links,
    h('h2', null, 'Ce qui reste à connecter pour de vrai'), h('ul', { class: 'simg-todo' }, [
      'Shopify / Core réels (ici : catalogue et ventes fictifs).', 'Instagram : statistiques (permission instagram_business_manage_insights) et messagerie (API Conversations) ; TikTok : rien de vérifié.',
      'Creator : produire une création à partir d’un brief social (il le reçoit et l’affiche seulement).', 'Publication sociale réelle (jetons Meta) ; ici l’éditeur est simulé.',
      'E-mail : envoi réel (ici simulé) ; GA4 / Search Console ; plateforme publicitaire réelle.', 'Suite commerciale : navigateur seulement, un CRM ou un registre serveur reste à brancher.']));
  const toggle = h('button', { type: 'button', class: 'simg-toggle', 'aria-expanded': 'false', on: { click: () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); } } }, 'SIMULATION · guide');
  render(); document.body.append(toggle, panel);
  fetch('/sim/links').then((r) => r.json()).then((l) => { links.replaceChildren(...[['Creator (importer le brief social)', l.creator], ['Brief simulé à importer dans Creator (fichier)', l.creator ? `${l.creator}sim/brief.json` : null], ['Publication sociale (calendrier)', l.social]].map(([label, u]) => (u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: 'simg-link' }, `${label} ↗`) : h('span', { class: 'simg-off' }, `${label} : non démarré`)))); }, () => {});
})();
