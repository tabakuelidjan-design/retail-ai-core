// The two TEXT directions written for the Remax FC-02 (blue), and the draft that the packshot light rule refuses. TEXT ONLY: no image was generated for any of them.
// D1 "Le rebord": order, one band of low light on a bare concrete ledge. D3 "Deux lignes": two parallel bands on a terracotta wall, a navy bench (a bright, coloured, graphic scene).
// D2 "Le seuil" (a door ajar, light from behind on the right) is NOT a direction to render: it is the fixture that proves the light rule, because the archived Remax packshot is lit from the LEFT.
// The decor sentences are written in SCENE vocabulary (a band, an edge, a surface): they name neither the product, nor a cable, nor a person (the scene is built before the product exists).
// "Deux câbles intégrés" (verified fact of the archived sheet) is never staged in the decor: the real packshot shows the cable pixels, the scene never draws one.

const base = {
  depth_model: 'LAYERED_DEPTH', visual_rhythm: 'STILL', product_relationship: 'GROUNDED_IN_SCENE', text_image_relationship: 'TEXT_IN_CALM_ZONES', realism: 'PHOTOREALISTIC',
  visual_tension: 'MEDIUM',
};
const noise = ['beige, crème, sable, écru, taupe, ivoire', 'feuillage, végétation, fleurs', 'doré, luxe, marbre, velours', 'cœur', 'logo, texte, étiquette'];

