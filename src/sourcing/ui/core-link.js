// Deep links from the Nordla menu of the other modules (/?ouvrir=parle | analyses | finance): the same action as the Core button,
// once the Core home has drawn it. The parameter is removed first, so a reload does not repeat the action.
// Kept out of app.js (its size is guarded by test/sourcing-v1-ui-modules.test.js).
export function openFromLink() {
  const want = new URLSearchParams(location.search).get('ouvrir');
  if (!want) return;
  if (want === 'analyses') { location.replace('/analyses/'); return; }
  if (want === 'parle') { history.replaceState(null, '', '/'); document.dispatchEvent(new CustomEvent('nordla:parle')); return; }
  const act = { analyses: 'nx-open-analytics', finance: 'nx-open-finance' }[want];
  if (!act) return;
  history.replaceState(null, '', '/');
  const clickIfDrawn = () => { const b = document.querySelector(`[data-act="${act}"]`); if (b) { b.click(); return true; } return false; };
  if (clickIfDrawn()) return;
  const watch = new MutationObserver(() => { if (clickIfDrawn()) watch.disconnect(); });
  watch.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => watch.disconnect(), 20000); // the button is shown only to the people allowed to open this module
}
