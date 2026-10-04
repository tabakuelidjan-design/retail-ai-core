// The Product Case: ONE aggregate built progressively from events (photo, text, quote, document, safety result...) and RE-ASSESSED from scratch every time.
// State is plain JSON (storable, syncable, offline). `assess` is pure: same state + same externals + same clock = same result. Nothing is ever restarted.
import { createIdentity, addEvidence, applyCategory, setIdentifier, effective, identificationConfidence } from './identity.js';
import { inferCategories, CATEGORIES } from './taxonomy.js';
import { economicOperator } from './operator.js';
import { evaluateRules } from './rules-engine.js';
import { RULEBOOK, RULE_VERSION } from './rulebook/index.js';
import { extractDocument, inspectDocument, crossCheckDocuments } from './docinspect.js';
import { matchSafetyGate } from './safety.js';
import { hsCandidates, customsAssessment } from './customs.js';
import { landedCost } from './landed.js';
import { unitEconomics, maxPurchasePrice } from './economics.js';
import { MoneyError, fmt } from './money.js';
import { buildQuestions, supplierSheet, negotiationBrief } from './supplier.js';
import { summarizeMarket, amazonReadiness, normalizeObservation } from './amazon.js';
import { decide, DEFAULT_POLICY } from './decision.js';
import { IDENTITY_LEVEL, FACT_CLASS, IDENTITY_RANK } from './levels.js';
import { readsOf } from './predicate.js';
import { upgradeCase, CASE_SCHEMA } from './upgrade.js';
import { effectiveQuote, normalizeTiers } from './offers.js';
import * as conv from './conversation.js';

const DAY = 86400000;
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const ruleById = new Map(RULEBOOK.map((r) => [r.id, r]));

export function newCase({ id, name = '', now = new Date() } = {}) {
  return {
    schema: CASE_SCHEMA, id: id ?? `case-${now.getTime().toString(36)}`, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    identity: createIdentity({ workingName: name }), placing: {}, context: { market: 'EU-BE', channels: ['own_site'], consumerSales: true },
    supplier: {}, quotes: [], costs: {}, sale: null, saleAmazon: null, documents: [], safetySnapshot: null, customs: {}, amazon: { observations: [], restricted: null }, notes: [], decisions: [], events: [],
    // V1 (schema 2): supplier conversations, candidate facts, the confirmed-fact ledger, conflicts, supplier document statements, the owner's own questions
    conversations: [], candidates: [], ledger: [], conflicts: [], documentLedger: [], userQuestions: [],
  };
}

/** Applies ONE event, immutably. Unknown event types are refused (never silently ignored). */
export function dispatch(state, event, now = new Date()) {
  const s = upgradeCase(clone(state)); const at = now.toISOString();
  reduceInPlace(s, event, at);
  s.updatedAt = at; s.events.push({ at, type: event.type, summary: event.summary ?? null });
  return s;
}

