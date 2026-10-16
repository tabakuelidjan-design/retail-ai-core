#!/usr/bin/env node
// Command line for the HABB social publishing store (local files under data/local/social). Nothing here calls a platform.
//
//   node src/social/cli.js seed-facts                       write the owner-confirmed facts registry (the coque price only)
//   node src/social/cli.js import-editorial <dir> [--register A|B] [--ids P01,P02]
//                                                           import chantier D's reserve (<dir>/posts.json + <dir>/visuels) as posts
//   node src/social/cli.js jpeg-for-meta                   export JPEG copies of the PNG pictures of IMAGE posts (needs Python + Pillow); the
//                                                           posts are switched to the JPEG (new asset => any approval is void); PNGs are kept
//   node src/social/cli.js status                           every post, one line each
//   node src/social/cli.js calendar [--from YYYY-MM-DD] [--out file.md]   the 14-day calendar as Markdown
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mapEditorialReserve } from './adapters/habb-editorial.js';
import { createAssetLibrary } from './assets.js';
import { brusselsParts, buildCalendar } from './calendar.js';
import { STATE_LABEL_FR } from './constants.js';
import { readinessProblems } from './post.js';
import { createSocialService } from './service.js';
import { createFileStore } from './store.js';

export const DATA_DIR = 'data/local/social';
const CONFIRMED_FACTS = {
  facts: [{
    id: 'coque-25', excerpts: ['25 €', '25,00 €', '25 euros', '25 EUR'], requires: 'coque',
    source: 'Prix validé par le propriétaire (coque personnalisée 25,00 €, 2026-08-05) - CLAUDE.md du projet HABB, HABB_OS/PRICING.md', confirmed_at: '2026-08-05',
  }],
};

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

