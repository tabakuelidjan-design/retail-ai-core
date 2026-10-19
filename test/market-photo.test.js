// Photo identification for the market radar: local barcode decoding (real decoder on synthetic barcode images), the Vision adapter and the service with a SIMULATED Vision. No photo is ever sent anywhere by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeEan13, gtinOk } from '../src/sourcing/ui/barcode-local.js';
import { imageKind, modelsFromText, validGtin, visionIdentify } from '../src/sourcing/adapters/market-vision.js';
import { identificationConfidence, sanitizeIdentification, mergeIdentification, queriesFromInput } from '../src/sourcing/adapters/market-radar.js';
import { createMarketRadar, RadarError } from '../src/sourcing/server/market-radar-service.js';
import { lookupGtin } from '../src/sourcing/adapters/gtin-lookup.js';

// ---- an independent EAN-13 ENCODER (test only) and a rasteriser: the decoder is tested on pixels, not on its own tables
const Lc = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'], Gc = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'], Rc = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const checkDigit = (d12) => { let s = 0; [...d12].reverse().forEach((c, i) => { s += Number(c) * (i % 2 === 0 ? 3 : 1); }); return (10 - (s % 10)) % 10; };
const modules = (d13) => { const p = PAR[Number(d13[0])]; let m = '101'; for (let i = 0; i < 6; i++) m += (p[i] === 'L' ? Lc : Gc)[Number(d13[1 + i])]; m += '01010'; for (let i = 0; i < 6; i++) m += Rc[Number(d13[7 + i])]; return `${m}101`; };
/** RGBA image: white page, quiet zones, bars `scale` px per module (can be fractional), `height` px tall, optional box blur and noise, optional rotation by 90. */
function render(d13, { scale = 3, height = 120, quiet = 12, blur = 0, noise = 0, rotate = false, seed = 7 } = {}) {
  const m = modules(d13); const w = Math.round((m.length + 2 * quiet) * scale); const h = height; const px = new Float32Array(w * h).fill(255);
  for (let i = 0; i < m.length; i++) if (m[i] === '1') { const x0 = Math.round((quiet + i) * scale), x1 = Math.round((quiet + i + 1) * scale); for (let y = 8; y < h - 8; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 0; }
  let rnd = seed; const rand = () => { rnd = (rnd * 1664525 + 1013904223) % 4294967296; return rnd / 4294967296; };
  const blurred = new Float32Array(px); if (blur) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -blur; k <= blur; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += px[y * w + xx]; n++; } } blurred[y * w + x] = s / n; }
  let W = w, H = h; let src = blurred; if (rotate) { const t = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = blurred[y * w + x]; src = t; W = h; H = w; }
  const data = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const v = Math.max(0, Math.min(255, src[i] + (noise ? (rand() - 0.5) * noise : 0))); data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  return { data, width: W, height: H };
}
const mk = (d12) => `${d12}${checkDigit(d12)}`;
const SAMPLES = [mk('400638133393'), mk('301762042200'), mk('544900000099'), mk('871083900105'), mk('590123412345'), mk('978020137962')];

test('the local decoder reads EAN-13 barcodes from pixels at different sizes, with blur and noise', () => {
  for (const g of SAMPLES) { assert.ok(gtinOk(g)); for (const opt of [{ scale: 3 }, { scale: 2 }, { scale: 4.5, height: 200 }, { scale: 3, blur: 1, noise: 40 }]) assert.equal(decodeEan13(render(g, opt)), g, `${g} ${JSON.stringify(opt)}`); }
});

test('the local decoder reads a vertical barcode (rotated 90°) and a mirrored scan direction', () => {
  const g = SAMPLES[0]; assert.equal(decodeEan13(render(g, { rotate: true })), g);
  const im = render(g); const w = im.width; for (let y = 0; y < im.height; y++) for (let x = 0; x < w / 2; x++) { for (let c = 0; c < 4; c++) { const a = (y * w + x) * 4 + c, b = (y * w + (w - 1 - x)) * 4 + c; [im.data[a], im.data[b]] = [im.data[b], im.data[a]]; } }
  assert.equal(decodeEan13(im), g);
});