/** The reducer proper: mutates the (already cloned) draft state. Candidate confirmation compiles into the SAME events below, applied through `sub` and logged one by one. */
function reduceInPlace(s, event, at) {
  const lvl = event.level ?? IDENTITY_LEVEL.USER_STATED;
  const sub = (ev) => { reduceInPlace(s, ev, at); s.events.push({ at, type: ev.type, summary: ev.summary ?? null }); };
  switch (event.type) {
    case 'NAME': s.identity.workingName = String(event.name ?? ''); break;
    case 'CATEGORY': s.identity = applyCategory(s.identity, event.category, { level: lvl, source: event.source ?? { kind: 'user' } }); break;
    case 'TRAIT': s.identity = addEvidence(s.identity, event.trait, { value: event.value, level: lvl, source: event.source ?? { kind: 'user' }, observedAt: at }); break;
    case 'IDENTIFIER': s.identity = setIdentifier(s.identity, event.name, event.value, lvl, event.source ?? { kind: 'user' }); break;
    case 'ORIGIN': s.identity.countryOfOrigin = event.country ?? null; break;
    case 'PHOTO': s.identity.photos.push({ ref: event.ref, note: event.note ?? null, at }); break;
    case 'PLACING': s.placing = { ...s.placing, ...event.placing }; break;
    case 'CONTEXT': s.context = { ...s.context, ...event.context }; break;
    case 'SUPPLIER': s.supplier = { ...s.supplier, ...event.supplier }; break;
    case 'QUOTE': { // V1 fields (port, payment, price tiers) survive a V0 form save; typing a DIFFERENT unit price replaces the tiers (an explicit single price wins)
      const prev = s.quotes.at(-1); const nq = { ...event.quote };
      if (prev) for (const k of ['port', 'payment', 'tiers']) if (nq[k] === undefined && prev[k] !== undefined) {
        if (k === 'tiers' && nq.unitPrice !== undefined && nq.unitPrice !== '' && normalizeTiers(prev.tiers).length) { // the form may still show an earlier tier price (stale after a quantity change): a price equal to ANY quoted tier price is not an explicit override
          const typed = Number(String(nq.unitPrice).replace(',', '.')); const known = [Number(String(effectiveQuote(prev).unitPrice).replace(',', '.')), ...normalizeTiers(prev.tiers).map((t) => Number(t.unitPrice))];
          if (!known.includes(typed)) continue;
        }
        nq[k] = prev[k];
      }
      s.quotes.push({ ...nq, at }); break;
    }
    case 'COSTS': s.costs = { ...s.costs, ...event.costs }; break;
    case 'SALE': s.sale = { ...(s.sale ?? {}), ...event.sale, priceBasis: event.sale.priceBasis ?? s.sale?.priceBasis ?? 'TARGET' }; break;
    case 'SALE_AMAZON': s.saleAmazon = { ...(s.saleAmazon ?? {}), ...event.sale }; break;
    case 'DOCUMENT': {
      const ex = extractDocument({ text: event.text ?? '', pages: event.pages ?? null, fileName: event.fileName ?? '', claimedType: event.claimedType ?? null });
      if (event.docType) ex.docType = event.docType;
      // textSource: NATIVE (text layer of a PDF) | PASTED | TRANSCRIBED (the owner typed what the paper says) | OCR (read from a photo by an AI reader). OCR output is a MACHINE READING:
      // it stays UNVERIFIED until the owner confirms it against the paper, and it can never become a verified fact.
      const textSource = event.textSource ?? 'PASTED';
      s.documents.push({ id: event.id ?? `doc-${s.documents.length + 1}`, fileName: event.fileName ?? null, addedAt: at, claimedType: event.claimedType ?? null, docType: ex.docType, extraction: ex, ref: event.ref ?? null, photoRef: event.photoRef ?? null, textSource, confirmed: textSource !== 'OCR', ocrProvider: event.ocrProvider ?? null, text: textSource === 'OCR' ? String(event.text ?? '').slice(0, 20000) : undefined });
      break;
    }
    case 'DOCUMENT_CORRECT': { // the owner fixes the OCR text while looking at the paper; the extraction is redone; it still needs a confirmation
      const d = s.documents.find((x) => x.id === event.id); if (!d) throw new Error(`unknown document: ${event.id}`);
      const ex = extractDocument({ text: event.text ?? '', fileName: d.fileName ?? '', claimedType: d.claimedType }); if (d.docType !== 'OTHER' && ex.docType === 'OTHER') ex.docType = d.docType; d.extraction = ex; d.docType = ex.docType; d.text = String(event.text ?? '').slice(0, 20000); if (d.textSource === 'PHOTO_ONLY') d.textSource = 'TRANSCRIBED'; d.confirmed = d.textSource === 'TRANSCRIBED'; d.correctedAt = at; break; // typed by the owner while looking at the paper = his transcription; corrected OCR text still needs his explicit confirmation
    }
    case 'DOCUMENT_CONFIRM': { const d = s.documents.find((x) => x.id === event.id); if (!d) throw new Error(`unknown document: ${event.id}`); d.confirmed = true; d.confirmedAt = at; break; }
    case 'SAFETY_SNAPSHOT': s.safetySnapshot = event.snapshot; break;
    case 'CUSTOMS': s.customs = { ...s.customs, ...event.customs }; break;
    case 'AMAZON_OBS': s.amazon.observations.push(normalizeObservation(event.observation, new Date(at))); break;
    case 'AMAZON_OBS_REMOVE': s.amazon.observations.splice(event.index, 1); break;
    case 'AMAZON': s.amazon = { ...s.amazon, ...event.amazon, observations: s.amazon.observations }; break;
    case 'NOTE': s.notes.push({ at, text: String(event.text ?? '') }); break;
    case 'DECISION_RECORDED': s.decisions.push(event.entry); break;
    case 'CONVERSATION_START': conv.start(s, event, at); break;
    case 'CONVERSATION_ITEM': conv.addItem(s, event, at); break;
    case 'CONVERSATION_FINISH': conv.finish(s, event, at); break;
    case 'CANDIDATE_CONFIRM': conv.confirm(s, event, at, sub); break;
    case 'CANDIDATE_CORRECT': conv.correct(s, event, at, sub); break;
    case 'CANDIDATE_REJECT': conv.reject(s, event, at); break;
    case 'CONFLICT_RESOLVE': conv.resolve(s, event, at, sub); break;
    case 'QUESTION_ADD': conv.addQuestion(s, event, at); break;
    case 'QUESTION_STATE': conv.questionState(s, event); break;
    case 'DOC_CLAIM': s.documentLedger.push({ id: `dc-${s.documentLedger.length + 1}`, claim: event.claim, status: event.status, source: event.source ?? null, at }); break; // a supplier STATEMENT about a document: never a received document
    default: throw new Error(`unknown case event: ${event.type}`);
  }
}

