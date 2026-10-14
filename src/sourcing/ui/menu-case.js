// The active case shown in Salon is not necessarily the global case selected in
// Field/Expert. Always target the case the owner can see in the current screen.
export function activeMenuCase(S, globalCase, salonView = null) {
  const id = S.mode === 'salon' ? salonView?.caseId : null;
  return (id && S.cases[id]) || globalCase;
}

// Reanalysis is explicit, additive and idempotent. Pin the selected case between
// the preview and the confirmation, and NEVER read a stale blank background case.
// Every outcome, including errors and no-op, appears inside the open menu.
export function applyLegacyReanalysis({ S, menuCase, persist, commit, openMenu }) {
  const c = S.cases[S.reanalysisTargetId] ?? menuCase();
  S.reanalysisPrompt = false;
  S.reanalysisTargetId = null;
  if (!c) {
    S.reanalysisMessage = 'Aucun dossier actif à réanalyser.';
    return openMenu();
  }
  const name = c.identity?.workingName || c.id;
  try {
    const notes = (c.conversations ?? []).flatMap((conv) => conv.items ?? [])
      .filter((item) => item.speaker === 'supplier' &&
        typeof item.original === 'string' && item.original.trim());
    if (!notes.length) {
      S.reanalysisMessage = `Aucune ancienne note fournisseur à relire dans « ${name} ». Vérifiez le dossier actif.`;
      return openMenu();
    }
    const before = c.candidates.length;
    if (S.currentId !== c.id) { S.currentId = c.id; persist(); }
    commit({ type: 'CONVERSATION_REANALYZE' });
    const added = S.cases[c.id].candidates.length - before;
    S.reanalysisMessage = added
      ? `« ${name} » : ${added} nouvelle(s) proposition(s) ajoutée(s) à vérifier. Aucun fait confirmé ou rejeté n’a changé.`
      : `« ${name} » : aucune nouvelle proposition. Les notes avaient déjà été lues.`;
  } catch (e) {
    S.reanalysisMessage = `« ${name} » : réanalyse impossible (${String(e?.message ?? e)}). Aucune proposition confirmée automatiquement.`;
  }
  return openMenu();
}
