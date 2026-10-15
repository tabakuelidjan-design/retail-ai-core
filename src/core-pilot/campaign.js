// The first commercial chain in Nordla Core, reusing the existing engines only:
//   data (Analytics movers, with source) -> opportunity -> Branding (Guardian if approved, else labelled preview)
//   -> Marketing (buildCampaignContract: stock + approved-claims checks, owner_review PENDING, published false)
//   -> Creative (real provider configured? if not: PROVIDER_NOT_CONNECTED, nothing produced or simulated) -> HUMAN decision (journaled).
// Nothing is published, sent or paid: there is no publish path here at all. Proposals and decisions are appended to a file journal.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCampaignContract } from '../integration/handoffs.js';
import { ref } from '../integration/ids.js';
import { ID_KIND as K } from '../integration/constants.js';
import { loadAlibabaCreativeConfig } from '../marketing-creative/alibaba/config.js';

export const CREATIVE_REQUIRED_ENV = ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'];

/** What Creative can really do on this server (never a guess): the existing engine needs a generation provider. */
export function creativeCapability(env = process.env) {
  let cfg = null; let error = null;
  try { cfg = loadAlibabaCreativeConfig(env); } catch (e) { error = e.message; }
  const missing = CREATIVE_REQUIRED_ENV.filter((k) => !String(env[k] ?? '').trim());
  if (error || missing.length) {
    return { status: 'PROVIDER_NOT_CONNECTED', engine: 'runCreativeEndToEnd (src/creative-e2e) + Alibaba Model Studio ports (src/marketing-creative/alibaba)', missing, error,
      runsWithoutProvider: ['vérification des affirmations (marque, stock)', 'contrat de campagne', 'contrôles de cohérence'], note: 'Aucune création n’est produite ni simulée sans fournisseur. Activer un fournisseur = dépense : décision du propriétaire.' };
  }
  return { status: 'PROVIDER_CONFIGURED_NOT_VERIFIED', engine: 'runCreativeEndToEnd + Alibaba Model Studio', region: cfg.region, models: { text: cfg.textModel, image: cfg.imageModel }, note: 'Clés présentes : un premier appel réel doit encore être vérifié (budget plafonné, accord du propriétaire).' };
}

const DECISIONS = ['APPROVED_FOR_CREATION', 'REJECTED', 'DEFERRED'];

export function createCampaignService({ merchantId, branding, analytics = null, file, env = process.env, now = () => new Date().toISOString() }) {
  const brandProfile = () => ({ tenant_id: merchantId, brand_ref: `nordla:brand:${merchantId}`, approved_claims: branding.approvedClaims() });
  async function entries() { try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
  async function append(e) { await mkdir(dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(e)}\n`, { mode: 0o600 }); return e; }

  /** Prepare (never publish) a campaign proposal for a product, from identified data and constraints. */
  async function prepare({ product, objective, audience, channel, copy }, actor) {
    for (const [k, v] of Object.entries({ product, objective, audience, channel, copy })) if (!String(v ?? '').trim()) throw Object.assign(new Error(`champ manquant : ${k}`), { code: 'FIELD_REQUIRED', status: 400 });
    let opportunity = null;
    if (analytics) {
      const e = await analytics.salesEvolution();
      if (e.ok) {
        const find = (list) => list.find((i) => String(i.label ?? '').toLowerCase().includes(String(product).toLowerCase()));
        const hit = find(e.movers.growth) ?? find(e.movers.decline);
        opportunity = { source: e.source, period: { from: e.period.from, to: e.period.to }, freshness: e.freshness, product_fact: hit ? { label: hit.label, values: hit.values, direction: e.movers.growth.includes(hit) ? 'HAUSSE' : 'BAISSE' } : null, note: hit ? 'Fait Analytics (pas une cause).' : 'Ce produit ne figure pas parmi les plus fortes variations : aucune donnée de tendance spécifique.' };
      } else opportunity = { source: e.source, unavailable: e.error };
    }
    const brand = await branding.checkText(copy);
    const contract = buildCampaignContract({
      tenant_id: merchantId, product_ref: ref(K.PRODUCT, String(product).trim()), brand: brandProfile(), objective, audience, offer: null, channel,
      claims: [{ ref: `claim://copy/${createHash('sha256').update(copy).digest('hex').slice(0, 12)}`, kind: 'DESCRIPTIVE', role: 'BODY', wording: copy }],
      availability: { on_hand_known: false },
    });
    const creative = creativeCapability(env);
    const blockers = [
      ...(brand.status === 'RULES_NOT_APPROVED' ? ['Règles de marque non approuvées : vérification indicative seulement.'] : []),
      ...(brand.official && brand.outcome !== 'PASS' ? [`Marque : ${brand.outcome}`] : []),
      ...(!contract.checks.brand.ok ? ['Le texte n’est pas une affirmation approuvée par la marque (registre d’affirmations vide).'] : []),
      ...(creative.status === 'PROVIDER_NOT_CONNECTED' ? ['Création : aucun fournisseur de génération connecté.'] : []),
    ];
    return append({ kind: 'PROPOSAL', id: contract.campaign_ref, at: now(), by: actor?.userId ? `user:${actor.userId}` : 'local-owner', input: { product, objective, audience, channel, copy }, opportunity, brand, contract: { campaign_ref: contract.campaign_ref, ready_for_creative: contract.ready_for_creative, checks: contract.checks, owner_review: contract.owner_review, published: false }, creative, blockers, publishable: false });
  }

  /** The human decision on a proposal. Approving never publishes: it only allows a creation request once a provider exists. */
  async function decide(id, { decision, reason }, actor) {
    if (actor?.role !== 'OWNER') throw Object.assign(new Error('Seul le propriétaire décide d’une campagne.'), { code: 'APPROVAL_ROLE_REQUIRED', status: 403 });
    if (!DECISIONS.includes(decision)) throw Object.assign(new Error(`décision : ${DECISIONS.join(', ')}`), { code: 'INVALID_DECISION', status: 400 });
    if (!String(reason ?? '').trim()) throw Object.assign(new Error('raison obligatoire'), { code: 'REASON_REQUIRED', status: 400 });
    const all = await entries();
    if (!all.some((e) => e.kind === 'PROPOSAL' && e.id === id)) throw Object.assign(new Error('proposition introuvable'), { code: 'NOT_FOUND', status: 404 });
    if (all.some((e) => e.kind === 'DECISION' && e.id === id)) throw Object.assign(new Error('décision déjà enregistrée'), { code: 'ALREADY_DECIDED', status: 409 });
    return append({ kind: 'DECISION', id, at: now(), by: actor.userId ? `user:${actor.userId}` : 'local-owner', decision, reason: String(reason).trim(), published: false });
  }

  async function list() {
    const all = await entries(); const dec = new Map(all.filter((e) => e.kind === 'DECISION').map((e) => [e.id, e]));
    return all.filter((e) => e.kind === 'PROPOSAL').map((p) => ({ ...p, decision: dec.get(p.id) ?? null })).reverse();
  }
  return Object.freeze({ prepare, decide, list });
}
