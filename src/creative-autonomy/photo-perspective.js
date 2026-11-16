// THE PERSPECTIVE OF THE REAL PHOTOGRAPH is not an artistic choice (2026-11-07). The product is placed in the set with the pixels of its photograph, so the camera of the set must look at the floor the way the photograph looked at the product.
// The owner-validated appearance sheet of a product may state it (`camera_height`: LOW | PRODUCT_CENTER | HIGH, the STAGE vocabulary). Real run 2026-11-07 (Remax FC-02, photographed from above): STAGE chose PRODUCT_CENTER, the set would have been seen at mid height.
// STAGE is TOLD (hint) and, whatever it answers, Nordla puts the camera back on the photograph's height and RECORDS it (like the other normalizations of STAGE); the rest of the stage is untouched.
const HEIGHTS = new Set(['LOW', 'PRODUCT_CENTER', 'HIGH']);
const WORDS = { LOW: 'slightly below the object', PRODUCT_CENTER: 'at the object\'s mid height', HIGH: 'slightly above the object' };

/** The camera height of the product's photograph, from the owner-validated appearance sheet; null when the sheet does not state one. */
export function photoCameraHeight(profile, productId) {
  const id = String(productId ?? '').split('/').pop();
  const h = profile?.product_appearance?.[id]?.camera_height ?? null;
  return HEIGHTS.has(h) ? h : null;
}

/** The sentence given to STAGE. */
export const perspectiveHint = (height) => `The real product is placed in the set with the pixels of its photograph, which was taken with the camera ${WORDS[height]}: the camera height of this stage MUST be ${height}.`;

/** { stage, normalization }: the stage with its camera height on the photograph's, and what was changed (null when nothing was). */
export function cameraFollowsPhoto(stage, height) {
  if (!height || !stage?.camera || stage.camera.height === height) return { stage, normalization: null };
  const normalization = { kind: 'CAMERA_FOLLOWS_PHOTO', path: 'stage.camera.height', from: stage.camera.height, to: height, why: 'the product keeps the perspective of its photograph' };
  return { stage: Object.freeze({ ...stage, camera: Object.freeze({ ...stage.camera, height }), nordla_normalizations: [...(stage.nordla_normalizations ?? []), normalization] }), normalization };
}
