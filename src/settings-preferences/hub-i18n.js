// Languages of the Paramètres HUB (menu, the six cards, the page title). Pure data + one pure function: the Connexions service stays in French and the host applies this on top
// ONLY when the signed-in person chose a language. No saved choice = the payload is returned untouched (the language used today).
// The pages BEHIND the cards (Général, Équipe et accès, Sécurité, Connexions) are NOT translated by this file: they keep their French wording and say so on the Préférences page.
export const HUB_LANGS = Object.freeze(['fr', 'nl', 'en']);

const NAV = Object.freeze({
  home: { fr: 'Accueil', nl: 'Home', en: 'Home' }, sourcing: { fr: 'Sourcing', nl: 'Sourcing', en: 'Sourcing' }, procurement: { fr: 'Achats', nl: 'Inkoop', en: 'Purchasing' },
  finance: { fr: 'Finance', nl: 'Financiën', en: 'Finance' }, analytics: { fr: 'Analyses', nl: 'Analyses', en: 'Analytics' }, growth: { fr: 'Growth', nl: 'Growth', en: 'Growth' },
  marketing: { fr: 'Marketing', nl: 'Marketing', en: 'Marketing' }, settings: { fr: 'Paramètres', nl: 'Instellingen', en: 'Settings' },
});
const CARDS = Object.freeze({
  general: { label: { fr: 'Général', nl: 'Algemeen', en: 'General' }, description: { fr: 'Profil du commerce, activité, établissements, devise, fuseau horaire et informations légales.', nl: 'Bedrijfsprofiel, activiteit, vestigingen, munteenheid, tijdzone en wettelijke gegevens.', en: 'Business profile, activity, locations, currency, time zone and legal information.' } },
  team: { label: { fr: 'Équipe et accès', nl: 'Team en toegang', en: 'Team and access' }, description: { fr: 'Membres, invitations, rôles et permissions, historique des accès.', nl: 'Leden, uitnodigingen, rollen en rechten, toegangsgeschiedenis.', en: 'Members, invitations, roles and permissions, access history.' } },
  connections: { label: { fr: 'Connexions', nl: 'Koppelingen', en: 'Connections' }, description: { fr: 'Connecter vos outils (boutique, réseaux sociaux, banque, gestion).', nl: 'Uw tools koppelen (winkel, sociale netwerken, bank, beheer).', en: 'Connect your tools (shop, social networks, bank, management).' } },
  notifications: { label: { fr: 'Notifications', nl: 'Meldingen', en: 'Notifications' }, description: { fr: 'Choisir ce que vous recevez et par quel canal (e-mail, application).', nl: 'Kies wat u ontvangt en via welk kanaal (e-mail, app).', en: 'Choose what you receive and through which channel (e-mail, app).' } },
  preferences: { label: { fr: 'Préférences', nl: 'Voorkeuren', en: 'Preferences' }, description: { fr: 'Vos réglages personnels : langue de l’interface, format régional et vues par défaut.', nl: 'Uw persoonlijke instellingen: interfacetaal, regionaal formaat en standaardweergaven.', en: 'Your personal settings: interface language, regional format and default views.' } },
  security: { label: { fr: 'Sécurité', nl: 'Beveiliging', en: 'Security' }, description: { fr: 'Connexion, sessions, activité de sécurité et protection de l’équipe.', nl: 'Aanmelden, sessies, beveiligingsactiviteit en bescherming van het team.', en: 'Sign-in, sessions, security activity and team protection.' } },
});
const AVAIL = Object.freeze({ Disponible: { nl: 'Beschikbaar', en: 'Available' }, Prévu: { nl: 'Gepland', en: 'Planned' } });
const NOTE = Object.freeze({ 'Pas encore disponible.': { nl: 'Nog niet beschikbaar.', en: 'Not available yet.' }, 'Pas encore activé sur ce serveur.': { nl: 'Nog niet geactiveerd op deze server.', en: 'Not enabled on this server yet.' } });
const CHIP = Object.freeze({ Connecté: { nl: 'Verbonden', en: 'Connected' }, 'Non reliée': { nl: 'Niet gekoppeld', en: 'Not linked' }, Prêt: { nl: 'Klaar', en: 'Ready' }, 'En attente': { nl: 'In afwachting', en: 'Waiting' }, Prévu: { nl: 'Gepland', en: 'Planned' }, Disponible: { nl: 'Beschikbaar', en: 'Available' } });
export const HUB_TEXTS = Object.freeze({
  title: { fr: 'Paramètres', nl: 'Instellingen', en: 'Settings' }, subtitle: { fr: 'Aperçu général.', nl: 'Algemeen overzicht.', en: 'Overview.' },
  unavailable: { fr: 'Cette page est indisponible pour le moment.', nl: 'Deze pagina is momenteel niet beschikbaar.', en: 'This page is not available right now.' },
});
const pick = (m, lang, fallback) => (lang === 'fr' ? fallback : (m?.[lang] ?? fallback));

/** The Connexions `settings` payload in `lang`. `fr`, an unknown language or no language: unchanged. */
export function translateSettings(payload, lang) {
  if (!payload || !HUB_LANGS.includes(lang) || lang === 'fr') return payload;
  const nav = (payload.nav ?? []).map((n) => ({ ...n, label: NAV[n.id]?.[lang] ?? n.label }));
  const cards = (payload.cards ?? []).map((c) => ({
    ...c, label: CARDS[c.id]?.label[lang] ?? c.label, description: CARDS[c.id]?.description[lang] ?? c.description,
    availabilityLabel: pick(AVAIL[c.availabilityLabel], lang, c.availabilityLabel), note: c.note ? pick(NOTE[c.note], lang, c.note) : c.note,
    ...(c.providers ? { providers: c.providers.map((p) => ({ ...p, statusLabel: pick(CHIP[p.statusLabel], lang, p.statusLabel) })) } : {}),
  }));
  return { ...payload, lang, nav, cards, texts: { title: HUB_TEXTS.title[lang], subtitle: HUB_TEXTS.subtitle[lang], unavailable: HUB_TEXTS.unavailable[lang] } };
}