/** A first look from free text (photo caption, label text, supplier listing): PROBABLE category only; the owner confirms. */
export function suggestCategories(text) { return inferCategories(text).slice(0, 3).map((c) => ({ ...c, id: c.categoryId, label: CATEGORIES[c.categoryId]?.label ?? c.categoryId })); }

const currentQuote = (s) => s.quotes.at(-1) ?? null;

function landedInputOf(s, quoteOverride) {
  const q = effectiveQuote({ ...(currentQuote(s) ?? {}), ...(quoteOverride ?? {}) }); // with price tiers: the unit price for the quantity considered; a V0 quote is untouched
  const qty = Number(q.qty ?? q.moq ?? 1) || 1;
  const duty = s.customs?.duty; const costs = { ...(s.costs?.costs ?? {}) };
  if (duty && duty.ratePct !== undefined && duty.ratePct !== null) costs.customsDuty = { ratePct: duty.ratePct, status: duty.kind === 'TAXUD_LOOKUP' ? 'KNOWN' : 'ESTIMATED', source: duty.source ?? 'USER_ENTERED' };
  return { supplier: { unitPrice: q.unitPrice, currency: q.currency ?? 'USD', qty, moq: q.moq ?? null, incoterm: q.incoterm ?? null }, fx: s.costs?.fx ?? null, costs, importVat: s.costs?.importVat ?? null };
}
const saleOf = (sale) => (sale && sale.sellingPriceGross && sale.vatRatePct !== undefined && sale.vatRatePct !== null ? { sellingPriceGross: sale.sellingPriceGross, vatRatePct: sale.vatRatePct, lines: sale.lines ?? [] } : null);

// a landed cost with a critical unknown is incomplete: it is never fed into the margin
function economicsOf(sale, landed, target) {
  const sl = saleOf(sale); if (!sl) return { status: 'INFORMATION_INSUFFICIENT', reason: 'selling price or VAT rate not entered', classification: 'UNKNOWN', contributionMinor: null, contributionPct: null, targetContributionPct: target ?? null };
  try { return unitEconomics({ ...sl, landedPerUnitMinor: landed && landed.status !== 'INFORMATION_INSUFFICIENT' ? (landed.totals?.landedPerUnitEurMinor ?? null) : null, targetContributionPct: target ?? null }); }
  catch (e) { if (e instanceof MoneyError) return { status: 'INFORMATION_INSUFFICIENT', reason: e.code, classification: 'UNKNOWN', contributionMinor: null, contributionPct: null }; throw e; }
}

