// TEST ONLY: the archived composition answers (real model texts of 2026-11-08..14) were written before the phone became a structured choice (phone_presence, phone_position). This helper adds those two fields, as a SIMULATED
// choice, when they are missing and the campaign allows the phone: the archived words stay exactly as they were. It never touches a field that is already there and it adds NO reason to buy to any scene.
export function withNewFields(answer, { phone = false } = {}) {
  const isText = typeof answer === 'string'; const o = isText ? JSON.parse(answer) : answer;
  const out = { ...o, ...(phone && !o.phone_presence ? { phone_presence: 'PRESENT', phone_position: o.product_position === 'RIGHT_THIRD' ? 'LEFT_OF_PRODUCT' : 'RIGHT_OF_PRODUCT' } : {}) };
  return isText ? JSON.stringify(out) : out;
}
