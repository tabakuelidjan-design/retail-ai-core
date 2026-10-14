// SAVE / SYNC STATE in plain French (extracted from app.js). Pure helpers over the one shared state object: they say what is true about the save, keep every version on a conflict (the owner's version is ALWAYS kept as a
// separate case, photos included), and give an export a message the owner can understand. "À jour" is said ONLY when the server has verified it and nothing is waiting; a case is "à jour" only when the server returned
// its revision and it was not changed since.
import { caseFacts } from '/core/case-facts.js';
import { factValueText } from './screens/salon-views.js';

export function createSyncHelpers({ S, dirty, status, persist, markDirty, queueSync, ping, sync, getBlob, putBlob, buildExport }) {
function syncInfo(caseId = null) {
  const conflicts = Object.keys(S.conflicts ?? {}).length; const waiting = dirty.size; const st = status().server.state; const verified = st === 'VERIFIED';
  let kind; let label; let detail;
  if (conflicts) { kind = 'conflict'; label = conflicts > 1 ? `${conflicts} conflits` : '1 conflit'; detail = 'Un dossier a été modifié ailleurs en même temps. Rien n\'a été écrasé : ouvrez les différences pour choisir.'; }
  else if (!S.token) { kind = 'local'; label = 'Sur ce téléphone'; detail = 'Aucun serveur n\'est configuré : vos dossiers sont enregistrés sur ce téléphone seulement. Exportez-les pour en garder une copie.'; }
  else if (!verified) { kind = 'offline'; label = waiting ? `Hors ligne · ${waiting} à envoyer` : 'Hors ligne'; detail = `Le serveur ne répond pas (ou refuse le jeton). Tout est enregistré sur le téléphone${waiting ? ` ; ${waiting} dossier${waiting > 1 ? 's' : ''} attend${waiting > 1 ? 'ent' : ''} d\'être envoyé${waiting > 1 ? 's' : ''}` : ''}. L\'envoi reprendra tout seul au retour du réseau.`; }
  else if (waiting) { kind = 'pending'; label = `Envoi en cours (${waiting})`; detail = `${waiting} dossier${waiting > 1 ? 's' : ''} modifié${waiting > 1 ? 's' : ''} n\'${waiting > 1 ? 'ont' : 'a'} pas encore été confirmé${waiting > 1 ? 's' : ''} par le serveur.`; }
  else { kind = 'synced'; label = 'Serveur à jour'; detail = 'Le serveur vient de confirmer : tous les dossiers modifiés ici ont été envoyés.'; }
  const c = caseId ? S.cases[caseId] : null; let caseKind = 'local'; let caseLabel = 'Enregistré sur le téléphone';
  if (c) { if ((S.conflicts ?? {})[caseId]) { caseKind = 'conflict'; caseLabel = 'Conflit de synchronisation'; } else if (dirty.has(caseId)) { caseKind = 'pending'; caseLabel = verified ? 'En cours d\'envoi' : 'Enregistré · envoi en attente'; } else if (verified && c.rev > 0) { caseKind = 'synced'; caseLabel = 'Copie serveur à jour'; } else if (S.token) { caseKind = 'local'; caseLabel = 'Enregistré sur le téléphone · pas encore sur le serveur'; } }
  return { kind, label, detail, caseKind, caseLabel };
}
/** Both sides of every conflict, with the confirmed facts that differ: nothing is hidden, nothing is replaced yet. */
function conflictVersions() {
  const when = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const entries = (c) => [...(c.conversations ?? []).flatMap((x) => x.items.flatMap((i) => [{ id: `${x.id}/${i.id}`, kind: i.answersQuestion ? 'Réponse du fournisseur' : i.speaker === 'me' ? 'Note (vous)' : 'Note (fournisseur)', text: String(i.original ?? i.derived?.find((d) => d.kind === 'TRANSCRIPTION')?.text ?? '').slice(0, 120) }, ...(Array.isArray(i.revisions) ? i.revisions : []).map((r) => ({ id: `${x.id}/${i.id}/${r.id}`, kind: 'Correction d\'une phrase', text: String(r.text ?? '').slice(0, 120) }))])), ...(c.notes ?? []).map((n) => ({ id: `note/${n.id ?? n.at}`, kind: 'Note libre', text: String(n.text ?? '').slice(0, 120) }))];
  const stat = (c) => ({ updatedText: when(c.updatedAt), notes: (c.conversations ?? []).reduce((n, x) => n + x.items.length, 0) + (c.notes ?? []).length, offers: (c.offers ?? []).length, facts: (() => { try { return caseFacts(c).length; } catch { return 0; } })() });
  return Object.entries(S.conflicts ?? {}).map(([id, sv]) => {
    const mine = S.cases[id]; if (!mine || !sv) return null; let diffs = [];
    try { const fm = new Map(caseFacts(mine).map((f) => [f.fact_type, f])); const fs = new Map(caseFacts(sv).map((f) => [f.fact_type, f])); diffs = [...new Set([...fm.keys(), ...fs.keys()])].filter((t) => JSON.stringify(fm.get(t)?.value ?? null) !== JSON.stringify(fs.get(t)?.value ?? null)).map((t) => ({ label: (fm.get(t) ?? fs.get(t)).label, mine: fm.has(t) ? factValueText(fm.get(t)) : 'absent', server: fs.has(t) ? factValueText(fs.get(t)) : 'absent' })); } catch { /* the counts are still shown */ }
    const em = entries(mine); const es = entries(sv); const ids = (l) => new Set(l.map((e) => e.id));
    return { id, title: `${mine.supplier?.name ?? 'Fournisseur'} · ${mine.identity?.workingName || id}`, mine: stat(mine), server: stat(sv), diffs, onlyMine: em.filter((e) => !ids(es).has(e.id)).slice(0, 4), onlyServer: es.filter((e) => !ids(em).has(e.id)).slice(0, 4) };
  }).filter(Boolean);
}
/** The owner's version is ALWAYS kept: it becomes a separate case (photos included). "Both" keeps the server's under the original name; "server" does the same and names the copy "avant remplacement". */
async function saveMineAsCopy(id, label) {
  const mine = S.cases[id]; const copyId = `${id}-mine-${Date.now().toString(36)}`; const copy = { ...JSON.parse(JSON.stringify(mine)), id: copyId, rev: 0, identity: { ...mine.identity, workingName: `${mine.identity.workingName || 'Dossier'} (${label})` } };
  for (let i = 0; i < (mine.identity?.photos ?? []).length; i++) { const p = getBlob(`photo:${id}.${i}`); if (p) await putBlob(`photo:${copyId}.${i}`, p); }
  for (const d of mine.documents ?? []) { const p = d.id !== undefined ? getBlob(`docphoto:${id}.${d.id}`) : null; if (p) await putBlob(`docphoto:${copyId}.${d.id}`, p); }
  S.cases[copyId] = copy; markDirty(copyId); return copyId;
}
async function resolveConflict(id, label, done) {
  const sv = (S.conflicts ?? {})[id]; const mine = S.cases[id]; if (!sv || !mine) return;
  await saveMineAsCopy(id, label); S.cases[sv.id] = sv; delete S.conflicts[id]; persist(); done?.(); queueSync();
}
const keepBoth = (id, done) => resolveConflict(id, 'ma copie', done);
const takeServer = (id, done) => resolveConflict(id, 'ma version avant remplacement', done);
async function syncNow() {
  if (!S.token) return 'Aucun serveur n\'est configuré : rien à envoyer. Exportez vos dossiers pour en garder une copie.';
  await ping(); if (S.online) await sync(); const si = syncInfo(); return si.kind === 'synced' ? 'Tout est envoyé : le serveur a confirmé.' : si.detail;
}
function exportCase(id) {
  const c = S.cases[id]; if (!c) return 'Aucun dossier à exporter.';
  try { const json = buildExport(c, getBlob); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = `nordla-case-${c.id}.json`; a.click(); return `Export créé : ${a.download} (${Math.max(1, Math.round(json.length / 1024))} Ko). Il contient le dossier, ses notes et ses photos : gardez ce fichier.`; }
  catch (e) { return `L'export a échoué (${e?.message ?? e}). Rien n'a été modifié.`; }
}
  return { syncInfo, conflictVersions, keepBoth, takeServer, syncNow, exportCase };
}