test('a misread is rejected, never corrected: a barcode with a wrong check digit, noise, or no barcode returns null', () => {
  const g = SAMPLES[1]; const bad = `${g.slice(0, 12)}${(Number(g[12]) + 1) % 10}`; assert.equal(gtinOk(bad), false); assert.equal(decodeEan13(render(bad)), null);
  const blank = { data: new Uint8ClampedArray(200 * 100 * 4).fill(255), width: 200, height: 100 }; assert.equal(decodeEan13(blank), null);
  const noise = render(g, { noise: 255, seed: 3 }); const r = decodeEan13(noise); assert.ok(r === null || r === g, 'never a different number');
  const heavy = render(g, { scale: 1, blur: 3 }); const r2 = decodeEan13(heavy); assert.ok(r2 === null || r2 === g);
});

// ---- Vision adapter (fake fetch)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]); const B64 = JPEG.toString('base64'); const SHA = createHash('sha256').update(JPEG).digest('hex');
const KEY = 'AIza-test-Secret-Key-123';
const visionOk = (extra = {}) => async (url, opt) => ({ ok: true, status: 200, json: async () => ({ responses: [{ webDetection: { bestGuessLabels: [{ label: 'insulated water bottle' }], webEntities: [{ description: 'Water bottle', score: 0.91 }], pagesWithMatchingImages: [{ url: 'https://x.example' }] }, textAnnotations: [{ description: 'ACME\nRB-980HB 500ML\n4006381333931\n12345678' }], logoAnnotations: [{ description: 'ACME', score: 0.9 }, { description: 'Noise', score: 0.2 }], ...extra }] }) });

test('image kind is read from the bytes, never from what the client claims; GTIN check digit', () => {
  assert.equal(imageKind(JPEG), 'image/jpeg'); assert.equal(imageKind(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])), 'image/png'); assert.equal(imageKind(Buffer.from('not an image at all...')), null);
  assert.equal(validGtin('4006381333931'), true); assert.equal(validGtin('4006381333932'), false);
});

test('Vision answer -> proposals: best guess, logo (score ≥ 0.6), model without units, valid EAN; every value is a machine proposal', async () => {
  const r = await visionIdentify({ apiKey: KEY, imageBase64: B64, fetchImpl: visionOk() });
  assert.equal(r.source, 'PHOTO_VISION'); assert.deepEqual(r.bestGuess, ['insulated water bottle']); assert.deepEqual(r.logos, ['ACME']); assert.deepEqual(r.models, ['RB-980HB']); assert.deepEqual(r.eans, ['4006381333931']); assert.equal(r.region, 'US');
  assert.deepEqual(modulesOf('Quantity 500ML 1L 220V IP67 ZF-024 4006381333931'), ['IP67', 'ZF-024']);
});
const modulesOf = (t) => modelsFromText(t);

test('Vision errors are named, the key is never in a message, a bad image is refused BEFORE any call', async () => {
  let called = 0; const f = async () => { called++; return { ok: false, status: 403, json: async () => ({}) }; };
  await assert.rejects(() => visionIdentify({ apiKey: KEY, imageBase64: Buffer.from('plain text, not an image').toString('base64'), fetchImpl: f }), (e) => e.code === 'BAD_IMAGE'); assert.equal(called, 0);
  for (const [st, code] of [[401, 'VISION_AUTH'], [403, 'VISION_AUTH'], [429, 'VISION_QUOTA'], [500, 'VISION_ERROR']]) await assert.rejects(() => visionIdentify({ apiKey: KEY, imageBase64: B64, fetchImpl: async () => ({ ok: false, status: st, json: async () => ({}) }) }), (e) => e.code === code && !JSON.stringify([e.message, e.stack]).includes(KEY));
  await assert.rejects(() => visionIdentify({ apiKey: KEY, imageBase64: B64, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } }), (e) => e.code === 'NETWORK');
  await assert.rejects(() => visionIdentify({ apiKey: KEY, imageBase64: B64, timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }), (e) => e.code === 'TIMEOUT');
});

