// Document inspection V0: deterministic extraction from the TEXT of a supplier document (pasted, read from a text PDF, or produced by an OCR / vision
// adapter) and comparison against the Product Case. The wording is deliberate - nothing here says "fake": findings say what the evidence shows
// (INCONSISTENT / SUSPICIOUS / UNVERIFIED). "NO_ISSUE_FOUND" is NOT proof of compliance: it only means the checks that could run found nothing.
import { DOC_FINDING, DOC_CONSISTENCY } from './levels.js';
import { inferCategories } from './taxonomy.js';

export const DOC_TYPES = Object.freeze(['EU_DOC', 'TEST_REPORT', 'CERTIFICATE', 'SDS', 'UN383', 'BATTERY_DOC', 'ROHS_EVIDENCE', 'REACH_EVIDENCE', 'FCM_DOC', 'MATERIAL_DECL', 'LABEL_ARTWORK', 'PACKAGING_ARTWORK', 'MANUAL', 'MANUFACTURER_ID', 'QUOTE', 'SPEC', 'LAB_ACCREDITATION', 'COMPANY_RECORD', 'OTHER']);

const TYPE_RULES = [
  ['EU_DOC', [/declaration of conformity/i, /\bEU DoC\b/i, /\bDoC\b/, /declaration ue de conformit/i, /符合性声明|CE声明/]],
  ['UN383', [/UN\s?38\.3/i, /manual of tests and criteria/i]],
  ['TEST_REPORT', [/test report/i, /report no\.?/i, /rapport d.essai/i, /检测报告|测试报告/]],
  ['SDS', [/safety data sheet/i, /\bMSDS\b/i, /\bSDS\b/, /安全数据表/]],
  ['FCM_DOC', [/declaration of compliance/i, /food contact/i, /\b1935\/2004\b/, /食品接触/]],
  ['CERTIFICATE', [/certificate (?:no|number|of)/i, /\bcertificate\b/i, /证书/]],
  ['MANUAL', [/user (?:manual|guide)/i, /instruction(?:s)? (?:manual|for use)/i, /mode d.emploi/i, /gebruiksaanwijzing/i, /说明书/]],
  ['QUOTE', [/proforma invoice/i, /quotation/i, /\bquote\b/i, /unit price/i, /报价|形式发票/]],
  ['SPEC', [/specification/i, /datasheet|data sheet/i, /规格书/]],
];
const CLAIMED_EQUIV = { EU_DOC: ['EU_DOC'], TEST_REPORT: ['TEST_REPORT'], CERTIFICATE: ['CERTIFICATE'], SDS: ['SDS'], UN383: ['UN383', 'TEST_REPORT'], FCM_DOC: ['FCM_DOC', 'EU_DOC'], MANUAL: ['MANUAL'], QUOTE: ['QUOTE'], SPEC: ['SPEC', 'MANUAL'] };

const STANDARD_RX = /\b((?:ETSI EN|EN IEC|EN ISO|BS EN|EN|IEC|ISO|UL|ASTM|GB\/T|GB)\s?\d{2,6}(?:-\d+)*(?::\d{4}(?:\+A\d+:\d{4})?)?)/g;
const DIRECTIVE_RX = /\b((?:19|20)\d{2}\/\d{1,4}\/(?:EU|EC|EEC))\b/g;
const REGULATION_RX = /\b(?:Regulation\s*)?\(?(EC|EU)\)?\s*(?:No\.?\s*)?(\d{1,4}\/\d{2,4})\b/gi;
const ACCREDITATION_RX = /(CNAS\s?[A-Z]?\d{3,6}|ISO\/IEC\s?17025|ILAC|DAkkS|UKAS|A2LA|COFRAC|BELAC|NVLAP|CMA)/gi;
const STOP = new Set(['co', 'ltd', 'limited', 'company', 'inc', 'corp', 'corporation', 'technology', 'technologies', 'electronics', 'electronic', 'industry', 'industrial', 'group', 'trading', 'import', 'export', 'manufacturing', 'shenzhen', 'guangzhou', 'dongguan', 'china', 'the', 'and', 'gmbh', 'sarl', 'bv', 'llc']);