/** The identity facts the Safety Gate is matched on, and a key that changes when they change (a stored check is only "live" for the SAME product facts). */
export function safetyFacts(state) { const id = state.identity; return { model: id.identifiers.model, manufacturer: id.identifiers.manufacturer, brand: id.identifiers.brand, gtin: id.identifiers.gtin, name: id.workingName, category: effective(id, 'category').value }; }
export const safetyKey = (f) => JSON.stringify([f.brand, f.model, f.gtin, f.name, f.category].map((x) => String(x ?? '').toLowerCase()));

function safetyOf(s, externals, identityForSafety, now) {
  const ext = externals?.safety;
  if (ext?.alerts && ext.source?.mode !== 'OFFLINE_VERIFICATION_REQUIRED') return matchSafetyGate({ identity: identityForSafety, alerts: ext.alerts, source: ext.source });
  const snap = s.safetySnapshot;
  if (snap && snap.source?.mode === 'LIVE_VERIFIED' && snap.identityKey === safetyKey(identityForSafety) && now.getTime() - Date.parse(snap.source.fetchedAt ?? 0) < 24 * 3600 * 1000) return snap;
  if (s.safetySnapshot) return { ...s.safetySnapshot, source: { ...s.safetySnapshot.source, mode: 'CACHED' }, note: `${s.safetySnapshot.note ?? ''} CACHED result from ${s.safetySnapshot.source?.fetchedAt ?? 'an earlier check'}: not live - re-verify online`.trim() };
  return matchSafetyGate({ identity: identityForSafety, alerts: null, source: { mode: 'OFFLINE_VERIFICATION_REQUIRED', fetchedAt: null } });
}

/** SUPPLIER_CLAIM (a supplier file or pasted text, inspected) / UNVERIFIED (a machine reading or a photo nobody has read) / CONFIRMED_AGAINST_DOCUMENT (you checked or typed it from the paper). A supplier document is never VERIFIED (that word is reserved for official sources). */
export function documentEvidenceState(d) {
  if (d.textSource === 'PHOTO_ONLY') return 'UNVERIFIED';
  if (d.textSource === 'OCR') return d.confirmed ? 'CONFIRMED_AGAINST_DOCUMENT' : 'UNVERIFIED';
  if (d.textSource === 'TRANSCRIBED') return 'CONFIRMED_AGAINST_DOCUMENT';
  return 'SUPPLIER_CLAIM';
}

/** An OCR / AI reading of a photo is never evidence by itself: until the owner confirms it against the paper it can be at best UNVERIFIED. */
function ocrGuard(d, insp) {
  if (d.textSource === 'TRANSCRIBED') { // the owner typed the key fields from the paper: completeness of the original (signature, address...) cannot be judged from a transcription
    const findings = insp.findings.filter((f) => f.code !== 'INCOMPLETE_DECLARATION'); const severe = findings.filter((f) => f.severity === 'INCONSISTENT' || f.severity === 'SUSPICIOUS'); const concerns = findings.filter((f) => f.severity === 'CONCERN');
    const consistency = new Set(severe.map((f) => f.code)).size >= 2 ? 'SUSPICIOUS' : severe.length ? 'INCONSISTENT' : concerns.length ? 'UNVERIFIED' : 'NO_ISSUE_FOUND';
    return { ...insp, consistency, findings, note: 'Transcribed by you from the paper: key fields only, completeness of the original (signature, address, pages) is NOT assessed. It is a supplier document, not a verified fact.' };
  }
  if (d.textSource !== 'OCR' || d.confirmed) return d.textSource === 'OCR' ? { ...insp, note: `${insp.note ? `${insp.note} ` : ''}Text read by an AI reader from a photo and confirmed by you against the paper. It is still a supplier document, not a verified fact.` } : insp;
  const worse = ['NO_ISSUE_FOUND'].includes(insp.consistency) ? 'UNVERIFIED' : insp.consistency;
  return { ...insp, consistency: worse, findings: [...insp.findings, { code: 'OCR_UNCONFIRMED', severity: 'CONCERN', detail: 'this text was read by OCR / an AI reader from a photo: every field is UNVERIFIED until you check it against the paper and confirm it' }], note: 'UNVERIFIED machine reading of a photo.' };
}

