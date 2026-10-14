// The detailed screens of the former Expert and Guided modes, rendered INSIDE the one navigation (owner decision: one interface). Same functions, same handlers, same case: no mode switch.
// Also the settings sheet. Extracted from app.js (which stays a controller).
export function createEmbedded({ S, ls, cur, run, status, render, SCREENS, fmNav, fieldFirst, fmCompute, turnClosesAt, esc }) {
/** The detailed screens of the former Expert and Guided modes, rendered INSIDE the one navigation: the same functions, the same handlers and the same case, no mode switch. kind = 'live' (the live conversation) or an expert section key. */
  return function embeddedHtml(kind) {
  const c = cur(); clearTimeout(S.fmTimer); clearTimeout(S.turnTimer); S.fmStatus = status();
  try { S.A = run(c); S.error = null; } catch (e) { S.error = e; console.error(e); return `<div class="nx-flash">Cet écran n'a pas pu être calculé. Votre dossier est enregistré. ${esc(String(e.message ?? e))}</div>`; }
  { const cfgT = ls.get('nordla.sourcing.turns', null); const t = Date.now(); const next = (c.conversations ?? []).flatMap((v) => v.items).map((i) => turnClosesAt(i, cfgT)).filter((x) => x !== null && x > t).sort((a, b) => a - b)[0]; if (next) S.turnTimer = setTimeout(render, next - t + 30); }
  if (kind === 'live') {
    try { const fmv = fmCompute(S.A, c); S.fmPrev = { caseId: c.id, state: fmv.state }; if (fmv.explicit && !fmv.show) S.flash = "Rien d'important à demander pour l'instant."; const wake = fmv.hold?.until ?? fmv.wake; if (wake) S.fmTimer = setTimeout(render, Math.max(50, wake - Date.now() + 30)); return `<div class="nx-live"><div class="nx-livenav">${fmNav()}</div>${fieldFirst(S.A, c, fmv)}</div>`; }
    catch (e) { console.error(e); return `<div class="nx-flash">La conversation n'a pas pu être calculée. Votre dossier est enregistré. ${esc(String(e.message ?? e))}</div>`; }
  }
  S.tab = SCREENS[kind] ? kind : 'decision';
  try { return SCREENS[S.tab](S.A, c); } catch (e) { console.error(e); return `<div class="nx-flash">Cet écran n'a pas pu être calculé. Votre dossier est enregistré. ${esc(String(e.message ?? e))}</div>`; }
}
}

export function settingsHtml({ S, active, esc }) {
  return `<button class="btn sec" data-act="close-overlay">Fermer</button><h2>Réglages et sauvegarde</h2>${active ? `<p class="small"><b>Dossier actif : ${esc(active.identity.workingName || active.id)}</b> — ${esc(active.supplier?.name || 'Fournisseur non renseigné')}</p>` : ''}${S.reanalysisMessage ? `<p class="warn" role="status">${esc(S.reanalysisMessage)}</p>` : ''}
  <h2>Serveur (facultatif)</h2><p class="small muted">Sans serveur, tout fonctionne hors ligne sur ce téléphone. Avec lui : les dossiers sont gardés sur votre serveur, la lecture des PDF et le cache Safety Gate sont disponibles.</p><label>Jeton d'accès<input id="tok" type="password" autocomplete="off" value="${esc(S.token)}"></label><button class="btn" data-act="savetoken" style="margin-top:8px">Enregistrer le jeton</button>
  <h2>Ce dossier</h2><button class="btn sec" data-act="export">Exporter en JSON</button><p class="small muted">Pour retrouver des informations oubliées dans d'anciennes notes : exportez d'abord ce dossier. La relecture n'ajoute que des propositions à confirmer, sans modifier les faits déjà acceptés ou rejetés.</p>${S.reanalysisPrompt ? `<p class="warn">Relire les notes originales du fournisseur dans cette fiche ? Aucun fait ne sera confirmé automatiquement.</p><button class="btn" data-act="notes-reanalyze-apply">Oui, ajouter les propositions</button> <button class="btn sec" data-act="notes-reanalyze-cancel">Annuler</button>` : '<button class="btn sec" data-act="notes-reanalyze-preview">Relire les anciennes notes</button>'}`;
}