/** Standard families commonly cited per regulatory family. A NON-EXHAUSTIVE heuristic (the harmonised-standards list in the Official Journal is the authority). */
export const STANDARD_FAMILIES = Object.freeze({
  EMC: /(EN|IEC)\s?(55032|55035|55014|55015|55024|61000|61547)|ETSI EN 301 489/i,
  LVD: /(EN|IEC)\s?(62368|60335|60950|61558|60598|62493)/i,
  RED: /ETSI EN 30[01] \d+|EN\s?(62311|50566|62479|18031)|EN IEC 18031/i,
  ROHS: /(EN IEC|EN|IEC)\s?(63000|50581)/i,
  BATTERIES: /(EN|IEC)\s?(62133|62619|62620|61960|60086)|UN\s?38\.3/i,
  TOYS: /EN\s?71/i,
  FCM: /EN\s?(13130|12875|1186|14350)|10\/2011/i,
  TEXTILES: /(EN )?ISO\s?(1833|3071)|EN\s?14682/i,
  COSMETICS: /ISO\s?(22716|22715|24444)/i,
  PPE: /EN\s?(388|374|420|166|149|ISO 20345|ISO 374|ISO 20471|ISO 20344)/i,
});

const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokens = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9一-鿿 ]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; return A.size + B.size - i === 0 ? 0 : i / (A.size + B.size - i); };
const first = (text, rx) => { const m = rx.exec(text); return m ? m[1].trim().replace(/\s{2,}/g, ' ').slice(0, 120) : null; };
const all = (text, rx) => [...new Set([...text.matchAll(rx)].map((m) => m[1] ?? m[0]))];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null; };
function datesIn(line) {
  const out = [];
  for (const m of line.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) out.push(iso(+m[1], +m[2], +m[3]));
  for (const m of line.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/g)) out.push(iso(+m[3], +m[2], +m[1]));
  for (const m of line.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(20\d{2})\b/g)) out.push(iso(+m[3], MONTHS[m[2].toLowerCase()] ?? 0, +m[1]));
  for (const m of line.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g)) out.push(iso(+m[3], MONTHS[m[1].toLowerCase()] ?? 0, +m[2]));
  return out.filter(Boolean);
}

/** @returns normalized extraction for one document text */
export function extractDocument({ text = '', pages = null, fileName = '', claimedType = null }) {
  const body = String(text); const lines = body.split(/\r?\n/);
  let docType = 'OTHER'; let bestScore = 0;
  for (const [type, rxs] of TYPE_RULES) { const score = rxs.filter((rx) => rx.test(body) || rx.test(fileName)).length; if (score > bestScore) { bestScore = score; docType = type; } }
  const dates = { issue: null, expiry: null, test: null, all: [] };
  for (const line of lines) {
    const ds = datesIn(line); if (!ds.length) continue; dates.all.push(...ds);
    if (/valid (?:until|to|through)|expiry|expires|valid thru|有效期/i.test(line)) dates.expiry ??= ds.at(-1);
    else if (/date of test|test date|tested on|test period|检测日期/i.test(line)) dates.test ??= ds[0];
    else if (/date of issue|issued on|issue date|signed|place and date|date:|date of declaration|签发日期|日期/i.test(line)) dates.issue ??= ds[0];
  }
  dates.all = [...new Set(dates.all)].sort();
  const pageMarks = [...body.matchAll(/page\s+(\d+)\s*(?:of|\/)\s*(\d+)/gi)].map((m) => [Number(m[1]), Number(m[2])]);
  const declared = pageMarks.length ? Math.max(...pageMarks.map((p) => p[1])) : null;
  const seen = pages ? pages.length : new Set(pageMarks.map((p) => p[0])).size || null;
  return {
    docType, typeScore: bestScore, textLength: body.replace(/\s/g, '').length, claimedType,
    manufacturer: first(body, /(?:name of (?:the )?manufacturer|manufacturer|applicant|fabricant|制造商|生产商)\s*[:：]\s*([^\n]+)/i),
    models: all(body, /(?:model(?: no\.?| number| name)?|type(?: no\.?| designation)?|item no\.?|型号)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9\-_/. ]{1,40})/gi).map((m) => m.replace(/\s{2,}.*/, '').trim()),
    productName: first(body, /(?:product(?: name)?|description of (?:the )?product|object of the declaration|产品名称)\s*[:：]\s*([^\n]+)/i),
    standards: all(body, STANDARD_RX).map((s) => s.replace(/\s+/g, ' ')), directives: all(body, DIRECTIVE_RX),
    regulations: [...new Set([...body.matchAll(REGULATION_RX)].map((m) => `${m[1].toUpperCase()} ${m[2]}`))],
    mentionsRoHS: /rohs/i.test(body), mentionsREACH: /reach/i.test(body),
    reportNumbers: all(body, /(?:report (?:no\.?|number)|test report no\.?|rapport n°)\s*[:：]?\s*([A-Z0-9][A-Z0-9\-/.]{4,30})/gi),
    laboratories: all(body, /(?:testing laboratory|test(?:ing)? (?:house|laboratory|lab)|laboratory|issued by|检测机构)\s*[:：]\s*([^\n]+)/gi).map((s) => s.trim().slice(0, 100)),
    accreditations: [...new Set(all(body, ACCREDITATION_RX).map((s) => s.replace(/\s+/g, ' ').toUpperCase()))],
    signatory: first(body, /(?:signed for and on behalf of|signatory|authorized signatory|signature)\s*[:：]?\s*([^\n]{3,80})/i),
    dates, pages: { declared, found: seen },
    declarationElements: {
      soleResponsibility: /sole responsibility|seule responsabilit|唯一责任/i.test(body), conformityStatement: /in conformity with|conforms? (?:to|with)|conforme|符合/i.test(body),
      standardsListed: all(body, STANDARD_RX).length > 0 || all(body, DIRECTIVE_RX).length > 0, manufacturerNamed: /manufacturer|fabricant|制造商/i.test(body),
      manufacturerAddress: /(?:manufacturer|fabricant|制造商)[^\n]*\n?[^\n]*\d{2,}[^\n]*(?:china|cn|road|street|rd\.|st\.|district|village|city|省|市|路)/i.test(body) || /(?:address|adresse|地址)\s*[:：]/i.test(body),
      placeAndDate: dates.issue !== null, signature: /signed for and on behalf of|signature|signed|签名|签署/i.test(body), signatoryNameFunction: /name\s*[:：].*|function\s*[:：]|title\s*[:：]|职务/i.test(body),
    },
  };
}