export function assess(state, { now = new Date(), externals = {}, rulebook = RULEBOOK, policy = DEFAULT_POLICY, quoteOverride = null } = {}) {
  const s = state; const id = s.identity;
  const idConf = identificationConfidence(id);
  const role = economicOperator(s.placing);
  const context = { ...s.context, role };
  const identityFacts = { model: id.identifiers.model, manufacturer: id.identifiers.manufacturer, brand: id.identifiers.brand, gtin: id.identifiers.gtin, name: id.workingName, category: effective(id, 'category').value };

  // pass 1: which families apply -> what standards a document should cite; pass 2: documents inspected -> evidence coverage
  const pre = evaluateRules({ identity: id, context, rulebook, docs: [], now });
  const families = pre.expectedStandardFamilies;
  const docs = s.documents.map((d) => ({ ...d, extraction: d.extraction, inspection: ocrGuard(d, inspectDocument({ extraction: d.extraction, identity: { model: identityFacts.model, manufacturer: identityFacts.manufacturer, category: identityFacts.category }, now, expectedFamilies: families })) }));
  const crossChecks = crossCheckDocuments(docs);
  const rules = evaluateRules({ identity: id, context, rulebook, docs, now });

  const safety = safetyOf(s, externals, identityFacts, now);
  const candidates = hsCandidates(id);
  const customs = customsAssessment({ candidates, chosenCode: s.customs?.chosenCode ?? null, duty: s.customs?.duty ?? null, bti: s.customs?.bti ?? null, now });

  const landedInput = landedInputOf(s, quoteOverride);
  let landed; try { landed = landedCost(landedInput); } catch (e) { if (e instanceof MoneyError) landed = { status: 'INFORMATION_INSUFFICIENT', criticalUnknown: [e.code], unknown: [e.code], lines: [], totals: { landedPerUnitEurMinor: null }, warnings: [] }; else throw e; }
  const target = s.sale?.targetContributionPct ?? null;
  const econ = economicsOf(s.sale, landed, target);
  // the selling price is one of: OBSERVED (a listing you saw), TARGET (the price you intend), ASSUMED (a placeholder): they are never merged
  const basisRaw = s.sale?.priceBasis ?? 'TARGET'; const priceBasis = basisRaw === 'OBSERVED' && !s.amazon.observations.some((o) => o.priceMinor !== null && o.kind === 'OBSERVED') ? 'ASSUMED' : basisRaw; econ.priceBasis = priceBasis;
  const channels = s.context.channels ?? [];
  const market = summarizeMarket(s.amazon.observations, now);
  const econAmazon = channels.includes('amazon') ? economicsOf(s.saleAmazon ?? null, landed, s.saleAmazon?.targetContributionPct ?? target) : null;

  let maxPrice;
  const sl = saleOf(s.sale);
  if (!sl) maxPrice = { status: 'INFORMATION_INSUFFICIENT', reason: 'SELLING_PRICE_NOT_ENTERED', maxUnitPriceMinor: null };
  else { try { maxPrice = maxPurchasePrice({ landedInput, sale: sl, targetContributionPct: target }); } catch (e) { if (e instanceof MoneyError) maxPrice = { status: 'INFORMATION_INSUFFICIENT', reason: e.code, maxUnitPriceMinor: null }; else throw e; } }
  if (maxPrice && maxPrice.maxUnitPriceMinor !== null && maxPrice.maxUnitPriceMinor !== undefined) maxPrice.display = fmt(maxPrice.maxUnitPriceMinor, maxPrice.currency);

  const marketabilityHint = null; void marketabilityHint;
  const preDecision = decide({ identityConf: idConf, rules, docs, safety, customs, landed, econ, maxPrice, amazon: { restricted: s.amazon.restricted, readiness: { status: 'UNKNOWN', open: [] }, economics: econAmazon }, role, quote: currentQuote(s), channels, questions: [], policy });
  const readiness = amazonReadiness({ rules, channels, marketability: preDecision.dimensions.marketability, restricted: s.amazon.restricted });
  const questions = buildQuestions({ identity: id, role, rules, docs, landed, quote: { ...(currentQuote(s) ?? {}), ...(quoteOverride ?? {}) }, customs, channels });
  const decision = decide({ identityConf: idConf, rules, docs, safety, customs, landed, econ, maxPrice, amazon: { restricted: s.amazon.restricted, readiness, economics: econAmazon }, role, quote: currentQuote(s), channels, questions, policy });
  const sgAge = safety.source?.newestPublication ? Math.floor((now.getTime() - Date.parse(safety.source.newestPublication)) / DAY) : null;
  if (priceBasis === 'ASSUMED' && econ.status !== 'INFORMATION_INSUFFICIENT') decision.conditions.push('the selling price is ASSUMED (no observed listing and not your target): the margin is only as good as that assumption');
  if (sgAge !== null && sgAge > 10) decision.conditions.push(`the newest Safety Gate weekly report ingested is ${sgAge} days old: refresh the cache`);
  if (safety.source?.mode === 'CACHED') decision.conditions.push(`the Safety Gate result is CACHED (${safety.source.fetchedAt ?? 'date unknown'}): re-verify online`);
  const brief = negotiationBrief({ maxPrice, quote: { ...(currentQuote(s) ?? {}), ...(quoteOverride ?? {}) }, rules, role, currency: landedInput.supplier.currency });

  const out = {
    caseId: s.id, asOf: now.toISOString(), ruleBookVersion: rules.ruleBookVersion ?? RULE_VERSION,
    identity: { workingName: id.workingName, ...identityFacts, confidence: idConf, countryOfOrigin: id.countryOfOrigin, photos: id.photos.length },
    role, rules, documents: docs.map((d) => ({ id: d.id, fileName: d.fileName, docType: d.docType, claimedType: d.claimedType, textSource: d.textSource, confirmed: d.confirmed, evidenceState: documentEvidenceState(d), photoRef: d.photoRef, ocrText: d.textSource === 'OCR' ? d.text : undefined, consistency: d.inspection.consistency, findings: d.inspection.findings, note: d.inspection.note, models: d.extraction.models, standards: d.extraction.standards, dates: d.extraction.dates })), crossChecks,
    safety, customs, landed, economics: econ, economicsAmazon: econAmazon, maxPurchasePrice: maxPrice, market, amazon: { ...readiness, restricted: s.amazon.restricted }, questions, supplierSheet: supplierSheet(questions), negotiation: brief, decision,
  };
  out.evidence = evidenceLedger(s, out); out.freshness = freshnessOf(s, out, now); out.dataMode = dataModeOf(out);
  return out;
}

