// "Récupérer mes dossiers": the menu section that brings cases back onto this phone (from the server list, or from an exported JSON file). HTML only; the actions live in app.js.
// Nothing is imported until the owner ticks a case and presses "Récupérer". A case already on the phone is never replaced.
import { esc } from './dom.js';

const REL = { INCOMING_AHEAD: 'la copie à récupérer contient tout ce que vous avez ici, et plus', LOCAL_AHEAD: 'votre copie sur ce téléphone contient tout ce que contient celle-ci, et plus', DIVERGED: 'les deux copies ont chacune des changements que l’autre n’a pas' };
const ERR = { EMPTY: 'Le fichier est vide.', TOO_BIG: 'Le fichier est trop gros (8 Mo maximum).', NOT_JSON: 'Ce fichier n’est pas un export Nordla (JSON illisible).', NOT_A_CASE: 'Ce fichier ne contient pas un dossier Nordla complet.', BAD_ID: 'Le dossier a un identifiant invalide.', FORBIDDEN_KEY: 'Le fichier contient des champs interdits : refusé.', NEWER_SCHEMA: 'Ce dossier vient d’une version plus récente de Nordla : refusé pour ne rien abîmer.', NEWER_FORMAT: 'Ce format d’export est plus récent que cette application.' };
export const recoveryError = (code) => ERR[code] ?? 'Ce fichier n’a pas pu être lu.';

const when = (iso) => esc(String(iso ?? '').slice(0, 16).replace('T', ' '));
const counts = (d) => `${d.conversations} conversation(s) · ${d.candidates} fait(s) proposé(s) · ${d.ledger} confirmé(s) · ${d.corrections} corrigé(s) · ${d.rejected} rejeté(s) · ${d.events} événement(s) · ${d.photos} photo(s)`;
const side = (title, d) => `<div class="card"><b>${title}</b><br><span class="small">Version ${d.rev} · modifié ${when(d.updatedAt)}</span><br><span class="small muted">${counts(d)}</span></div>`;

export function recoverySection(rec, { online, hasToken, local }) {
  const r = rec ?? {};
  const list = (r.list ?? []).map((c) => {
    const here = local[c.id] ? '<span class="chip">déjà sur ce téléphone</span>' : '';
    return `<label class="card" style="display:block"><input type="checkbox" data-act="rec-toggle" data-key="${esc(c.id)}" ${r.selected?.[c.id] ? 'checked' : ''}> <b>${esc(c.name || 'Sans nom')}</b> ${here}<br><span class="small muted">${esc(c.supplier ?? 'fournisseur inconnu')} · version ${c.rev} · modifié ${when(c.updatedAt)}</span></label>`;
  }).join('');
  const nSel = Object.values(r.selected ?? {}).filter(Boolean).length;
  const pending = (r.pending ?? []).map((p) => `<div class="warn"><b>${esc(p.incoming.name || p.id)}</b> existe déjà sur ce téléphone avec un contenu différent. Rien n’a été remplacé.<br><span class="small">${esc(REL[p.relation] ?? '')}</span>
    ${side('Sur ce téléphone', p.local)}${side('À récupérer', p.incoming)}
    <div class="row"><button class="btn" data-act="rec-keep" data-key="${esc(p.id)}">Garder les deux</button> <button class="btn sec" data-act="rec-skip" data-key="${esc(p.id)}">Ignorer</button></div></div>`).join('');
  const done = (r.results ?? []).map((x) => `<li>${esc(x)}</li>`).join('');
  return `<h2>Récupérer mes dossiers</h2>
  <p class="small muted">Retrouvez d’anciens dossiers fournisseurs : depuis votre serveur, ou depuis un fichier exporté. Rien n’est importé sans votre choix, et un dossier déjà présent ici n’est jamais remplacé.</p>
  <div class="row"><button class="btn" data-act="rec-list" ${online && hasToken ? '' : 'disabled'}>Voir les dossiers du serveur</button> <label class="btn sec" style="cursor:pointer">Importer un fichier exporté<input type="file" accept=".json,application/json" data-act="rec-file" hidden></label></div>
  ${online && hasToken ? '' : '<p class="small muted">Serveur injoignable ou jeton absent : l’import d’un fichier fonctionne quand même.</p>'}
  ${r.error ? `<p class="warn">${esc(r.error)}</p>` : ''}
  ${r.list ? (r.list.length ? `${list}<button class="btn" data-act="rec-go" ${nSel ? '' : 'disabled'}>Récupérer ${nSel ? `(${nSel})` : ''}</button>` : '<p>Le serveur ne contient aucun dossier.</p>') : ''}
  ${pending}${done ? `<ul class="small">${done}</ul>` : ''}
  <p class="small muted">Les photos ne sont pas stockées sur le serveur : elles ne reviennent que via un export fait avec cette version (« Export » du menu les inclut).</p>`;
}
