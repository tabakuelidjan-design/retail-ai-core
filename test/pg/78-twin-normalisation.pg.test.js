// Parity between the SQL normalisation (fin_bank_norm, used by the twin guard) and the service normalisation (bank-identity.js movementKey).
// If they differ on a text, the database and the service would not agree on whether two movements are twins. Synthetic samples only.
import { freshDatabase } from './lib/db.js';
import { control } from './lib/classify.js';
import { movementKey } from '../../src/finance/bank-identity.js';

// Accents that decompose, letters that do not, ligatures and special upper-case expansions, dotless i, long s, digraphs, separators.
const SAMPLES = [
  'INV-2026-0001', '+++090/9337/55493+++', 'Client Exemple SA', 'Atelier Ünïcode', 'Café de la Gare', 'Ménage à trois', 'Ça va',
  'Straße Ouverte', 'ﬁnance ﬂeur', 'İstanbul', 'ı dotless', 'ſtraat long-s', 'ǅungla', 'Øresund', 'Łódź', 'Œuvre', 'Ǎrbol', 'Đà Nẵng',
  "l'addition", 'Müller & Söhne', '€100 TVA 21%', '  spaces   and\ttabs  ', 'é', 'É', '', 'ＡＢＣ fullwidth', 'Åsa', 'Ñandú', 'ÿ', 'Ǆ',
];

control('NORMALISATION PARITY: the SQL twin key and the service twin key agree on every sample (no divergence between the two layers)', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    const mismatches = [];
    for (const s of SAMPLES) {
      const sql = (await c.query('select fin_bank_norm($1) v', [s])).rows[0].v;
      const js = movementKey({ date: '', amountCents: 0, currency: 'EUR', reference: s, counterpartyName: '' }).split('|')[3];
      if (sql !== js) mismatches.push(`${JSON.stringify(s)} sql=${JSON.stringify(sql)} js=${JSON.stringify(js)}`);
    }
    return { holds: mismatches.length === 0, evidence: mismatches.length === 0 ? `${SAMPLES.length} samples identical` : `${mismatches.length} divergence(s): ${mismatches.slice(0, 4).join(' | ')}` };
  } finally { await c.end(); await db.drop(); }
});