async function loadFacts(dir) {
  try { return JSON.parse(await readFile(join(dir, 'confirmed-facts.json'), 'utf8')).facts ?? []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export function renderCalendarMarkdown({ calendar, posts, confirmed = [] }) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const L = [];
  L.push(`# Calendrier de publication — ${calendar.from} → ${calendar.to} (${calendar.timezone})`, '');
  L.push('| Catégorie | Nombre |', '|---|---|');
  for (const [k, label] of [['programmable', 'Approuvés et programmables'], ['awaiting_approval', 'En attente de votre approbation'], ['needs_correction', 'À corriger'], ['missing_asset', 'Visuel manquant'], ['published', 'Publiés'], ['cancelled', 'Annulés']]) L.push(`| ${label} | ${calendar.buckets[k].length} |`);
  L.push('');
  for (const d of calendar.days) {
    L.push(`## ${d.weekday} ${d.date}`);
    if (!d.entries.length) L.push('_rien de prévu_');
    for (const e of d.entries) {
      const p = byId.get(e.post_id);
      const problems = readinessProblems(p, { confirmed });
      L.push(`- **${e.time}** ${e.platform} · ${e.format} · ${e.subject} — ${STATE_LABEL_FR[p.state]}${problems.length ? ` — ⚠ ${problems.join(', ')}` : ''}  \`${p.id}\``);
    }
    L.push('');
  }
  if (calendar.unplaced.length) L.push('## Sans date', ...calendar.unplaced.map((id) => `- ${byId.get(id).subject.label} (${byId.get(id).platform} ${byId.get(id).format}) \`${id}\``), '');
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2), { dir = DATA_DIR, log = console.log } = {}) {
  const [cmd, ...args] = argv;
  await mkdir(dir, { recursive: true });
  if (cmd === 'seed-facts') {
    await writeFile(join(dir, 'confirmed-facts.json'), `${JSON.stringify(CONFIRMED_FACTS, null, 2)}\n`);
    log(`écrit ${join(dir, 'confirmed-facts.json')} : 1 fait confirmé (coque 25 €). Supprimez le fichier pour bloquer de nouveau tout prix.`);
    return 0;
  }
  const confirmed = await loadFacts(dir);
  const service = createSocialService({ store: createFileStore(dir), confirmedFacts: confirmed });
  if (cmd === 'import-editorial') {
    const from = resolve(args[0] ?? '');
    const posts = JSON.parse(await readFile(join(from, 'posts.json'), 'utf8'));
    const library = createAssetLibrary(join(dir, 'assets'));
    const ids = flag(args, '--ids')?.split(',') ?? null;
    const { proposals, skipped } = await mapEditorialReserve(posts, { dir: from, library, register: flag(args, '--register') ?? 'A', ids });
    const report = await service.importProposals(proposals, { id: 'chantier-d', role: 'agent' });
    const tally = {};
    for (const r of report) tally[r.result] = (tally[r.result] ?? 0) + 1;
    log(`importé : ${JSON.stringify(tally)} ; ignoré (hors périmètre E) : ${skipped.length}`);
    for (const s of skipped) log(`  ignoré ${s.id} / ${s.channel} : ${s.reason}`);
    for (const r of report.filter((x) => x.problems || x.error)) log(`  ${r.proposal_id.split(':').pop()} ${r.platform}/${r.format} : ${r.error ?? r.problems.join(', ')}`);
    return 0;
  }
  if (cmd === 'jpeg-for-meta') {
    const library = createAssetLibrary(join(dir, 'assets'));
    const exec = promisify(execFile);
    const agent = { id: 'chantier-e', role: 'agent' };
    const tally = { exported: 0, switched: 0, skipped: 0 };
    for (const post of await service.list()) {
      const a = post.asset;
      if (post.format !== 'IMAGE' || !a || a.content_type !== 'image/png' || ['PUBLISHED', 'VERIFIED', 'PUBLISHING', 'CANCELLED'].includes(post.state)) { tally.skipped += 1; continue; }
      const png = await library.read(a);
      const ref = `${a.ref}-jpeg`;
      let jpeg = (await library.list()).find((x) => x.ref === ref && x.version === 1);
      if (!jpeg) {
        const tmp = join(dir, 'assets', `.export-${a.sha256.slice(0, 12)}`);
        await mkdir(tmp, { recursive: true });
        const src = join(tmp, 'in.png'); const out = join(tmp, 'out.jpg');
        await writeFile(src, png.bytes);
        await exec('python', ['scripts/social-export-jpeg.py', src, out, '92']);
        jpeg = await library.register({ ref, version: 1, file: out, bytes: await readFile(out) });
        tally.exported += 1;
      }
      const next = { ref: jpeg.ref, version: 1, sha256: jpeg.sha256, content_type: 'image/jpeg', width: a.width, height: a.height, ai_generated: a.ai_generated, ...(a.alt_text ? { alt_text: a.alt_text } : {}) };
      await service.editPost(post.id, { asset: next }, agent);
      const after = await service.get(post.id);
      if (after.state === 'DRAFT') await service.act(post.id, 'submit', agent);
      tally.switched += 1;
    }
    log(`jpeg-for-meta : ${JSON.stringify(tally)} - les PNG d'origine sont conservés ; toute approbation antérieure est annulée.`);
    return 0;
  }
  if (cmd === 'status') {
    for (const p of await service.list()) log(`${p.id}  ${STATE_LABEL_FR[p.state].padEnd(22)} ${p.platform.padEnd(9)} ${p.format.padEnd(8)} ${p.publish_at ? brusselsParts(p.publish_at).date : '----------'}  ${p.subject.label}`);
    return 0;
  }
  if (cmd === 'calendar') {
    const posts = await service.list();
    const from = flag(args, '--from') ?? brusselsParts(new Date().toISOString()).date;
    const md = renderCalendarMarkdown({ calendar: buildCalendar({ posts, from, days: 14, confirmed }), posts, confirmed });
    const out = flag(args, '--out');
    if (out) { await writeFile(out, md); log(`écrit ${out}`); } else log(md);
    return 0;
  }
  log('commandes : seed-facts | import-editorial <dossier> [--register A|B] [--ids P01,..] | status | calendar [--from AAAA-MM-JJ] [--out fichier.md]');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(undefined, { dir: process.env.SOCIAL_DATA_DIR || DATA_DIR });
