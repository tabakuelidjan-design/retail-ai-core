// TEST ONLY: the text-model double of the AD route. It answers each stage with a VALID PLACEHOLDER (mechanical text, never an idea): proof of the PATH, never of the art.
// Used by test/creator-ad-route-e2e.test.js and by the preload fetch double of the simulated Creator (npm run creator:live-sim -- --route ad).
const lines = (n, w) => Array.from({ length: n }, (_, i) => `${w} ${i + 1}`);

/** @returns {{ stage: string, body: object } | null}  null when the instruction is not an AD stage */
export function adAnswerFor(system, user) {
  if (system.includes('you UNDERSTAND')) {
    return { stage: 'UNDERSTAND', body: { characteristics: lines(3, 'Caractéristique').map((characteristic) => ({ characteristic, basis: 'VISIBLE_ON_PHOTO', why_it_can_interest: 'Parce que.' })), public_needs: lines(3, 'Besoin'), standing: 'Rien d\'exceptionnel.', rapprochements: lines(6, 'Domaine').map((domain) => ({ domain, link: 'Un lien.' })) } };
  }
  if (system.includes('Each proposal STARTS from a situation of use')) {
    return { stage: 'DEVELOP', body: { proposals: [1, 2, 3, 4].map((i) => ({ name: `Proposition ${i}`, from_rapprochement: `Domaine ${i}`, starting_point: 'PRODUCT_NATURE', need: `Besoin ${i}`, idea: `Idée développée numéro ${i}.`, visible_cues: `Indice visible ${i}`, cable_role: `Rôle du câble ${i}`, link_to_product: 'Lien avec le produit.', speaks_to_the_public: 'Parle au public.', headline: `Titre ${'abcd'[i - 1]}`, product_brings: `Ce que le produit apporte ${i}.`, scene_alone_reading: `Ce que la scène seule montre ${i}.`, headline_adds: `Raison ajoutée ${i}.`, supported_by: [] })), how_they_differ: 'Ils diffèrent par nature.' } };
  }
  if (system.includes('You do not know where they come from')) {
    const ids = user.proposals.map((p) => p.id);
    // the placeholder judge keeps the ONE retained proposal at brief_fit HIGH (a retained proposal must fit the brief) and the others at MEDIUM: proof of the PATH, never a judgment
    return { stage: 'COMPARE', body: { scores: ids.map((id) => ({ id, harmony: 'HIGH', relevance: 'MEDIUM', desirability: 'HIGH', originality: 'MEDIUM', feasibility: 'HIGH', cues_in_scene: 'ALL', brief_fit: id === ids[1] ? 'HIGH' : 'MEDIUM', note: `Note ${id}.`, scene_alone: { need_clear: 'HIGH', benefit_clear: 'HIGH', reading: `Lecture de la scène ${id}.`, detail: String(user.proposals.find((p) => p.id === id)?.visible_cues ?? 'AUCUN'), detail_shows: 'THE_NEED', customer_understands: 'Placeholder: ce que le client comprend.' }, with_headline: { adds: 'ADDS_A_REASON', note: `Titre ${id}.` } })), choice: ids[1], why_this_one: 'La plus forte des quatre.', headline_direction: 'AUCUN' } };
  }
  if (system.includes('In ONE answer you decide what the advertisement shows and says')) {
    // the SINGLE answer of the short path (placeholder, proof of the path): an IDEA whose need_shown is a passage of its own scene text, or NONE (NORDLA_TEXT_DOUBLE_SINGLE=NONE)
    if (process.env.NORDLA_TEXT_DOUBLE_SINGLE === 'NONE') return { stage: 'SINGLE', body: { verdict: 'NONE', none_reason: 'Aucune idée convaincante : rien dans la scène ne montre un besoin du client.' } };
    return { stage: 'SINGLE', body: { verdict: 'IDEA', none_reason: '', benefit: 'Le client repart tout de suite, sans rien chercher.', need_shown: 'ready to be grabbed when the plans change',
      idea: 'A pale object rests on a light bench beside a half-open bag, ready to be grabbed when the plans change.', setting: 'A bright morning corner with clear walls and soft natural light.', materials: 'Pale wood, soft fabric and smooth plaster.', atmosphere: 'Lively and calm.', light: 'Soft natural light from the left, compatible with the photograph.',
      text_reserve: { zone: 'TOP_RIGHT', description: 'A calm light wall surface in the upper right corner.' }, elements: [{ zone: 'BACKGROUND', element: 'A clear wall with a window' }, { zone: 'MIDGROUND', element: 'A light wooden bench' }], headline: process.env.NORDLA_TEXT_DOUBLE_HEADLINE || 'Prêt quand tu changes de plan', headline_lines: 'TWO',
      caption: 'Pour les journées qui changent de plan : prêt à partir, sans y penser.\n#HABB #Namur', palette_roles: [{ colour: 'STEEL_NAVY', role: 'DOMINANT', surfaces: 'the wall accents' }, { colour: 'WHITE', role: 'LIGHT_TINT', surfaces: 'the bench highlight' }] } };
  }
  if (system.includes('You compose ONE advertisement') && system.includes('THE SOFTWARE DECIDES THE FRAMING')) {
    // the SHORT form: the scene only (placeholder, proof of the path); the software chooses the framing
    const revised = Boolean(user.revision); const smart = user.brief?.scene_permissions?.includes('SECONDARY_SMARTPHONE');
    return { stage: revised ? 'RECOMPOSE' : 'COMPOSE', body: { concept_conserve: revised ? 'ADAPTED' : 'CONSERVED', concept_changes: revised ? `Revision: ${String(user.revision.note).slice(0, 120)}` : 'Rien n\'a changé.',
      idea: revised ? 'Two tall quiet planes echo the height of the object while a low surface holds it in a brighter calm light.' : 'Two tall quiet planes echo the height of the object while a low surface holds it in a calm light.',
      setting: 'A calm studio of matte planes.', materials: 'Matte plaster and smooth ceramic.', atmosphere: 'Calm and precise.', light: 'A wide soft light from the left, compatible with the photograph.',
      text_reserve: { zone: 'TOP_RIGHT', description: 'A calm matte slate surface in the upper right corner.' }, elements: [{ zone: 'BACKGROUND', element: 'A tall matte slate plane' }, { zone: 'MIDGROUND', element: 'A low smooth ceramic support' }],
      ...(smart ? { phone_presence: 'PRESENT', phone_position: 'RIGHT_OF_PRODUCT' } : {}),
      headline: process.env.NORDLA_TEXT_DOUBLE_HEADLINE || 'Le noir, sans détour', headline_lines: 'TWO', caption: 'Pour les journées qui changent de plan : un objet prêt à partir, sans y penser.\n#HABB #Namur', palette_roles: [{ colour: 'STEEL_NAVY', role: 'DOMINANT', surfaces: 'the broad plane' }, { colour: 'WHITE', role: 'LIGHT_TINT', surfaces: 'the support highlight' }] } };
  }
  if (system.includes('You compose ONE advertisement')) {
    const opts = user.placement_options?.options ?? [{ product_position: 'LEFT_THIRD', product_framing: 'MEDIUM' }]; // a PATCH repair does not carry the placement options (only the fields it is asked to correct)
    const o = opts.find((x) => x.fits_in_frame) ?? opts[0];
    const revised = Boolean(user.revision);
    return { stage: revised ? 'RECOMPOSE' : 'COMPOSE', body: { concept_conserve: revised ? 'ADAPTED' : 'CONSERVED', concept_changes: revised ? `Revision: ${String(user.revision.note).slice(0, 120)}` : 'Rien n\'a changé.', starting_point: 'PRODUCT_NATURE', relation: 'VISUAL',
      intention: 'La scène répond à la forme sombre et haute de l\'objet.', visible_link: 'Les plans répètent la hauteur de l\'objet.', reason_to_care: 'Il se lit comme un objet soigné.', audience_use: 'Public défini dans le brief.', supported_by: [], product_nature: 'Un objet sombre, haut et cylindrique.',
      idea: revised ? 'Two tall quiet planes echo the height of the object while a low surface holds it in a brighter calm light.' : 'Two tall quiet planes echo the height of the object while a low surface holds it in a calm light.',
      product_position: o.product_position, product_framing: o.product_framing, structure: 'Two broad planes meet behind a low support.', setting: 'A calm studio of matte planes.', materials: 'Matte plaster and smooth ceramic.', atmosphere: 'Calm and precise.', light: 'A wide soft light from the left.',
      text_reserve: { zone: 'TOP_RIGHT', description: 'A calm matte slate surface in the upper right corner.' }, elements: [{ zone: 'BACKGROUND', element: 'A tall matte slate plane' }, { zone: 'MIDGROUND', element: 'A low smooth ceramic support' }], resolution: 'Nothing to resolve.', placement_why: 'Placed so the planes and the light read around the form.',
      headline: process.env.NORDLA_TEXT_DOUBLE_HEADLINE || 'Le noir, sans détour', headline_role: 'Echoes the calm of the scene.', headline_lines: 'TWO', palette_roles: [{ colour: 'STEEL_NAVY', role: 'DOMINANT', surfaces: 'the broad plane' }, { colour: 'WHITE', role: 'LIGHT_TINT', surfaces: 'the support highlight' }],
      // PLACEHOLDER of the structured phone choice (proof of the path, never a judgment): on the side that has room
      ...(user.brief?.scene_permissions?.includes('SECONDARY_SMARTPHONE') ? { phone_presence: 'PRESENT', phone_position: o.product_position === 'RIGHT_THIRD' ? 'LEFT_OF_PRODUCT' : 'RIGHT_OF_PRODUCT' } : {}),
      choices: ['COMPOSITION', 'PRODUCT_PLACEMENT', 'LIGHT', 'PALETTE', 'TEXT_RESERVE'].map((d) => ({ decision: d, why: `because of ${d}` })) } };
  }
  return null;
}