// ---- identification rules
test('identification: the source is whitelisted, a GTIN needs a valid check digit, strings are clamped; confidence levels', () => {
  assert.equal(sanitizeIdentification({ source: 'HACKER', eans: ['4006381333931'] }), null);
  const i = sanitizeIdentification({ source: 'LOCAL_BARCODE', eans: ['4006381333931', '4006381333932', 'x'], engine: 'BarcodeDetector', format: 'ean_13', models: ['rb-980hb', 'not a model!!'], bestGuess: ['  a bottle '.padEnd(500, 'x')] });
  assert.deepEqual(i.eans, ['4006381333931']); assert.deepEqual(i.models, ['RB-980HB']); assert.ok(i.bestGuess[0].length <= 120); assert.equal(identificationConfidence(i), 'HIGH');
  assert.equal(identificationConfidence({ logos: ['A'], models: ['AB-12'], eans: [] }), 'MEDIUM'); assert.equal(identificationConfidence({ bestGuess: ['bottle'], eans: [], models: [], logos: [] }), 'LOW'); assert.equal(identificationConfidence({ eans: [], models: [], logos: [], bestGuess: [] }), 'NONE'); assert.equal(identificationConfidence(null), 'NONE');
});

test('a barcode makes the FIRST query; a guess only fills what the case lacks and never replaces the owner\'s own name', () => {
  const ident = sanitizeIdentification({ source: 'LOCAL_BARCODE', eans: ['4006381333931'] }); const m = mergeIdentification({ name: 'My bottle', brand: null, model: null, gtin: null }, ident);
  assert.equal(m.gtin, '4006381333931'); assert.equal(m.name, 'My bottle'); assert.equal(m.sources.gtin, 'LOCAL_BARCODE'); const q = queriesFromInput(m, 2); assert.equal(q[0].strength, 'GTIN'); assert.equal(q.length, 2);
  const guess = mergeIdentification({ name: null, brand: null, model: null, gtin: null }, sanitizeIdentification({ source: 'PHOTO_VISION', bestGuess: ['insulated water bottle'] })); assert.equal(guess.name, 'insulated water bottle'); assert.equal(guess.sources.name, 'PHOTO_VISION'); assert.equal(queriesFromInput(guess, 2)[0].strength, 'NAME_ONLY');
});

// ---- the service: consent, role, switches, caps, privacy
const mkService = (env = {}, extra = {}) => { const calls = []; const fetchImpl = async (u, o) => { calls.push(u); if (u.includes('vision.googleapis.com')) return visionOk()(u, o); throw new Error('unexpected ' + u); };
  return { calls, svc: createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b', GOOGLE_VISION_API_KEY: KEY, MARKET_PHOTO_ENABLED: '1', MARKET_PHOTO_MIN_INTERVAL_SEC: '0.001', ...env }, fetchImpl, ...extra }) }; };
const OWNER = { role: 'OWNER' }; const code = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof RadarError, String(e)); return e.code; } };