// documents tied to ONE product model: a label, a manual or an SDS legitimately name no model
const MODEL_BOUND = ['EU_DOC', 'TEST_REPORT', 'CERTIFICATE', 'UN383', 'FCM_DOC', 'BATTERY_DOC'];
const sev = (code, severity, detail, extra = {}) => ({ code, severity, detail, ...extra });
const modelCompare = (identityModel, docModels) => {
  const a = norm(identityModel); if (!a) return { result: 'NO_CASE_MODEL' }; if (!docModels.length) return { result: 'NO_DOC_MODEL' };
  const bs = docModels.map(norm).filter(Boolean);
  if (bs.some((b) => b === a)) return { result: 'MATCH' };
  const variant = bs.find((b) => b.includes(a) || a.includes(b));
  return variant ? { result: 'VARIANT', docModel: docModels[bs.indexOf(variant)] } : { result: 'MISMATCH', docModels };
};

/**
 * @param {{ extraction: object, identity: { model: string|null, manufacturer: string|null, category: string|null, expectedFamilies: string[] }, now?: Date }} args
 * `expectedFamilies`: keys of STANDARD_FAMILIES for the regulatory families that APPLY to this product (from the rule engine).
 */
export function inspectDocument({ extraction: x, identity, now = new Date(), expectedFamilies = [] }) {
  const findings = []; const today = now.toISOString().slice(0, 10);
  const minChars = ['LABEL_ARTWORK', 'PACKAGING_ARTWORK'].includes(x.docType) ? 40 : 120; // a label legitimately carries little text
  if (x.textLength < minChars || x.docType === 'OTHER') findings.push(sev(DOC_FINDING.INSUFFICIENT_EVIDENCE, 'CONCERN', x.textLength < minChars ? 'almost no readable text was extracted: the document cannot be assessed (scan quality / OCR / missing file)' : 'the type of document could not be determined from its content'));
  if (x.claimedType && CLAIMED_EQUIV[x.claimedType] && x.docType !== 'OTHER' && !CLAIMED_EQUIV[x.claimedType].includes(x.docType))
    findings.push(sev(DOC_FINDING.DOCUMENT_TYPE_MISREPRESENTED, 'INCONSISTENT', `presented as ${x.claimedType} but its content reads as ${x.docType}`, { claimed: x.claimedType, detected: x.docType }));
  if (/ce\s*cert/i.test(String(x.claimedType ?? '')) || /\bCE certificate\b/i.test(x.fileName ?? '')) findings.push(sev(DOC_FINDING.DOCUMENT_TYPE_MISREPRESENTED, 'CONCERN', 'a "CE certificate" is not a legal instrument for most products: what matters is the EU Declaration of Conformity and the test evidence behind it (a notified-body certificate exists only for some products)'));

  const m = modelCompare(identity.model, x.models);
  if (m.result === 'MISMATCH') findings.push(sev(DOC_FINDING.MODEL_MISMATCH, 'INCONSISTENT', `the document names model(s) ${x.models.join(', ')}; the case is for ${identity.model}`, { docModels: x.models, caseModel: identity.model }));
  else if (m.result === 'VARIANT') findings.push(sev(DOC_FINDING.MODEL_MISMATCH, 'CONCERN', `the document names ${m.docModel}, a variant of the case model ${identity.model}: it may cover a different product`, { docModel: m.docModel, caseModel: identity.model }));
  else if (m.result === 'NO_CASE_MODEL') findings.push(sev(DOC_FINDING.INSUFFICIENT_EVIDENCE, 'CONCERN', 'the case has no model reference yet: the document cannot be matched to the product'));
  else if (m.result === 'NO_DOC_MODEL' && ['EU_DOC', 'TEST_REPORT', 'CERTIFICATE'].includes(x.docType)) findings.push(sev(DOC_FINDING.INSUFFICIENT_EVIDENCE, 'CONCERN', 'the document names no model or type: it cannot be tied to this product'));

  if (identity.manufacturer && x.manufacturer) { const j = jaccard(tokens(identity.manufacturer), tokens(x.manufacturer)); if (j < 0.34) findings.push(sev(DOC_FINDING.MANUFACTURER_MISMATCH, 'INCONSISTENT', `the document names the manufacturer "${x.manufacturer}"; the case has "${identity.manufacturer}"`, { similarity: Math.round(j * 100) / 100 })); }
  else if (['EU_DOC', 'TEST_REPORT', 'CERTIFICATE'].includes(x.docType) && !x.manufacturer) findings.push(sev(DOC_FINDING.INCOMPLETE_DECLARATION, 'CONCERN', 'no manufacturer is named in the document'));

  if (x.productName && identity.category) { const cands = inferCategories(x.productName).map((c) => c.categoryId); if (cands.length && !cands.includes(identity.category)) findings.push(sev(DOC_FINDING.PRODUCT_MISMATCH, 'CONCERN', `the document describes "${x.productName}" which reads as ${cands[0]}; the case is ${identity.category}`, { described: cands.slice(0, 3) })); }

  if (x.pages.declared && x.pages.found !== null && x.pages.found < x.pages.declared) findings.push(sev(DOC_FINDING.MISSING_PAGES, 'INCONSISTENT', `the document says it has ${x.pages.declared} pages; ${x.pages.found} were supplied`, x.pages));

  if (x.dates.expiry && x.dates.expiry < today) findings.push(sev(DOC_FINDING.EXPIRED_OR_DATE_CONCERN, 'INCONSISTENT', `validity ended on ${x.dates.expiry}`));
  if (x.dates.issue && x.dates.issue > today) findings.push(sev(DOC_FINDING.EXPIRED_OR_DATE_CONCERN, 'INCONSISTENT', `issue date ${x.dates.issue} is in the future`));
  if (x.docType === 'TEST_REPORT' && (x.dates.test ?? x.dates.issue)) { const d = x.dates.test ?? x.dates.issue; const ageDays = Math.floor((Date.parse(today) - Date.parse(d)) / 86400000); if (ageDays > 3 * 365) findings.push(sev(DOC_FINDING.EXPIRED_OR_DATE_CONCERN, 'CONCERN', `test report dated ${d} (${Math.floor(ageDays / 365)} years old): standards editions may have moved on (HEURISTIC, not a legal limit)`)); }

  if (['EU_DOC', 'TEST_REPORT'].includes(x.docType) && expectedFamilies.length && x.standards.length) {
    const expected = expectedFamilies.map((f) => STANDARD_FAMILIES[f]).filter(Boolean);
    if (expected.length && !x.standards.some((s) => expected.some((rx) => rx.test(s)))) findings.push(sev(DOC_FINDING.UNRELATED_STANDARD, 'CONCERN', `none of the cited standards (${x.standards.slice(0, 4).join(', ')}) belongs to the families expected for this product (${expectedFamilies.join(', ')}) - relevance UNVERIFIED, ask a compliance expert (the list of families is a non-exhaustive heuristic)`, { cited: x.standards, expectedFamilies }));
  }

  if (x.docType === 'EU_DOC') {
    const e = x.declarationElements; const missing = Object.entries({ 'sole-responsibility statement': e.soleResponsibility, 'statement of conformity with Union harmonisation legislation': e.conformityStatement, 'legislation / standards referenced': e.standardsListed || x.regulations.length > 0, 'manufacturer name': e.manufacturerNamed, 'manufacturer address': e.manufacturerAddress, 'place and date of issue': e.placeAndDate, 'signature': e.signature, 'signatory name and function': e.signatoryNameFunction }).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) findings.push(sev(DOC_FINDING.INCOMPLETE_DECLARATION, missing.length >= 4 ? 'INCONSISTENT' : 'CONCERN', `the declaration lacks: ${missing.join('; ')} (content expected of an EU Declaration of Conformity - Decision 768/2008/EC model)`, { missing }));
    if (x.directives.length === 0 && x.regulations.length === 0) findings.push(sev(DOC_FINDING.INCOMPLETE_DECLARATION, 'INCONSISTENT', 'the declaration cites no Union directive or regulation'));
  }
  if (['TEST_REPORT', 'CERTIFICATE'].includes(x.docType) && x.textLength >= 120) {
    if (!x.laboratories.length) findings.push(sev(DOC_FINDING.UNKNOWN_LAB, 'CONCERN', 'no testing laboratory is named'));
    else if (!x.accreditations.length) findings.push(sev(DOC_FINDING.UNKNOWN_LAB, 'CONCERN', `laboratory "${x.laboratories[0]}" is named but no accreditation reference (e.g. ISO/IEC 17025 scope, CNAS number) appears - accreditation UNVERIFIED`));
  }

  const severe = findings.filter((f) => f.severity === 'INCONSISTENT'); const concerns = findings.filter((f) => f.severity === 'CONCERN');
  const distinctSevere = new Set(severe.map((f) => f.code));
  let consistency;
  if (x.textLength < minChars || x.docType === 'OTHER') consistency = DOC_CONSISTENCY.INSUFFICIENT_EVIDENCE;
  else if (distinctSevere.size >= 2) consistency = DOC_CONSISTENCY.SUSPICIOUS;
  else if (severe.length) consistency = DOC_CONSISTENCY.INCONSISTENT;
  else if (concerns.length || (MODEL_BOUND.includes(x.docType) && m.result !== 'MATCH')) consistency = DOC_CONSISTENCY.UNVERIFIED;
  else consistency = DOC_CONSISTENCY.NO_ISSUE_FOUND;
  return {
    consistency, findings: findings.map((f) => (f.severity === 'INCONSISTENT' && consistency === DOC_CONSISTENCY.SUSPICIOUS ? { ...f, severity: 'SUSPICIOUS' } : f)),
    note: consistency === DOC_CONSISTENCY.SUSPICIOUS ? 'SUSPICIOUS means several independent inconsistencies were found. It is NOT proof of forgery.' : consistency === DOC_CONSISTENCY.NO_ISSUE_FOUND ? 'No inconsistency was found by the checks that could run. This is NOT proof that the product complies.' : null,
  };
}

/** Cross-checks BETWEEN documents of one case (a declaration that cites reports that were not supplied, report dated after the declaration). */
export function crossCheckDocuments(docs) {
  const out = []; const dec = docs.filter((d) => d.extraction.docType === 'EU_DOC'); const reps = docs.filter((d) => d.extraction.docType === 'TEST_REPORT');
  for (const d of dec) for (const r of reps) {
    const rd = r.extraction.dates.test ?? r.extraction.dates.issue; const dd = d.extraction.dates.issue;
    if (rd && dd && rd > dd) out.push(sev(DOC_FINDING.EXPIRED_OR_DATE_CONCERN, 'CONCERN', `test report ${r.id} (${rd}) is dated AFTER the declaration ${d.id} (${dd})`, { declaration: d.id, report: r.id }));
  }
  for (const d of dec) for (const n of d.extraction.reportNumbers) if (reps.length && !reps.some((r) => r.extraction.reportNumbers.includes(n))) out.push(sev(DOC_FINDING.INSUFFICIENT_EVIDENCE, 'CONCERN', `the declaration ${d.id} references report ${n}, which was not supplied`, { declaration: d.id, report: n }));
  return out;
}
