// TEST ONLY (loaded with --import): replaces globalThis.fetch so that the trial script runs end to end with NO network and NO cost.
// The model list answers exactly what the owner received from Alibaba on 2026-11-01 (request_id 6864af00-...); chat completions answer generic test-world content.
import { appendFileSync } from 'node:fs';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from '../../creative-brain-world.js';
import { normalizeConceptSet } from '../../../src/creative-brain/concept.js';

const LOG = process.env.NORDLA_FETCH_DOUBLE_LOG;
const MODE = process.env.NORDLA_FETCH_DOUBLE_MODEL_LIST ?? 'OWNER_PROOF';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ host: u.host, path: u.pathname, query: u.search, model: init.body ? JSON.parse(init.body).model : null })}\n`);
  if (u.pathname === '/api/v1/models') {
    if (MODE === 'OWNER_PROOF') return json({ code: null, message: null, success: true, output: { total: 1, page_no: 1, page_size: 20, models: [{ model: 'qwen3-vl-plus', name: 'Qwen3-VL-Plus' }] }, request_id: '6864af00-406c-95e9-997e-79cf755985ac' });
    if (MODE === 'SUCCESS_FALSE') return json({ code: 'X', message: 'x', success: false, output: { total: 1, models: [{ model: 'qwen3-vl-plus' }] }, request_id: 'r-false' });
    return json({ success: true, output: { total: 168, page_no: 1, page_size: 20, models: [{ model: 'qwen3.8-max' }] }, request_id: 'r-page' });
  }
  const body = JSON.parse(init.body);
  const system = body.messages[0].content; const user = body.messages[1].content;
  let answer;
  if (system.includes('problem framer')) answer = frameAnswer();
  else if (system.includes('concept director')) answer = { concepts: CONCEPTS };
  else if (system.includes('concept selector')) answer = evaluationsAnswer(normalizeConceptSet(CONCEPTS), []);
  else if (system.includes('art director')) { const c = JSON.parse(user).concept; answer = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }); }
  else { const c = JSON.parse(user).concept; answer = { backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'double' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Titre de test', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'double', wanted_but_not_available: ['test double gap'] }; }
  return json({ id: `req-double-${Date.now()}`, model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550 } });
};