/** WHAT IF: recompute the whole case with a different supplier quote, without touching the stored case. */
export function whatIf(state, change, opts = {}) {
  const base = assess(state, opts); const alt = assess(state, { ...opts, quoteOverride: change });
  const pick = (a) => ({ landedPerUnitMinor: a.landed.totals?.landedPerUnitEurMinor ?? null, contributionMinor: a.economics.contributionMinor ?? null, contributionPct: a.economics.contributionPct ?? null, economics: a.decision.dimensions.economics, verdict: a.decision.verdict, landedStatus: a.landed.status });
  return { change, current: pick(base), whatIf: pick(alt), maxPurchasePrice: alt.maxPurchasePrice, withinMaxPrice: alt.maxPurchasePrice?.maxUnitPriceMinor != null && change.unitPrice != null ? Math.round(Number(change.unitPrice) * 100) <= alt.maxPurchasePrice.maxUnitPriceMinor : null, assessment: alt };
}

/** Appends to the decision history only when the verdict or a dimension changed (history is append-only). */
export function recordDecision(state, a, now = new Date()) {
  const last = state.decisions.at(-1); const dims = JSON.stringify(a.decision.dimensions);
  if (last && last.verdict === a.decision.verdict && JSON.stringify(last.dimensions) === dims) return state;
  return dispatch(state, { type: 'DECISION_RECORDED', entry: { at: now.toISOString(), verdict: a.decision.verdict, dimensions: a.decision.dimensions, hardBlockers: a.decision.hardBlockers.map((b) => b.code), ruleBookVersion: a.ruleBookVersion, quote: currentQuote(state)?.unitPrice ?? null, maxPurchasePrice: a.maxPurchasePrice?.maxUnitPriceMinor ?? null } }, now);
}

