// Human-readable, actionable guidance for durable Core journal failures.
// Keep OS paths and raw server exceptions out of the customer-facing message.
// A failed acknowledgement does NOT establish that a decision was never written.
const JOURNAL_GUIDANCE = Object.freeze({
  JOURNAL_PROTECTED: 'JOURNAL_PROTECTED — Le journal de décisions est en protection après un incident d’écriture. Aucun nouvel enregistrement n’est autorisé. Une décision peut déjà être présente malgré l’erreur : faites vérifier le journal et l’historique par le responsable avant toute nouvelle tentative.',
  JOURNAL_TORN_TAIL: 'JOURNAL_TORN_TAIL — La dernière ligne du journal de décisions est incomplète. Le Core reste désactivé pour protéger les données. Ne modifiez pas le fichier et ne répétez pas la décision : demandez une récupération contrôlée à partir d’une copie.',
  JOURNAL_LOCK_PERMISSION: 'JOURNAL_LOCK_PERMISSION — Le serveur ne dispose pas des droits nécessaires pour verrouiller le journal. L’enregistrement n’a pas été tenté. Demandez au responsable de vérifier les permissions du dossier et du volume avant de réessayer.',
});

function journalCode(value) {
  const raw = typeof value === 'string' ? value : value?.body?.error ?? value?.body?.reason ?? '';
  return /^([A-Z][A-Z0-9_]*)(?=:|\s|$)/.exec(String(raw).trim())?.[1] ?? null;
}

export function coreDisabledReason(reason) {
  const code = journalCode(reason);
  return JOURNAL_GUIDANCE[code] ?? String(reason ?? 'Le Core est indisponible.');
}

export function coreErrorMessage(error) {
  const code = journalCode(error);
  if (JOURNAL_GUIDANCE[code]) return JOURNAL_GUIDANCE[code];
  if (error?.status === 401) return 'Session expirée : reconnectez-vous.';
  if (typeof error?.body?.message === 'string' && error.body.message.trim()) return error.body.message;
  if (error?.status === 503) return 'Le serveur est temporairement indisponible. Si vous veniez d’enregistrer une décision, vérifiez son historique avant de réessayer.';
  return 'Le serveur n’a pas pu répondre. Vérifiez l’état de votre demande avant de recommencer.';
}
