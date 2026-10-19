// MARKET RADAR photo recognition through Google Cloud Vision (SERVER SIDE ONLY, OFF unless the operator enables it). What it can and cannot do, stated plainly:
//  - it READS what is on the photo (label text, logos, a printed code) and offers WEB GUESSES for the object ("insulated water bottle"). It does NOT identify an exact product on its own;
//  - every value it returns is a MACHINE PROPOSAL (source PHOTO_VISION): a model number read by OCR may be wrong, a "best guess" is a category-level name, a logo is a brand hint;
//  - the photo leaves the server only with the owner's explicit consent bound to THIS image (sha-256) and is never stored or logged here; the API key lives in the server environment only.
import { ProviderError } from './market-dataforseo.js';

export const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Worst case per photo (WEB_DETECTION 3.50 + TEXT_DETECTION 1.50 + LOGO_DETECTION 1.50 USD per 1 000 units after the free monthly allowance of 1 000 units per feature), rounded up. */
export const VISION_COST_PER_PHOTO_USD = 0.0065;

/** Image kind from its first bytes (never from what the client claims). */
export function imageKind(bytes) {
  const b = bytes; if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
/** GTIN-8/12/13/14 check digit. */
export function validGtin(s) {
  const d = String(s ?? '').replace(/\D/g, ''); if (![8, 12, 13, 14].includes(d.length)) return false;
  const digits = [...d].map(Number); const check = digits.pop(); let sum = 0; digits.reverse().forEach((v, i) => { sum += v * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
const UNIT_ONLY = /^\d+(ML|CL|L|G|KG|MG|MM|CM|M|V|W|KW|HZ|MAH|GB|MB|TB|OZ|PCS|PC|ST|X|CC)$/i;
const MODEL_RE = /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,}\b/g;
const clean = (s, n = 120) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

/** Model-like tokens read on the label: letters + digits, not a barcode, not a bare quantity ("500ML"), at most 3. */
export function modelsFromText(text) {
  const out = []; for (const m of String(text ?? '').toUpperCase().match(MODEL_RE) ?? []) { if (validGtin(m) || UNIT_ONLY.test(m) || /^\d/.test(m) && /^\d+[A-Z]{1,3}$/.test(m)) continue; if (!out.includes(m)) out.push(m); }
  return out.slice(0, 3);
}

/**
 * @param {{ apiKey: string, imageBase64: string, fetchImpl?: Function, timeoutMs?: number }} a
 * @returns identification proposal; throws ProviderError (VISION_AUTH | VISION_QUOTA | VISION_ERROR | NETWORK | TIMEOUT | BAD_IMAGE)
 */
export async function visionIdentify({ apiKey, imageBase64, fetchImpl = fetch, timeoutMs = 25_000 }) {
  if (!apiKey) throw new ProviderError('NOT_CONFIGURED', 'photo recognition is not configured');
  let bytes; try { bytes = Buffer.from(String(imageBase64 ?? ''), 'base64'); } catch { throw new ProviderError('BAD_IMAGE', 'invalid image'); }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !imageKind(bytes)) throw new ProviderError('BAD_IMAGE', 'the image must be a JPEG, PNG or WebP of at most 3 MB');
  const body = { requests: [{ image: { content: bytes.toString('base64') }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }, { type: 'TEXT_DETECTION' }, { type: 'LOGO_DETECTION', maxResults: 3 }] }] };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs); let r;
  try { r = await fetchImpl(VISION_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: ctl.signal }); }
  catch (e) { throw e?.name === 'AbortError' ? new ProviderError('TIMEOUT', 'photo recognition did not answer in time') : new ProviderError('NETWORK', `photo recognition: network error (${e?.cause?.code ?? e?.code ?? 'unreachable'})`); }
  finally { clearTimeout(timer); }
  if (!r.ok) throw new ProviderError(r.status === 401 || r.status === 403 ? 'VISION_AUTH' : r.status === 429 ? 'VISION_QUOTA' : 'VISION_ERROR', `vision: HTTP ${r.status}`, { http: r.status });
  const a = (await r.json()).responses?.[0] ?? {}; if (a.error) throw new ProviderError(a.error.code === 429 ? 'VISION_QUOTA' : 'VISION_ERROR', `vision: ${a.error.status ?? 'error'}`);
  const w = a.webDetection ?? {}; const ocr = a.textAnnotations?.[0]?.description ?? '';
  const eans = [...new Set((ocr.match(/\b\d{8,14}\b/g) ?? []).filter(validGtin))].slice(0, 2);
  return {
    source: 'PHOTO_VISION', provider: 'google-cloud-vision', region: 'US',
    bestGuess: (w.bestGuessLabels ?? []).map((l) => clean(l.label)).filter(Boolean).slice(0, 2),
    entities: (w.webEntities ?? []).filter((e) => e.description).slice(0, 5).map((e) => ({ description: clean(e.description), score: Number.isFinite(e.score) ? +e.score.toFixed(2) : null })),
    logos: (a.logoAnnotations ?? []).filter((l) => l.description && (l.score ?? 1) >= 0.6).map((l) => clean(l.description, 60)).slice(0, 2),
    models: modelsFromText(ocr), eans, ocrText: clean(ocr, 300), webPages: (w.pagesWithMatchingImages ?? []).length,
  };
}