const LEVEL_CLASS = { PROBABLE: FACT_CLASS.ESTIMATE, AI_SUGGESTED: FACT_CLASS.ESTIMATE, SUPPLIER_CLAIMED: FACT_CLASS.SUPPLIER_CLAIM, USER_STATED: FACT_CLASS.SUPPLIER_CLAIM, VERIFIED_BY_SUPPLIER_DOCUMENT: FACT_CLASS.SUPPLIER_CLAIM, VERIFIED_OFFICIAL: FACT_CLASS.VERIFIED_FACT };

/** Evidence classes kept SEPARATE: what is verified, observed, claimed, calculated, estimated, assumed, unknown, or needs an expert. */
function evidenceLedger(s, a) {
  const L = { verified: [], observed: [], supplierClaims: [], calculated: [], estimated: [], assumed: [], unknown: [], needsExpert: [] };
  for (const t of ['category', 'model', 'manufacturer', 'brand', 'battery.present', 'radio.present', 'electrical.present', 'childrenUse', 'foodContact', 'cosmetic', 'textile', 'ppe', 'medical']) {
    const e = effective(s.identity, t);
    if (!e.known) { L.unknown.push({ item: t, note: e.contradiction ? 'CONTRADICTORY evidence: treated as unknown' : 'not established' }); continue; }
    const rank = IDENTITY_RANK[e.level]; const rec = { item: t, value: e.value, level: e.level };
    if (e.level === 'PROBABLE' || e.level === 'AI_SUGGESTED') L.assumed.push({ ...rec, note: e.level === 'AI_SUGGESTED' ? 'AI SUGGESTED from a photo: not confirmed by you or a document' : 'inferred (category profile / keywords), not observed' });
    else if (rank >= IDENTITY_RANK.VERIFIED_OFFICIAL) L.verified.push(rec); else L.supplierClaims.push({ ...rec, factClass: LEVEL_CLASS[e.level] });
  }
  const q = s.quotes.at(-1); if (q) L.supplierClaims.push({ item: 'supplier quote', value: { unitPrice: q.unitPrice, currency: q.currency, moq: q.moq, incoterm: q.incoterm }, level: 'SUPPLIER_CLAIMED' });
  for (const d of a.documents) L.supplierClaims.push({ item: `document ${d.id} (${d.docType})`, value: d.consistency, note: d.textSource === 'OCR' && !d.confirmed ? 'UNVERIFIED machine reading of a photo' : 'supplied by the supplier: the existence of a document is not proof of compliance' });
  if (['EXACT_MATCH', 'PROBABLE_MATCH', 'SIMILAR_PRODUCT_RISK', 'NO_MATCH_FOUND'].includes(a.safety.status)) (a.safety.source?.mode === 'LIVE_VERIFIED' ? L.verified : L.observed).push({ item: 'EU Safety Gate check', value: a.safety.status, mode: a.safety.source?.mode, fetchedAt: a.safety.source?.fetchedAt ?? null, note: a.safety.note });
  else L.unknown.push({ item: 'EU Safety Gate check', note: 'OFFLINE - VERIFICATION REQUIRED' });
  for (const o of s.amazon.observations) L.observed.push({ item: `${o.marketplace} listing`, priceMinor: o.priceMinor, observedAt: o.observedAt, source: o.source });
  if (a.landed.status !== 'INFORMATION_INSUFFICIENT') L.calculated.push({ item: 'landed cost per unit', valueMinor: a.landed.totals.landedPerUnitEurMinor, status: a.landed.status });
  else L.unknown.push({ item: 'landed cost', note: `missing: ${a.landed.criticalUnknown.join(', ')}` });
  if (a.economics.contributionMinor != null) L.calculated.push({ item: 'contribution per unit', valueMinor: a.economics.contributionMinor, upperBound: a.economics.contributionIsUpperBound === true });
  if (a.economics.sellingPriceGrossMinor != null) ({ OBSERVED: L.observed, TARGET: L.estimated, ASSUMED: L.assumed }[a.economics.priceBasis ?? 'TARGET']).push({ item: `selling price (${a.economics.priceBasis ?? 'TARGET'})`, valueMinor: a.economics.sellingPriceGrossMinor, note: a.economics.priceBasis === 'OBSERVED' ? 'a listing you saw: not permission to sell' : a.economics.priceBasis === 'ASSUMED' ? 'placeholder assumption' : 'the price you intend to charge' });
  if (a.maxPurchasePrice?.maxUnitPriceMinor != null) L.calculated.push({ item: 'maximum purchase price', valueMinor: a.maxPurchasePrice.maxUnitPriceMinor, currency: a.maxPurchasePrice.currency, upperBound: a.maxPurchasePrice.upperBound === true });
  if (a.customs.duty?.ratePct != null) L.estimated.push({ item: 'customs duty rate', value: a.customs.duty.ratePct, note: a.customs.duty.factClass === FACT_CLASS.VERIFIED_FACT ? 'from an official lookup' : 'entered by the user: verify for the exact code, origin and date' });
  else L.unknown.push({ item: 'customs duty rate', note: 'CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION' });
  for (const r of a.rules.results) { if (r.status === 'NOT_APPLICABLE') continue; const rule = ruleById.get(r.ruleId); const onlyProfile = rule && [...readsOf(rule.appliesWhen)].some((rd) => rd.startsWith('trait:') && effective(s.identity, rd.slice(6)).level === 'PROBABLE'); if (r.requiresAuthorityConfirmation) L.needsExpert.push({ item: r.ruleId, title: r.title, note: 'requires expert / authority confirmation' }); else if (onlyProfile) L.estimated.push({ item: r.ruleId, note: 'applicability inferred from the category profile: confirm the product traits' }); }
  return L;
}