export const D1 = Object.freeze({
  concept: {
    concept_id: 'cnc_d1_le_rebord', central_idea: 'Tout est déjà en place : un rebord de béton nu, une seule bande de lumière basse qui le traverse et s’arrête net.',
    visual_metaphor: 'Une bande de lumière en diagonale, droite et nette, comme un trait tiré à la règle sur une page vide.',
    story: 'Le matin, avant de partir : rien d’autre à préparer, rien à chercher ; ce qu’il faut est déjà posé là, dans l’ordre.',
    emotional_intent: 'Un calme d’ordre : la tranquillité de savoir que tout est prêt.', product_role: 'HERO_OF_THE_STORY', message_role: 'FOLLOWS',
    memory_hook: 'La bande de lumière qui traverse le rebord et s’arrête sur une arête d’ombre nette.', distinctiveness_reason: 'Une seule idée graphique, un bord réel : elle ne se confond pas avec un fond de studio.',
    risks: ['Peut se lire comme une pièce vide si la bande de lumière est trop faible'],
  },
  art: {
    ...base, atmosphere: 'Un ordre tranquille du matin, sans mise en scène : tout semble déjà à sa place.',
    material_language: 'Béton coulé mat, pores fins, gris froid ; une arête de rebord franche et une face verticale unie.',
    lighting_intent: 'Lumière basse et douce venue de la gauche, qui dépose une seule bande diagonale sur le rebord et finit sur une arête d’ombre nette.',
    emotional_temperature: 'COOL', negative_space_strategy: 'ASYMMETRIC_RESERVE',
    narrative_elements: [
      { element: 'Une seule bande de lumière basse, en diagonale sur le dessus du rebord, qui s’arrête sur une arête d’ombre nette', reason: 'Elle porte l’idée de prévoyance tranquille : une bande de lumière, rien d’autre à ajouter, tout est en ordre.', zone: 'MIDGROUND' },
      { element: 'L’arête avant du rebord, droite et franche, avec sa face verticale unie en dessous', reason: 'Elle donne un vrai bord au rebord et ancre l’ordre tranquille du décor.', zone: 'FOREGROUND' },
    ],
    permitted_secondary_elements: ['Pores fins du béton', 'Légères irrégularités de la surface du rebord'], forbidden_decorative_noise: noise,
    rationale: 'Une seule bande de lumière sur un rebord nu : l’idée se lit sans titre, et le bord réel permet de poser le produit.',
  },
  stage: {
    backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'MATTE',
    key_light: { kind: 'SOFTBOX', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'Dépose la bande diagonale sur le rebord et sculpte une arête d’ombre nette, du côté où le packshot est éclairé.' },
    accent_lights: [{ kind: 'RIM', side: 'RIGHT', intensity: 'LOW', temperature: 'COOL', purpose: 'Sépare légèrement les bords du fond sans effet lumineux artificiel.' }],
    camera: { height: 'HIGH', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, support_surface: 'LEDGE', props: [],
    headline: 'Tout est déjà là', text_placement: 'RIGHT_COLUMN', show_price: 'YES',
    rationale: 'Le rebord porte une seule idée, l’ordre ; la lumière de gauche accompagne celle du packshot ; le texte reste à droite.',
  },
});

export const D3 = Object.freeze({
  concept: {
    concept_id: 'cnc_d3_deux_lignes', central_idea: 'Deux lignes de lumière parallèles traversent un mur terracotta et un banc marine : un double trait net, posé avant qu’on arrive.',
    visual_metaphor: 'Deux bandes parallèles, tirées à la règle, qui se répondent comme deux traits jumeaux.',
    story: 'On entre dans la pièce : deux traits de lumière attendent sur le mur, deux lignes droites qui disent que tout est déjà relié.',
    emotional_intent: 'Une énergie claire et gaie : le plaisir d’un geste simple, déjà prêt.', product_role: 'HERO_OF_THE_STORY', message_role: 'FOLLOWS',
    memory_hook: 'Deux bandes de lumière parallèles sur un mur terracotta, le bleu pâle posé devant.', distinctiveness_reason: 'La couleur complémentaire du bleu pâle et le double trait : un décor qui ne ressemble à aucun fond neutre.',
    risks: ['Les deux bandes ne doivent pas traverser la zone du produit'],
  },
  art: {
    ...base, atmosphere: 'Lumineuse, colorée et graphique : un après-midi net, des aplats francs.',
    material_language: 'Mur enduit terracotta mat, banc peint bleu marine mat, joints fins ; des aplats francs.',
    lighting_intent: 'Une lumière douce et égale venue de la gauche sur le dessus du banc ; une seconde source franche et haute, à travers une grille, trace deux bandes parallèles nettes sur le mur, loin du centre du banc.',
    emotional_temperature: 'CONTRASTED', negative_space_strategy: 'DIRECTIONAL_LEAD', visual_tension: 'HIGH',
    narrative_elements: [
      { element: 'Deux bandes de lumière parallèles, nettes, en diagonale sur le mur terracotta', reason: 'Le double trait porte l’idée : deux lignes de lumière parallèles, tirées à la règle, déjà posées.', zone: 'BACKGROUND' },
      { element: 'Un banc marine au dessus plat, avec une arête avant franche', reason: 'Le banc marine répond au mur terracotta et donne un vrai bord à la scène colorée.', zone: 'FOREGROUND' },
    ],
    permitted_secondary_elements: ['Joints fins de l’enduit', 'Légère variation de teinte de la peinture du banc'], forbidden_decorative_noise: noise,
    rationale: 'Un double trait de lumière sur un aplat terracotta : la scène est colorée et graphique, et le bleu pâle du packshot s’y détache.',
  },
  stage: {
    backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'BRAND_TERRACOTTA', floor_finish: 'MATTE',
    key_light: { kind: 'SOFTBOX', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'Source principale : éclaire le dessus du banc doucement et à égalité, du côté où le packshot est éclairé.' },
    accent_lights: [{ kind: 'STRIP', side: 'LEFT', intensity: 'HIGH', temperature: 'NEUTRAL', purpose: 'Appoint franc et haut : trace les deux bandes parallèles nettes sur le mur, loin du centre du banc.' }],
    camera: { height: 'HIGH', framing: 'MEDIUM', product_position: 'CENTER' }, support_surface: 'BENCH', props: [],
    headline: 'Prête avant le départ', text_placement: 'TOP_RIGHT', show_price: 'YES',
    rationale: 'Le mur terracotta fait ressortir le bleu pâle ; deux bandes parallèles portent l’idée ; la lumière de gauche accompagne celle du packshot.',
  },
});

/** The "Le seuil" draft: key light from BEHIND the right, against a packshot lit from the left. Used ONLY to prove that the light rule refuses it. */
export const D2_REFUSED_STAGE = Object.freeze({
  ...D1.stage, key_light: { kind: 'SPOT', side: 'BACK', intensity: 'HIGH', temperature: 'COOL', purpose: 'Contre-jour par l’ouverture de la porte, depuis la droite et l’arrière.' },
  accent_lights: [], camera: { height: 'HIGH', framing: 'WIDE', product_position: 'RIGHT_THIRD' }, support_surface: 'STEP', headline: 'On part, elle est prête', text_placement: 'LEFT_COLUMN',
});
