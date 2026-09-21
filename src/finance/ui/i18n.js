'use strict';
// Finance dashboard i18n layer. French is the default (first market: Wallonia / Belgium), Dutch and English are available.
// The UI language is separate from the language of the documents (invoice / quote language is a per-document setting).
//
//   tt('Due in {0} days', n)   parameterised message: the English text is the message id, {0} {1} are positional parameters
//   tr(text)                   translate a whole piece of text (used at the DOM boundary, so components keep plain message ids)
//
// Dictionaries live in lang-fr.js and lang-nl.js (window.FINANCE_LANG.fr / .nl = { messages, patterns }). A missing entry falls back to the
// English text and is recorded in I18N.missing so that a review (and the tests) can list what is still untranslated.

(function () {
  const LANGS = ['fr', 'nl', 'en'];
  const TAGS = { fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' };
  const dict = () => (window.FINANCE_LANG || {});
  let lang = 'fr';
  try { const s = window.localStorage.getItem('finance.lang'); if (LANGS.includes(s)) lang = s; } catch (e) { /* storage may be blocked: French stays the default */ }
  const missing = new Set();

  const fmt = (s, args) => s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined || args[i] === null ? '' : String(args[i])));
  const looksTranslatable = (s) => /[A-Za-z]{3,}/.test(s) && /^[A-Z(+\-"]/.test(s);

  function lookup(key) {
    if (lang === 'en') return key;
    const d = dict()[lang];
    const v = d && d.messages ? d.messages[key] : undefined;
    if (v !== undefined) return v;
    return undefined;
  }
  /** Parameterised message. */
  function tt(key, ...args) {
    const v = lookup(key);
    if (v === undefined && lang !== 'en') missing.add(key);
    return fmt(v === undefined ? key : v, args);
  }
  /** Translate a text: exact message, then patterns (server messages with numbers), then sentence by sentence. Unknown text is returned unchanged. */
  function tr(text) {
    if (typeof text !== 'string' || lang === 'en') return text;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const core = m[2];
    if (!core || !/[A-Za-z]/.test(core)) return text;
    const exact = lookup(core);
    if (exact !== undefined) return m[1] + exact + m[3];
    const d = dict()[lang];
    if (d && d.patterns) for (const [re, out] of d.patterns) { const r = re.exec(core); if (r) return m[1] + fmt(out, r.slice(1)) + m[3]; }
    const sentences = core.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) {
      let hit = false;
      const parts = sentences.map((s) => { const e = lookup(s); if (e !== undefined) { hit = true; return e; } if (d && d.patterns) for (const [re, out] of d.patterns) { const r = re.exec(s); if (r) { hit = true; return fmt(out, r.slice(1)); } } return s; });
      if (hit) return m[1] + parts.join(' ') + m[3];
    }
    if (looksTranslatable(core)) missing.add(core);
    return text;
  }
  function setLang(l) { if (!LANGS.includes(l)) return; lang = l; try { window.localStorage.setItem('finance.lang', l); } catch (e) { /* ignore */ } document.documentElement.setAttribute('lang', l); }
  document.documentElement.setAttribute('lang', lang);
  window.I18N = { LANGS, tt, tr, setLang, getLang: () => lang, tag: () => TAGS[lang], missing, reset: () => missing.clear() };
  window.tt = tt; window.tr = tr;
})();
