// Module registry of the Nordla app. ONE entry per module: the Core knows no module by name beyond this list.
// A module joins by adding an entry (and its own embed script and API). Nothing else in the Core changes.
//   key        the internal module key (gateway, sessions, entitlements)
//   prefix     the public path under the Nordla address (/finance, /analyses, /growth...)
//   title      the label in the Core menu
//   embed      the script the module serves to mount its UI in the Core page (shadow root); null = not yet embedded
//   tabs       the module's own sections, shown as the horizontal bar inside the Core page
// Access is NEVER decided here: the module checks session, rights and activation on the server for every request.
export const MODULE_REGISTRY = Object.freeze([
  Object.freeze({ key: 'finance', prefix: '/finance', title: 'Finance', embed: '/finance/finance-embed.js', tabs: Object.freeze(['Accueil', 'À faire', 'Ventes', 'Paiements et créances', 'Achats', 'Banque & Caisse', 'Contacts', 'Trésorerie', 'Pack comptable']) }),
  Object.freeze({ key: 'analytics', prefix: '/analyses', title: 'Analyses', embed: null, tabs: Object.freeze([]) }),
  Object.freeze({ key: 'growth', prefix: '/growth', title: 'Croissance', embed: null, tabs: Object.freeze(['Vue d’ensemble', 'Opportunités', 'Produits potentiels', 'Contenu', 'Croissance magasin', 'Audience']) }),
]);

/** The registry must be well formed: unique keys and prefixes, a prefix under the Nordla address, no duplicate tab. */
export function validateRegistry(list = MODULE_REGISTRY) {
  const keys = new Set(); const prefixes = new Set(); const problems = [];
  for (const m of list) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(m.key)) problems.push(`key ${m.key}`);
    if (!/^\/[a-z][a-z0-9-]{1,30}$/.test(m.prefix)) problems.push(`prefix ${m.prefix}`);
    if (typeof m.title !== 'string' || !m.title.trim()) problems.push(`title ${m.key}`);
    if (keys.has(m.key)) problems.push(`duplicate key ${m.key}`); keys.add(m.key);
    if (prefixes.has(m.prefix)) problems.push(`duplicate prefix ${m.prefix}`); prefixes.add(m.prefix);
    if (m.embed !== null && !m.embed.startsWith(`${m.prefix}/`)) problems.push(`embed outside prefix ${m.key}`);
    if (new Set(m.tabs).size !== m.tabs.length) problems.push(`duplicate tab ${m.key}`);
  }
  return problems;
}
