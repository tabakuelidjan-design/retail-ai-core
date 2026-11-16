// THE PHONE AS A STRUCTURED CHOICE (2026-11-15, after the real attempt cr-40695f8e3f9c). When a campaign allows a secondary smartphone (scene-permissions.js), Creator no longer WRITES the phone in free texts
// ("Smartphone lying flat, 5 cm right of the power bank"): such a sentence carried a distance and the product's name, and a refusal of it stopped the composition. Creator now CHOOSES two words, its presence and its position
// relative to the product; Nordla writes the phone into the image request itself (the whole phone inside the frame, its screen switched off, close to the product, the product's cable unplugged, in its photographed pose).
// Nothing here writes a scene: the sentence only restates the permission's own limits around the side Creator chose. PURE module.
import { word } from '../creative-brain/contract.js';
import { PERMISSION } from './scene-permissions.js';

export const PHONE_PRESENCE = Object.freeze({ PRESENT: 'PRESENT', ABSENT: 'ABSENT' });
export const PHONE_POSITION = Object.freeze({ RIGHT_OF_PRODUCT: 'RIGHT_OF_PRODUCT', LEFT_OF_PRODUCT: 'LEFT_OF_PRODUCT', IN_FRONT_OF_PRODUCT: 'IN_FRONT_OF_PRODUCT', NOT_APPLICABLE: 'NOT_APPLICABLE' });
const SIDE_WORDS = { RIGHT_OF_PRODUCT: 'to the right of the product', LEFT_OF_PRODUCT: 'to the left of the product', IN_FRONT_OF_PRODUCT: 'in front of the product' };

/** The structured phone applies only to a campaign that allows the secondary smartphone. */
export const phoneIsStructured = (permissions = []) => permissions.includes(PERMISSION.SECONDARY_SMARTPHONE);

/** The two spec fields (none when the campaign does not allow a phone: its answer then holds no phone field). */
export const phoneSpecFields = (permissions = []) => (phoneIsStructured(permissions) ? { phone_presence: word(PHONE_PRESENCE), phone_position: word(PHONE_POSITION) } : {});

export const phoneInstruction = (permissions = []) => (phoneIsStructured(permissions)
  ? 'THE PHONE IS A CHOICE, NOT A TEXT. The campaign allows ONE secondary smartphone: choose phone_presence (PRESENT or ABSENT) and phone_position (RIGHT_OF_PRODUCT, LEFT_OF_PRODUCT or IN_FRONT_OF_PRODUCT; NOT_APPLICABLE when ABSENT), on a side where the frame leaves room. Nordla writes the phone into the image request itself (whole phone in the frame, screen off, product cable unplugged): never describe the phone, its place, its distance or its screen in any other field, and give it no element.'
  : null);

/** Violations of the structured choice (a pair that cannot be turned into an instruction, or a side with no room). */
export function phoneViolations(c, permissions = []) {
  if (!phoneIsStructured(permissions)) return [];
  const out = []; const p = c?.phone_presence; const pos = c?.phone_position;
  if (p === PHONE_PRESENCE.PRESENT && pos === PHONE_POSITION.NOT_APPLICABLE) out.push({ field: 'phone_position', rule: 'PHONE_PRESENT_WITHOUT_A_POSITION', message: 'phone_presence is PRESENT: phone_position must say RIGHT_OF_PRODUCT, LEFT_OF_PRODUCT or IN_FRONT_OF_PRODUCT' });
  if (p === PHONE_PRESENCE.ABSENT && pos && pos !== PHONE_POSITION.NOT_APPLICABLE) out.push({ field: 'phone_position', rule: 'PHONE_POSITION_WITHOUT_A_PHONE', message: 'phone_presence is ABSENT: phone_position must be NOT_APPLICABLE' });
  if (p === PHONE_PRESENCE.PRESENT) {
    if (c?.product_position === 'LEFT_THIRD' && pos === PHONE_POSITION.LEFT_OF_PRODUCT) out.push({ field: 'phone_position', rule: 'PHONE_SIDE_WITHOUT_ROOM', message: 'the product stands in the left third of the frame: the phone cannot go to its left and stay inside the frame; choose RIGHT_OF_PRODUCT or IN_FRONT_OF_PRODUCT' });
    if (c?.product_position === 'RIGHT_THIRD' && pos === PHONE_POSITION.RIGHT_OF_PRODUCT) out.push({ field: 'phone_position', rule: 'PHONE_SIDE_WITHOUT_ROOM', message: 'the product stands in the right third of the frame: the phone cannot go to its right and stay inside the frame; choose LEFT_OF_PRODUCT or IN_FRONT_OF_PRODUCT' });
  }
  return out;
}