test('photo recognition is OFF by default, even with a key: it needs the operator switch; nothing is sent', async () => {
  const { svc, calls } = mkService({ MARKET_PHOTO_ENABLED: '0' }); assert.equal(svc.status().photoIdentification.enabled, false); assert.equal(svc.status().photoIdentification.reason, 'NOT_ENABLED_BY_OPERATOR');
  assert.equal(await code(() => svc.identify({ imageBase64: B64, consent: { accepted: true, sha256: SHA } }, OWNER)), 'PHOTO_NOT_ENABLED'); assert.equal(calls.length, 0);
  assert.equal(createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b', MARKET_PHOTO_ENABLED: '1' } }).status().photoIdentification.reason, 'NO_KEY');
});

test('no consent, a consent for ANOTHER image, a non-owner role or a bad image: refused before ANY call to Vision', async () => {
  const { svc, calls } = mkService();
  assert.equal(await code(() => svc.identify({ imageBase64: B64 }, OWNER)), 'CONSENT_REQUIRED'); assert.equal(await code(() => svc.identify({ imageBase64: B64, consent: { accepted: false, sha256: SHA } }, OWNER)), 'CONSENT_REQUIRED');
  assert.equal(await code(() => svc.identify({ imageBase64: B64, consent: { accepted: true, sha256: 'ab'.repeat(32) } }, OWNER)), 'CONSENT_MISMATCH');
  for (const role of ['VIEWER', 'ACCOUNTANT', 'COLLABORATOR', 'ADMIN', undefined]) assert.equal(await code(() => svc.identify({ imageBase64: B64, consent: { accepted: true, sha256: SHA } }, { role })), 'FORBIDDEN_ROLE');
  assert.equal(await code(() => svc.identify({ imageBase64: Buffer.from('text').toString('base64'), consent: { accepted: true, sha256: 'x' } }, OWNER)), 'BAD_IMAGE');
  assert.equal(await code(() => svc.identify({ imageBase64: Buffer.alloc(3.2 * 1024 * 1024, 1).toString('base64') }, OWNER)), 'BAD_IMAGE'); assert.equal(calls.length, 0, 'Vision was never called');
});

test('with the owner\'s consent bound to this image: one call, proposals returned, photo reported as not kept, key never in the result; the sha-256 is the server\'s own', async () => {
  const { svc, calls } = mkService(); const r = await svc.identify({ imageBase64: B64, consent: { accepted: true, sha256: SHA.toUpperCase() } }, OWNER);
  assert.equal(calls.length, 1); assert.equal(r.status, 'DONE'); assert.equal(r.photo.kept, false); assert.equal(r.photo.sha256, SHA); assert.equal(r.identification.source, 'PHOTO_VISION'); assert.equal(r.identification.confidence, 'HIGH'); assert.equal(r.consent.provider, 'google-cloud-vision');
  assert.ok(!JSON.stringify(r).includes(KEY)); assert.ok(r.notes.some((n) => /à confirmer/.test(n)) && r.notes.some((n) => /n'est ni conservée/.test(n)));
});

test('photo caps: one at a time, minimum interval, daily maximum, cost ceiling', async () => {
  let t = Date.parse('2026-10-19T12:00:00Z'); const now = () => new Date(t); const { svc } = mkService({ MARKET_PHOTO_DAILY_MAX: '2', MARKET_PHOTO_MIN_INTERVAL_SEC: '10' }, { now });
  const body = { imageBase64: B64, consent: { accepted: true, sha256: SHA } };
  await svc.identify(body, OWNER); assert.equal(await code(() => svc.identify(body, OWNER)), 'PHOTO_TOO_SOON'); t += 11_000; await svc.identify(body, OWNER); t += 11_000; assert.equal(await code(() => svc.identify(body, OWNER)), 'PHOTO_DAILY_LIMIT');
  assert.equal(await code(() => mkService({ MARKET_PHOTO_MAX_COST_USD: '0.001' }).svc.identify(body, OWNER)), 'COST_LIMIT');
  let release; const gate = new Promise((r) => { release = r; }); const slow = createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b', GOOGLE_VISION_API_KEY: KEY, MARKET_PHOTO_ENABLED: '1', MARKET_PHOTO_MIN_INTERVAL_SEC: '0.001' }, fetchImpl: async (u, o) => { await gate; return visionOk()(u, o); } });
  const first = slow.identify(body, OWNER); await new Promise((r) => setTimeout(r, 5)); assert.equal(await code(() => slow.identify(body, OWNER)), 'PHOTO_BUSY'); release(); assert.equal((await first).status, 'DONE');
});

test('Vision failures reach the caller as named codes; the key never leaks; the daily counter still counts the attempt', async () => {
  for (const [st, c] of [[403, 'VISION_AUTH'], [429, 'VISION_QUOTA'], [500, 'VISION_ERROR']]) { const svc = createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b', GOOGLE_VISION_API_KEY: KEY, MARKET_PHOTO_ENABLED: '1' }, fetchImpl: async () => ({ ok: false, status: st, json: async () => ({}) }) });
    try { await svc.identify({ imageBase64: B64, consent: { accepted: true, sha256: SHA } }, OWNER); assert.fail('should throw'); } catch (e) { assert.equal(e.code, c); assert.ok(!JSON.stringify([e.message, e.stack]).includes(KEY)); } }
});

test('search with an identification: a LOCAL barcode becomes the first query; a forged identification is cleaned; the result says where each value came from', async () => {
  const sent = []; const f = async (url, opt = {}) => {
    if (url.endsWith('/appendix/user_data')) return { ok: true, status: 200, json: async () => ({ tasks: [{ result: [{ money: { balance: 1 } }] }] }) }; if (url.endsWith('/locations')) return { ok: true, status: 200, json: async () => ({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] }) };
    if (url.endsWith('/products/task_post')) { sent.push(JSON.parse(opt.body)[0].keyword); return { ok: true, status: 200, json: async () => ({ tasks: [{ id: 'q' + sent.length, status_code: 20100, cost: 0.002 }] }) }; }
    return { ok: true, status: 200, json: async () => ({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: [{ type: 'google_shopping_serp', title: 'ACME bottle', price: 10, currency: 'EUR', seller: 'S', url: 'https://google.be/search?ibp=oshop&q=x' }] }] }] }) }; };
  const svc = createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, fetchImpl: f, sleep: async () => {}, pollMs: 1 });
  const r = await svc.search({ input: { name: 'My bottle' }, identification: { source: 'LOCAL_BARCODE', engine: 'local-js', format: 'ean_13', eans: ['4006381333931', '4006381333930'] } });
  assert.equal(sent[0], '4006381333931'); assert.equal(sent[1], 'My bottle'); assert.equal(r.identification.source, 'LOCAL_BARCODE'); assert.equal(r.identification.confidence, 'HIGH'); assert.deepEqual(r.identification.eans, ['4006381333931']); assert.equal(r.input.sources.gtin, 'LOCAL_BARCODE'); assert.equal(r.input.name, 'My bottle');
  const forged = await createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, fetchImpl: f, sleep: async () => {}, pollMs: 1 }).search({ input: { name: 'Other thing', brand: 'Acme' }, identification: { source: 'OWNER_ROOT', eans: ['4006381333931'] } });
  assert.equal(forged.identification, null); assert.equal(forged.input.gtin, null);
});