function freshnessOf(s, a, now) {
  const out = []; const rs = a.rules.results.flatMap((r) => r.sources);
  const oldest = rs.length ? rs.map((x) => x.checkedAt).sort()[0] : null; const worst = rs.some((x) => x.freshness.status === 'STALE') ? 'STALE' : rs.some((x) => x.freshness.status === 'UNCHECKED') ? 'UNCHECKED' : 'FRESH';
  out.push({ name: 'regulatory rulebook', version: a.ruleBookVersion, checkedAt: oldest, status: worst, note: 'rules are re-checked against official sources; STALE means re-check before relying on them' });
  const sf = a.safety.source ?? {}; const ageDays = sf.newestPublication ? Math.floor((now.getTime() - Date.parse(sf.newestPublication)) / DAY) : (sf.reportAgeDays ?? null); const reportsOld = ageDays !== null && ageDays > 10;
  out.push({ name: 'EU Safety Gate', mode: sf.mode ?? 'OFFLINE_VERIFICATION_REQUIRED', checkedAt: sf.fetchedAt ?? null, status: sf.mode === 'LIVE_VERIFIED' && !reportsOld ? 'FRESH' : sf.mode === 'OFFLINE_VERIFICATION_REQUIRED' || !sf.mode ? 'UNCHECKED' : 'STALE', note: ageDays !== null ? `newest ingested weekly report is ${ageDays} day(s) old${reportsOld ? ' (weekly reports: older than expected)' : ''}` : null });
  const fx = s.costs?.fx; out.push({ name: 'FX rate', checkedAt: fx?.date ?? null, status: fx?.rate ? ((now.getTime() - Date.parse(fx.date ?? 0)) / DAY > 7 ? 'STALE' : 'FRESH') : 'UNCHECKED', source: fx?.source ?? null });
  out.push({ name: 'Amazon observations', checkedAt: a.market.byMarketplace.map((m) => m.newestObservedAt).filter(Boolean).sort().at(-1) ?? null, status: a.market.byMarketplace.some((m) => m.freshness === 'STALE') ? 'STALE' : a.market.observationCount ? 'FRESH' : 'UNCHECKED' });
  return out;
}
function dataModeOf(a) { const m = a.safety.source?.mode; return m === 'LIVE_VERIFIED' ? 'LIVE_VERIFIED' : m === 'CACHED' ? 'CACHED' : 'OFFLINE_VERIFICATION_REQUIRED'; }
