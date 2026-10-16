// D-side claim rules that go BEYOND what chantier E's filter checks. Owner decisions of 2026-10-17:
//   - never state that every file is checked before printing until a systematic process is confirmed (PROCESS claims);
//   - the shop price (25 EUR) and the web price are two different facts: a text that states a confirmed price must say which channel it is.

const PROCESS_CLAIMS = [
  /(v[ée]rifi|contr[ôo]l|regard|relis|relu|examin)\w*[^.\n]{0,60}(fichier|cadrage|photo|image)s?[^.\n]{0,40}(avant|pr[ée]alable)/i,
  /(fichier|cadrage|photo)s?\s+(v[ée]rifi|contr[ôo]l)\w*/i,
  /(chaque|tous? les|toutes? les)\s+(fichier|photo|cadrage)s?[^.\n]{0,40}(v[ée]rifi|contr[ôo]l)/i,
  /on\s+(v[ée]rifie|regarde|contr[ôo]le|relit)\w*\s+(ton|votre|chaque|le|les|vos|tes)\s*(fichier|cadrage|photo)/i,
];

/** Findings for a promise about a checking process (always refused until the owner confirms a systematic process). */
export const lintProcessClaims = (text) => PROCESS_CLAIMS.filter((re) => re.test(text)).map((re) => ({ code: 'PROCESS_CLAIM_UNCONFIRMED', excerpt: text.match(re)[0].slice(0, 60) }));

const CHANNEL_EVIDENCE = {
  IN_STORE: /prix en boutique|(?:€|euros?)\s*[:,(]?\s*en boutique|en boutique\s*[:,]?\s*\d/i,
  WEB: /prix (?:en ligne|web|sur (?:le site|habb\.be))|(?:€|euros?)\s*[:,(]?\s*(?:en ligne|sur (?:le site|habb\.be))/i,
};

/**
 * `confirmed`: facts like { excerpts: ['25 €'], requires: 'coque', channel: 'IN_STORE' | 'WEB' }. A fact WITH a channel can only appear in a text that names that channel.
 * (The web price is a separate fact with its own entry; it is not confirmed here, and it must match what the shop actually charges online.)
 */
export function lintPriceChannel(text, { confirmed = [] } = {}) {
  const t = text.replace(/ /g, ' ').toLowerCase();
  const out = [];
  for (const f of confirmed) {
    if (!f.channel) continue;
    const present = f.excerpts.some((x) => t.includes(x.replace(/ /g, ' ').toLowerCase())) && (!f.requires || t.includes(f.requires.toLowerCase()));
    if (present && !CHANNEL_EVIDENCE[f.channel].test(t)) out.push({ code: 'PRICE_CHANNEL_UNSTATED', channel: f.channel, excerpt: f.excerpts[0] });
  }
  return out;
}
