// THE FRAMING IS THE SOFTWARE'S (2026-11-15, after the real attempts cr-bc12c30da975, cr-eaae17f7c08b, cr-40695f8e3f9c and cr-910db1077b84). In the long form the model wrote where the product stands, at what scale, and a "structure" paragraph
// that repeated measured geometry ("foot at 84% of frame height", "5 cm to its right"): four real runs were stopped on a digit or on a distance in those texts. In the SHORT form the model writes the scene (idea, setting, materials,
// atmosphere, light, elements, the calm area of the headline, palette, headline, the phone choice) and NOTHING about the place or the size of the product. After the model has answered, the software picks among the MEASURED
// placements (placement_options: the box of the product in the frame and the free space on each side) with one deterministic rule that only protects what is already decided: the calm area of the headline stays clear of the
// product, the phone has room on the side the model chose, the product box fits. Inside what is left it keeps the scale and the side that every archived run of the model had chosen (MEDIUM, on the side opposite the calm area):
// a conservative default, not an artistic decision (a larger product also crowds the corner of the logo: seen on the first offline replay). It writes no scene and no idea. PURE module.
import { PHONE_PRESENCE, PHONE_POSITION } from './phone-placement.js';

export const PHONE_ROOM_MIN_SHARE_OF_WIDTH = 20; // the phone needs about a fifth of the frame width beside the product (free_left/right_share_of_width, in percent)
const RESERVE_SIDE = Object.freeze({ TOP_LEFT: 'LEFT_THIRD', LEFT_COLUMN: 'LEFT_THIRD', BOTTOM_LEFT: 'LEFT_THIRD', TOP_RIGHT: 'RIGHT_THIRD', RIGHT_COLUMN: 'RIGHT_THIRD', BOTTOM_RIGHT: 'RIGHT_THIRD' });
const FRAMING_RANK = Object.freeze({ MEDIUM: 0, CLOSE: 1, WIDE: 2 }); // MEDIUM first: it is the scale of every archived composition, and it leaves a free corner for the logo and the headline
const OPPOSITE = Object.freeze({ LEFT_THIRD: 'RIGHT_THIRD', RIGHT_THIRD: 'LEFT_THIRD' });

/** @returns {{ ok: true, option, reason: string } | { ok: false, code: string, message: string, field: string }} the measured placement the software keeps for this scene. */
export function chooseFraming({ placementOptions, textZone, phone = { presence: PHONE_PRESENCE.ABSENT, position: PHONE_POSITION.NOT_APPLICABLE } }) {
  const options = (placementOptions?.options ?? []).filter((o) => o.fits_in_frame);
  if (!options.length) return { ok: false, code: 'NO_MEASURED_PLACEMENT_FITS', field: 'text_reserve.zone', message: 'no measured placement of the product fits in the frame' };
  const avoid = RESERVE_SIDE[textZone] ?? null;
  const roomOk = (o) => {
    if (phone.presence !== PHONE_PRESENCE.PRESENT) return true;
    if (phone.position === PHONE_POSITION.RIGHT_OF_PRODUCT) return o.free_right_share_of_width >= PHONE_ROOM_MIN_SHARE_OF_WIDTH;
    if (phone.position === PHONE_POSITION.LEFT_OF_PRODUCT) return o.free_left_share_of_width >= PHONE_ROOM_MIN_SHARE_OF_WIDTH;
    return true;
  };
  const allowed = options.filter((o) => o.product_position !== avoid && roomOk(o));
  if (!allowed.length) {
    const phoneSide = phone.presence === PHONE_PRESENCE.PRESENT && phone.position !== PHONE_POSITION.IN_FRONT_OF_PRODUCT;
    return { ok: false, code: 'NO_FRAMING_FOR_THIS_RESERVE_AND_PHONE', field: phoneSide ? 'phone_position' : 'text_reserve.zone',
      message: `no measured placement keeps the product clear of the calm area (${textZone}) and leaves room for the phone (${phone.position}): choose a calm area on another side or put the phone on the other side or in front of the product` };
  }
  const sideRank = (o) => (avoid && o.product_position === OPPOSITE[avoid] ? 0 : o.product_position === 'CENTER' ? 1 : 2); // opposite the calm area first, then the centre
  const rank = (o) => (FRAMING_RANK[o.product_framing] ?? 9) * 10 + sideRank(o);
  const best = [...allowed].sort((a, b) => rank(a) - rank(b))[0];
  const reason = `chosen by the framing rule of Nordla among ${options.length} measured placements: the product keeps clear of the calm area (${textZone}), ${phone.presence === PHONE_PRESENCE.PRESENT ? `the phone has room ${phone.position}` : 'no phone is placed'}, and it takes the default scale (MEDIUM) on the side opposite the calm area when they allow it (${best.product_position}/${best.product_framing})`;
  return { ok: true, option: best, reason };
}

/** The answer of the SHORT form completed with what the software decided and with the retained proposal's OWN earlier words (no new text from the model, nothing written by the code but the framing and its reason). */
export function finalizeShort(c, { concept, placementOptions }) {
  const f = chooseFraming({ placementOptions, textZone: c.text_reserve?.zone, phone: { presence: c.phone_presence, position: c.phone_position } });
  if (!f.ok) throw Object.assign(new Error(f.message), { code: f.code, field: f.field });
  return {
    ...c, form: 'SHORT', product_position: f.option.product_position, product_framing: f.option.product_framing, placement_why: f.reason,
    intention: concept?.idea ?? c.idea, visible_link: concept?.visible_cues ?? '', reason_to_care: concept?.product_brings ?? concept?.need ?? '',
  };
}
