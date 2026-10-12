// A synthetic world for the content planning tests: texts of controlled size, scripted copy ports (no network, no provider, no cost), request builders.

export const sentence = (n) => `Phrase numéro ${n} : notre atelier de Namur imprime vos photos sur des coques personnalisées avec soin.`;
export const paragraph = (start, count) => Array.from({ length: count }, (_, i) => sentence(start + i)).join(' ');
/** A text of about `words` words, in `paragraphs` paragraphs (1 = one block). */
export function longText(words, paragraphs = 1) {
  const perSentence = 15; const total = Math.max(1, Math.round(words / perSentence));
  const per = Math.ceil(total / paragraphs); const parts = [];
  for (let p = 0; p < paragraphs && p * per < total; p += 1) parts.push(paragraph(p * per + 1, Math.min(per, total - p * per)));
  return parts.join(paragraphs > 1 ? '\n\n' : ' ');
}

export const copy = (over = {}) => ({ copy_ref: 'copy://main', mode: 'COPY_LOCKED', text: 'Bonjour Namur', ...over });
export const request = (over = {}) => ({ request_ref: 'req:test', locale: 'fr-BE', copy: [copy()], ...over });
export const fact = (over = {}) => ({
  fact_ref: 'fact://descr', kind: 'DESCRIPTIVE', status: 'VERIFIED', statement: 'Atelier de coques personnalisées à Namur, prêtes en cinq minutes.', ...over,
});
export const priceFact = (over = {}) => fact({ fact_ref: 'fact://price', kind: 'PRICE', statement: 'Coque personnalisée : 25 €', ...over });

/** A scripted copy port: answers are taken in order; every call is recorded. */
export function scriptedCopyPort(kind, answers) {
  const calls = []; const queue = [...answers];
  const complete = async (instruction) => {
    calls.push({ kind, instruction });
    if (!queue.length) throw Object.assign(new Error('no scripted answer'), { code: 'NO_SCRIPT' });
    const next = queue.shift();
    return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake-model', request_id: `req-${kind}-${calls.length}` };
  };
  return { complete, calls };
}