// ---- GTIN lookup (open Facts databases): fake fetch, no network
const off = (status, product) => async (url) => { if (url.includes('openfoodfacts')) return { ok: true, status: 200, json: async () => ({ status, product }) }; return { ok: true, status: 200, json: async () => ({ status: 0 }) }; };
test('GTIN lookup: name, first brand and quantity (trailing " e" removed); not found and failures are "not found", never an invented name; invalid GTIN sends nothing', async () => {
  const hit = await lookupGtin('3017620422003', { fetchImpl: off(1, { product_name: 'Nutella', brands: 'Nutella, Ferrero', quantity: '400 g e' }) }); assert.deepEqual([hit.found, hit.name, hit.brand, hit.quantity, hit.source], [true, 'Nutella', 'Nutella', '400 g', 'world.openfoodfacts.org']); assert.match(hit.url, /product\/3017620422003$/);
  assert.equal((await lookupGtin('3017620422003', { fetchImpl: off(0) })).found, false); assert.equal((await lookupGtin('3017620422003', { fetchImpl: async () => { throw new Error('net'); } })).found, false);
  let called = 0; assert.equal((await lookupGtin('3017620422004', { fetchImpl: async () => { called++; return {}; } })).found, false); assert.equal(called, 0);
  assert.equal((await lookupGtin('3017620422003', { fetchImpl: off(1, { product_name: '', brands: 'X' }) })).found, false);
});

