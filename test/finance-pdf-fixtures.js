// Synthetic supplier PDFs for the phase 3 tests, generated at test time with pdfkit (no PDF file is committed).
// Every party, number, IBAN and communication is invented; IBANs and structured communications are COMPUTED with valid check digits.
import PDFDocument from 'pdfkit';

/** A valid IBAN for a country and BBAN (ISO 13616 check digits). */
export function makeIban(country, bban) {
  const digits = `${bban}${country}00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const check = String(98n - (BigInt(digits) % 97n)).padStart(2, '0');
  return `${country}${check}${bban}`;
}
/** A valid Belgian structured communication +++ddd/dddd/ddddd+++ from a 10-digit base (mod 97 check). */
export function makeStructured(base10) { const b = String(base10).padStart(10, '0'); const c = String(Number(b) % 97 || 97).padStart(2, '0'); const d = b + c; return `+++${d.slice(0, 3)}/${d.slice(3, 7)}/${d.slice(7)}+++`; }
export const spaced = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();

export const OWN = { name: 'Example Seller SRL', vat: 'BE0000000097', iban: 'BE68539007547034' }; // = the test merchant (finance-dashboard-helpers)
export const SUPPLIER_IBAN = makeIban('BE', '000000000101');
export const SUPPLIER_IBAN_2 = makeIban('BE', '000000000202');
export const NL_IBAN = makeIban('NL', 'ABNA0000000101');
export const COMM = makeStructured('0100000001');

/** Draw text items [x, y, text, size?] (y from the top of the page) on one or more pages. Images: { image: Buffer, x, y, w }. */
export function makePdf(pages, { title = 'synthetic' } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: title }, autoFirstPage: false });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (const items of pages) {
      doc.addPage({ size: 'A4', margin: 0 });
      for (const it of items) {
        if (it.image) { doc.image(it.image, it.x, it.y, { width: it.w }); continue; }
        const [x, y, text, size = 10] = it; doc.font('Helvetica').fontSize(size).text(text, x, y, { lineBreak: false });
      }
    }
    doc.end();
  });
}

// Common blocks: the supplier (left column) and the customer = the merchant (right column).
const supplierBlock = (name, street, city, vatLine) => [[50, 80, name, 12], [50, 96, street], [50, 110, city], [50, 124, vatLine]];
const customerBlock = [[330, 64, 'Client :'], [330, 80, OWN.name, 11], [330, 96, 'Rue Exemple 1'], [330, 110, '1000 Bruxelles'], [330, 124, `TVA ${OWN.vat}`]];
const ownBankLine = [50, 780, `Nos coordonnées bancaires (client) : ${spaced(OWN.iban)}`, 7];

export const CASES = {
  frSimple: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Imprimerie Exemple SRL', "Rue de l'Exemple 12", '5000 Namur', 'TVA BE 0000.000.196'), ...customerBlock,
    [50, 170, 'Facture n° F-2026-0101'], [50, 185, 'Date de facture : 10/09/2026'], [50, 200, 'Échéance : 10/10/2026'], [330, 170, 'Votre référence : BC-2026-44'],
    [50, 240, 'Description'], [300, 240, 'Qté'], [360, 240, 'Prix unitaire'], [460, 240, 'Total HTVA'],
    [50, 260, 'Gourde isotherme 500 ml'], [300, 260, '4'], [360, 260, '15,00'], [460, 260, '60,00'],
    [50, 278, 'Gravure laser'], [300, 278, '4'], [360, 278, '10,00'], [460, 278, '40,00'],
    [330, 320, 'Total HTVA'], [460, 320, '100,00 €'], [330, 336, 'TVA 21 % sur 100,00 €'], [460, 336, '21,00 €'], [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
    [50, 400, `À payer sur le compte IBAN ${spaced(SUPPLIER_IBAN)}`], [50, 414, `Communication : ${COMM}`], ownBankLine,
  ]]),
  nl: () => makePdf([[
    [50, 30, 'FACTUUR', 18], ...supplierBlock('Drukkerij Voorbeeld BV', 'Voorbeeldstraat 7', '2000 Antwerpen', 'BTW BE0000.000.295'), [50, 138, 'Ondernemingsnummer 0000.000.295'], ...customerBlock,
    [50, 170, 'Factuurnummer: 2026/055'], [50, 185, 'Factuurdatum: 12-09-2026'], [50, 200, 'Vervaldatum: 12-10-2026'], [330, 170, 'Bestelbon: PO-2026-9'],
    [50, 240, 'Omschrijving'], [300, 240, 'Aantal'], [360, 240, 'Prijs'], [460, 240, 'Bedrag'],
    [50, 260, 'Affiches A3'], [300, 260, '10'], [360, 260, '20,00'], [460, 260, '200,00'],
    [330, 320, 'Totaal excl. btw'], [460, 320, '200,00 EUR'], [330, 336, 'BTW 21% op 200,00'], [460, 336, '42,00 EUR'], [330, 352, 'Totaal incl. btw'], [460, 352, '242,00 EUR'],
    [50, 400, `IBAN ${spaced(SUPPLIER_IBAN)}`], [50, 414, `Mededeling: ${COMM}`],
  ]]),
  en: () => makePdf([[
    [50, 30, 'INVOICE', 18], ...supplierBlock('Example Supplies Ltd', '12 Example Road', '1050 Brussels', 'VAT BE0000000394'), ...customerBlock,
    [50, 170, 'Invoice number: INV-3001'], [50, 185, 'Invoice date: 15 September 2026'], [50, 200, 'Due date: 15 October 2026'], [330, 170, 'Your reference: ORD-77'],
    [50, 240, 'Description'], [300, 240, 'Qty'], [360, 240, 'Unit price'], [460, 240, 'Amount'],
    [50, 260, 'Printing services'], [300, 260, '1'], [360, 260, '1,000.00'], [460, 260, '1,000.00'],
    [330, 320, 'Subtotal'], [460, 320, '1,000.00'], [330, 336, 'VAT 21%'], [460, 336, '210.00'], [330, 352, 'Total'], [460, 352, '1,210.00'], [330, 368, 'Amount due EUR'], [460, 368, '1,210.00'],
    [50, 400, `Bank account IBAN ${SUPPLIER_IBAN}`],
  ]]),
  multiRate: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Librairie Exemple SA', 'Place Exemple 3', '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° LIB-88'], [50, 185, 'Date : 01/09/2026'],
    [330, 300, 'Taux'], [400, 300, 'Base HTVA'], [480, 300, 'TVA'],
    [330, 316, '6 %'], [400, 316, '100,00'], [480, 316, '6,00'], [330, 332, '21 %'], [400, 332, '200,00'], [480, 332, '42,00'],
    [330, 360, 'Total HTVA'], [460, 360, '300,00 €'], [330, 376, 'Total TVA'], [460, 376, '48,00 €'], [330, 392, 'Total TVAC'], [460, 392, '348,00 €'],
  ]]),
  noVat: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Consultant Exemple SRL', 'Avenue Exemple 9', '1300 Wavre', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° CE-2026-12'], [50, 185, 'Date de facture : 20/09/2026'],
    [330, 320, 'Total HTVA'], [460, 320, '500,00 €'], [330, 336, 'TVA 0 % sur 500,00 €'], [460, 336, '0,00 €'], [330, 352, 'Total TVAC'], [460, 352, '500,00 €'],
    [50, 400, 'Autoliquidation - article 21 § 2 du Code TVA'],
  ]]),
  creditNote: () => makePdf([[
    [50, 30, 'NOTE DE CRÉDIT', 18], ...supplierBlock('Imprimerie Exemple SRL', "Rue de l'Exemple 12", '5000 Namur', 'TVA BE 0000.000.196'), ...customerBlock,
    [50, 170, 'Note de crédit n° NC-2026-007'], [50, 185, 'Date : 18/09/2026'], [50, 200, 'Concerne la facture n° F-2026-0101'],
    [330, 320, 'Total HTVA'], [460, 320, '-20,00 €'], [330, 336, 'TVA 21 % sur -20,00 €'], [460, 336, '-4,20 €'], [330, 352, 'Total TVAC'], [460, 352, '-24,20 €'],
  ]]),
  manyDates: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Traiteur Exemple SRL', 'Rue Exemple 5', '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° TR-5'], [50, 185, 'Date de livraison : 05/09/2026'], [50, 200, 'Date de facture : 10/09/2026'], [50, 215, 'Période : du 01/08/2026 au 31/08/2026'], [50, 230, 'Échéance : 10/10/2026'],
    [330, 320, 'Total HTVA'], [460, 320, '100,00 €'], [330, 336, 'Total TVA'], [460, 336, '21,00 €'], [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
  ]]),
  unlabelledDates: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Traiteur Exemple SRL', 'Rue Exemple 5', '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° TR-6'], [50, 185, 'Namur, le 10/09/2026'], [50, 200, 'Imprimé le 12/09/2026'],
    [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
  ]]),
  manyAmounts: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Menuiserie Exemple SRL', 'Rue Exemple 8', '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° ME-31'], [50, 185, 'Date de facture : 11/09/2026'],
    [330, 320, 'Total HTVA'], [460, 320, '1.000,00 €'], [330, 336, 'TVA 21 %'], [460, 336, '210,00 €'], [330, 352, 'Total TVAC'], [460, 352, '1.210,00 €'],
    [330, 368, 'Acompte versé'], [460, 368, '500,00 €'], [330, 384, 'Solde à payer'], [460, 384, '710,00 €'], [50, 450, 'Garantie : 2.500,00 € (plafond)'],
  ]]),
  ambiguousTotals: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Atelier Exemple SRL', 'Rue Exemple 2', '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° AE-1'], [50, 185, 'Date de facture : 11/09/2026'], [330, 320, 'Total'], [460, 320, '50,00 €'], [330, 336, 'Total'], [460, 336, '80,00 €'],
  ]]),
  twoIbans: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Imprimerie Exemple SRL', "Rue de l'Exemple 12", '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° F-2026-0102'], [50, 185, 'Date de facture : 12/09/2026'], [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
    [50, 400, `IBAN ${spaced(SUPPLIER_IBAN)}`], [50, 414, `IBAN ${spaced(SUPPLIER_IBAN_2)}`], [50, 428, 'Communication : +++010/0000/00199+++'],
  ]]),
  incoherent: () => makePdf([[
    [50, 30, 'FACTURE', 18], ...supplierBlock('Imprimerie Exemple SRL', "Rue de l'Exemple 12", '5000 Namur', 'TVA BE0000000196'), ...customerBlock,
    [50, 170, 'Facture n° F-2026-0199'], [50, 185, 'Date de facture : 13/09/2026'],
    [330, 320, 'Total HTVA'], [460, 320, '100,00 €'], [330, 336, 'Total TVA'], [460, 336, '21,00 €'], [330, 352, 'Total TVAC'], [460, 352, '125,00 €'],
  ]]),
  twoPages: () => makePdf([
    [[50, 30, 'FACTURE', 18], ...supplierBlock('Imprimerie Exemple SRL', "Rue de l'Exemple 12", '5000 Namur', 'TVA BE0000000196'), ...customerBlock, [50, 170, 'Facture n° F-2026-0300'], [50, 185, 'Date de facture : 14/09/2026']],
    [[330, 100, 'Total HTVA'], [460, 100, '100,00 €'], [330, 116, 'Total TVA'], [460, 116, '21,00 €'], [330, 132, 'Total TVAC'], [460, 132, '121,00 €']],
  ]),
  nearlyEmpty: () => makePdf([[[50, 800, 'Scan 001', 6]]]),
  scanned: (png) => makePdf([[{ image: png, x: 40, y: 40, w: 500 }]]),
  prose: () => makePdf([[[50, 60, 'Merci pour votre visite. Nous vous souhaitons une excellente journée et à bientôt dans notre boutique de Namur.'], [50, 80, 'Conditions générales disponibles sur demande.']]]),
};
