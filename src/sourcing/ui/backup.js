// SERVER BACKUP of what the server does NOT have yet (extracted from app.js): the photos of each case, and the cases it has never received.
// Until this, a photo lived only on the phone (IndexedDB) and the case sync carried the JSON alone. Rules:
//   - the phone keeps everything: nothing is deleted, here or on the server;
//   - nothing is overwritten: a photo key the server already holds is left alone (a DIFFERENT photo under that key comes back as PHOTO_CONFLICT,
//     reported, both copies kept); a case is sent only when the server has NO copy of it at all;
//   - AUTOMATIC run: only the photos of cases the server already holds. A case is never created on the server without the owner (the rule
//     "only what the owner changed is sent" stays: a freshly paired phone, an imported case or an old phone sends no case by itself);
//   - OWNER run (menu button "Sauvegarder sur le serveur"): also sends the cases the server has never received, then their photos;
//   - a case the owner is changing (marked for sync) is left to sync(): the backup only fills gaps, it never competes with a revision;
//   - it never runs during a sync, the automatic run at most once a minute, and only when the server is verified.

export function createBackup({ S, ls, api, getBlob, photoKeysFor, dirty, isSyncing, persist, paintHeader, refresh = () => {}, now = () => Date.now() }) {
  let running = false; let last = 0;
  async function run({ force = false, includeNewCases = false } = {}) {
    if (!S.token || !S.online || running || isSyncing() || (!force && now() - last < 60000)) return S.backup;
    running = true; last = now();
    const out = { cases: 0, photos: 0, conflicts: [], failed: 0, waiting: 0, notSent: 0, byOwner: includeNewCases };
    try {
      const onServer = new Set(((await api('/api/cases')).cases ?? []).map((x) => x.id));
      for (const c of Object.values(S.cases)) {
        if (dirty.has(c.id)) { out.waiting += 1; continue; }
        if (!onServer.has(c.id)) {
          if (!includeNewCases) { out.notSent += 1; continue; } // never sent: it waits for the owner's explicit backup
          try {
            const saved = await api(`/api/cases/${encodeURIComponent(c.id)}`, { method: 'PUT', body: JSON.stringify(c) });
            if (S.cases[c.id] && S.cases[c.id].updatedAt === c.updatedAt) S.cases[c.id] = { ...S.cases[c.id], rev: saved.rev };
            out.cases += 1;
          } catch { out.failed += 1; continue; }
        }
        const have = new Map(((await api(`/api/cases/${encodeURIComponent(c.id)}/photos`)).photos ?? []).map((x) => [x.key, x.sha256]));
        for (const key of photoKeysFor(c, c.id)) {
          const local = getBlob(key); if (typeof local !== 'string' || !local.startsWith('data:image/')) continue;
          if (have.has(key)) { const mine = await sha256OfDataUrl(local); if (mine === have.get(key)) continue; if (mine) { out.conflicts.push(key); continue; } } // same bytes: done; different: reported, never sent over; unknown (no WebCrypto): the server decides below
          try { await api(`/api/cases/${encodeURIComponent(c.id)}/photos/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ dataUrl: local }) }); out.photos += 1; }
          catch (e) { if (e.status === 409 && e.body?.error === 'PHOTO_CONFLICT') out.conflicts.push(key); else out.failed += 1; }
        }
      }
      S.backup = { ...out, at: new Date(now()).toISOString(), ok: out.failed === 0 };
    } catch { S.backup = { ...out, at: new Date(now()).toISOString(), ok: false }; }
    finally { running = false; ls.set('nordla.sourcing.backup', S.backup); persist(); paintHeader(); }
    return S.backup;
  }
  // the owner's explicit backup (menu): every case of this phone that the server lacks, then all photos
  if (typeof document !== 'undefined') document.addEventListener('click', async (ev) => { if (!ev.target.closest?.('[data-act="backup-all"]')) return; S.backupBusy = true; refresh(); await run({ force: true, includeNewCases: true }); S.backupBusy = false; refresh(); });
  return { run };
}

/** The menu section (HTML) that states what is backed up on the server and offers the owner's full backup. */
export function backupSection({ backup, online, hasToken, busy, esc }) {
  const b = backup; const when = b?.at ? new Date(b.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const state = !b ? 'Aucune sauvegarde serveur encore faite depuis ce téléphone.'
    : b.ok ? `Dernière vérification le ${when} : ${b.photos} photo(s) envoyée(s)${b.byOwner ? `, ${b.cases} dossier(s) envoyé(s)` : ''}${b.notSent ? ` · ${b.notSent} dossier(s) jamais envoyé(s) restent seulement sur ce téléphone` : ''}${b.conflicts?.length ? ` · ${b.conflicts.length} photo(s) différente(s) déjà sur le serveur : les deux versions sont gardées` : ''}.`
    : `La dernière sauvegarde (${when}) n’a pas abouti : rien n’a été perdu, tout reste sur ce téléphone.`;
  return `<h2>Sauvegarde sur le serveur</h2>
  <p class="small muted">Les photos des dossiers déjà sur le serveur y sont copiées automatiquement. Un dossier jamais envoyé reste seulement sur ce téléphone tant que vous ne l’envoyez pas. Rien n’est supprimé, ni ici ni sur le serveur.</p>
  <p class="small">${esc(state)}</p>
  <button class="btn" data-act="backup-all" ${online && hasToken && !busy ? '' : 'disabled'}>${busy ? 'Sauvegarde en cours…' : 'Sauvegarder sur le serveur tous les dossiers de ce téléphone (avec photos)'}</button>`;
}

/** SHA-256 (hex) of the bytes of a data URL, the hash the server keeps; null where WebCrypto is unavailable (an insecure origin). */
export async function sha256OfDataUrl(dataUrl) {
  try {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/** The server copy of the photos of one case (GET only), for "Récupérer mes dossiers". A photo the server cannot give back is counted, never invented. */
export async function fetchCasePhotos(api, id) {
  const photos = {}; let missing = 0;
  try {
    for (const p of (await api(`/api/cases/${encodeURIComponent(id)}/photos`)).photos ?? []) {
      try { photos[p.key] = (await api(`/api/cases/${encodeURIComponent(id)}/photos/${encodeURIComponent(p.key)}`)).dataUrl; } catch { missing += 1; }
    }
  } catch { return { photos, note: 'les photos n’ont pas pu être lues sur le serveur.' }; }
  return { photos, note: missing ? `${missing} photo(s) n’ont pas pu être lues sur le serveur.` : null };
}
