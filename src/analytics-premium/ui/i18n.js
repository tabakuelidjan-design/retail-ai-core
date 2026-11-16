'use strict';
// Nordla AI i18n runtime. Language priority: FR (default/primary) -> NL -> EN.
// Plain global script (same convention as the rest of this UI) so language dictionaries can be
// added/edited without touching any component. Components must never hardcode display copy -
// they call NORDLA_I18N.t(key, ...args) and every string lives in lang-fr.js/lang-nl.js/lang-en.js.
window.NORDLA_I18N = (function () {
  const STORAGE_KEY = 'nordla_lang';
  const SUPPORTED = ['fr', 'nl', 'en'];
  const DEFAULT_LANG = 'fr';
  let current = DEFAULT_LANG;
  try { const saved = localStorage.getItem(STORAGE_KEY); if (SUPPORTED.includes(saved)) current = saved; } catch (e) { /* private mode / blocked storage: fall back to default */ }

  function dict(lang) { return (window.NORDLA_DICTS && window.NORDLA_DICTS[lang]) || null; }

  /** t(key, ...args): looks up `key` in the active language, falling back to FR then EN, then the
   * key itself (visibly, so a missing translation is obvious during development, never a blank). */
  function t(key, ...args) {
    const raw = dict(current)?.[key] ?? dict('fr')?.[key] ?? dict('en')?.[key] ?? key;
    return args.length ? raw.replace(/\{(\d+)\}/g, (_, i) => (args[i] != null ? args[i] : '')) : raw;
  }
  function getLang() { return current; }
  function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* non-fatal */ }
  }
  return { t, getLang, setLang, SUPPORTED, DEFAULT_LANG };
})();