function dfsFake(titleFor, kws) {
  return async (url, opt = {}) => {
    if (url.includes('openfoodfacts.org')) return off(1, { product_name: 'Nutella', brands: 'Nutella, Ferrero', quantity: '400 g' })(url); if (url.includes('openproductsfacts') || url.includes('openbeautyfacts')) return { ok: true, status: 200, json: async () => ({ status: 0 }) };
    if (url.endsWith('/appendix/user_data')) return { ok: true, status: 200, json: async () => ({ tasks: [{ result: [{ money: { balance: 1 } }] }] }) }; if (url.endsWith('/locations')) return { ok: true, status: 200, json: async () => ({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] }) };
    if (url.endsWith('/products/task_post')) { kws.push(JSON.parse(opt.body)[0].keyword); return { ok: true, status: 200, json: async () => ({ tasks: [{ id: 'z' + kws.length, status_code: 20100, cost: 0.002 }] }) }; }
    return { ok: true, status: 200, json: async () => ({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: titleFor(kws.at(-1)).map((t, i) => ({ type: 'google_shopping_serp', title: t, price: 3 + i, currency: 'EUR', seller: 'S' + i, url: 'https://google.be/search?ibp=oshop&q=' + i })) }] }] }) };
  };
}
test('search from a LOCAL barcode: the open database names it, the NAME is searched (not the bare number), unrelated results are flagged, the lookup is shown with its source', async () => {
  const kws = []; const f = dfsFake(() => ['Nutella pâte à tartiner 400 g', 'Ferrero Nutella 400g', 'Unox soep 48g', 'Chocomel 1 l'], kws);
  const r = await createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, fetchImpl: f, sleep: async () => {}, pollMs: 1 }).search({ input: {}, identification: { source: 'LOCAL_BARCODE', eans: ['3017620422003'], engine: 'local-js', format: 'ean_13' } });
  assert.deepEqual(kws, ['Nutella 400 g']); assert.equal(r.identification.gtinLookup.found, true); assert.equal(r.identification.gtinLookup.name, 'Nutella'); assert.equal(r.input.sources.name, 'GTIN_DB'); assert.equal(r.input.brand, 'Nutella');
  assert.equal(r.listings.filter((l) => l.flags.includes('NO_TEXT_OVERLAP')).length, 2); assert.equal(r.reference.count, 2); assert.equal(r.reference.matchClass, 'PROBABLE_MATCH');
});
test('barcode NOT in the open databases: the number is searched, every result is unverifiable (excluded, no range), and the result says so', async () => {
  const kws = []; const f = async (u, o) => (u.includes('open') && u.includes('facts') ? { ok: true, status: 200, json: async () => ({ status: 0 }) } : dfsFake(() => ['Anything', 'Whatever'], kws)(u, o));
  const r = await createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, fetchImpl: f, sleep: async () => {}, pollMs: 1 }).search({ input: {}, identification: { source: 'LOCAL_BARCODE', eans: ['4006381333931'] } });
  assert.deepEqual(kws, ['4006381333931']); assert.equal(r.identification.gtinLookup.found, false); assert.equal(r.reference.reliable, false); assert.equal(r.reference.count, 0); assert.equal(r.reference.medianEur, null); assert.ok(r.listings.every((l) => l.excludedFromReference));
});
test('the lookup can be switched off (MARKET_GTIN_LOOKUP=0): nothing is sent to the open databases', async () => {
  const kws = []; let open = 0; const base = dfsFake(() => ['X'], kws); const f = async (u, o) => { if (u.includes('facts')) open++; return base(u, o); };
  await createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b', MARKET_GTIN_LOOKUP: '0' }, fetchImpl: f, sleep: async () => {}, pollMs: 1 }).search({ input: {}, identification: { source: 'LOCAL_BARCODE', eans: ['3017620422003'] } }); assert.equal(open, 0);
});