/** The sentence Nordla writes into the image request (null when there is no phone). The limits are the permission's own; the side is Creator's choice. */
export function phoneRequestSentence(c) {
  if (c?.phone_presence !== PHONE_PRESENCE.PRESENT || !SIDE_WORDS[c?.phone_position]) return null;
  return `A smartphone lies ${SIDE_WORDS[c.phone_position]}, close to it, fully inside the frame, entirely visible, with its screen switched off and dark; it is smaller than the product and secondary to it. The cable of the product stays unplugged, hanging exactly as in image 1, connected to nothing.`;
}

// ---- what Nordla removes BEFORE validation: the pieces of free text that used to stop the composition (recorded, never silent)
const PHONE_WORD = /(?<![\p{L}])(phones?|smartphones?|handsets?|t[ée]l[ée]phones?)(?![\p{L}])/iu;
const DIGIT_OR_UNIT = /[0-9]|\b(px|pt|em|rem)\b/i;
const MODEL_NUMBER = /(?<![\p{L}\d])[A-Z]{1,4}-\d{1,4}[A-Z]?(?![\p{L}\d])/u;
const MODEL_NUMBERS = new RegExp(MODEL_NUMBER.source, 'gu'); // "FC-02": the reference of the product, a digit the scene never needs
const SENTENCE_SPLIT = /(?<=[.;!?])\s+/;
const FREE_TEXT_FIELDS = ['idea', 'structure', 'setting', 'materials', 'atmosphere', 'light', 'visible_link'];
const subjectIsThePhone = (t) => { const m = PHONE_WORD.exec(String(t)); return Boolean(m) && String(t).slice(0, m.index).split(/\s+/).filter(Boolean).length <= 3; };

/**
 * @returns {{ value: object, removed: Array<{field, passage, reason}> }} the answer with (1) the model number of the product taken out of the scene texts, and, when the phone is structured, (2) every scene element whose subject is
 * the phone, and every sentence of the other scene texts that talks about the phone AND carries a figure or a unit (the distance), taken out. The phone is then described by Nordla's own sentence. Nothing else is touched.
 */
export function scrubComposition(value, { permissions = [] } = {}) {
  const removed = []; const out = { ...value };
  const noModel = (t) => String(t).replace(MODEL_NUMBERS, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  for (const f of FREE_TEXT_FIELDS) if (typeof out[f] === 'string') {
    const before = out[f]; const m = before.match(MODEL_NUMBERS); if (m) { out[f] = noModel(before); removed.push({ field: f, passage: m.join(', '), reason: 'MODEL_NUMBER_REMOVED' }); }
  }
  if (Array.isArray(out.elements)) out.elements = out.elements.map((e) => (e && typeof e.element === 'string' && MODEL_NUMBER.test(e.element) ? (removed.push({ field: 'elements.element', passage: e.element.match(MODEL_NUMBERS).join(', '), reason: 'MODEL_NUMBER_REMOVED' }), { ...e, element: noModel(e.element) }) : e));
  if (phoneIsStructured(permissions)) {
    for (const f of FREE_TEXT_FIELDS) if (typeof out[f] === 'string' && PHONE_WORD.test(out[f])) {
      const parts = out[f].split(SENTENCE_SPLIT); const kept = parts.filter((s) => { const drop = PHONE_WORD.test(s) && DIGIT_OR_UNIT.test(s); if (drop) removed.push({ field: f, passage: s, reason: 'PHONE_DISTANCE_REMOVED' }); return !drop; });
      if (kept.length !== parts.length && kept.length) out[f] = kept.join(' ');
      else if (kept.length !== parts.length) { removed.pop(); } // never empty a whole text: it stays and the usual rules judge it
    }
    if (Array.isArray(out.elements)) out.elements = out.elements.filter((e) => { const drop = e && typeof e.element === 'string' && subjectIsThePhone(e.element); if (drop) removed.push({ field: 'elements.element', passage: e.element, reason: 'PHONE_ELEMENT_REPLACED_BY_THE_STRUCTURED_CHOICE' }); return !drop; });
  }
  return { value: out, removed };
}
