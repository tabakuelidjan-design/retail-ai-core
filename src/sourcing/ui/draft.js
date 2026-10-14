// Draft preservation (extracted from app.js, no change): whatever the owner typed but did not submit survives ANY re-render (connection blip, status check, Safety Gate download).
// INVARIANT (also for the future voice recorder): a background render must never destroy user input or a running capture. Capture state lives OUTSIDE the DOM; screens are rebuilt from state.

export const formKey = (f) => `${f.dataset.form}:${f.dataset.id ?? ''}`;
export function captureDrafts(root) {
  const out = {};
  for (const f of root.querySelectorAll('form[data-form]')) for (const el of f.elements) {
    if (!el.name || ['file', 'password', 'submit', 'button'].includes(el.type)) continue;
    const dirtyField = el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : (el.type === 'checkbox' || el.type === 'radio') ? el.checked !== el.defaultChecked : el.value !== el.defaultValue;
    if (dirtyField) ((out[formKey(f)] ??= {})[el.name] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value);
  }
  return out;
}
export function restoreDrafts(root, drafts, focus) {
  for (const f of root.querySelectorAll('form[data-form]')) {
    const d = drafts[formKey(f)]; if (!d) continue;
    for (const [name, v] of Object.entries(d)) { const el = f.elements[name]; if (!el || el.length !== undefined && !el.tagName) continue; if (el.type === 'checkbox' || el.type === 'radio') el.checked = v; else el.value = v; }
  }
  if (focus) { const f = [...root.querySelectorAll('form[data-form]')].find((x) => formKey(x) === focus.form); const el = f?.elements[focus.name]; if (el?.focus) { try { el.focus({ preventScroll: true }); if (focus.pos != null && el.setSelectionRange) el.setSelectionRange(focus.pos, focus.pos); } catch { /* not focusable */ } } }
}
