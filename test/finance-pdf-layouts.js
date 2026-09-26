// Synthetic PDFs reproducing, layout for layout, the real supplier documents on which PDF_TEXT failed (validation 224213b).
// Only the LAYOUT is copied: every party, number, IBAN and amount is invented. Generated at test time (no PDF is committed).
// Foreign VAT numbers are assembled at run time so that no IBAN-like literal appears in the source (privacy scan).
import { COMM, SUPPLIER_IBAN, makePdf } from './finance-pdf-fixtures.js';

export const OWN_NAME = 'Example Seller SRL';
export const LU_VAT = 'LU' + '12345678';
export const FR_VAT = 'FR' + 'AB123456789';
export const IE_VAT = 'IE' + '1234567T';
export const NL_VAT = 'NL' + '000000000B01';

const own = (x, y) => [[x, y, OWN_NAME], [x, y + 14, 'Rue Exemple 1'], [x, y + 28, '1000 Bruxelles'], [x, y + 56, 'Btw: BE0000000097']];

/** Amazon-like page: label | value columns, "Verkocht door" block with labels ABOVE values, 2-line item header, 2-line VAT table. */
const amazonPage = ({ lang = 'nl', number, total, net, vat, order }) => (lang === 'nl' ? [
  [516, 20, 'Factuur', 14], [342, 60, 'Betaald'], [300, 74, 'Verkocht door Exemple Retail S.à r.l., Belgisch bijkantoor'], [342, 88, `Btw-nummer ${LU_VAT}`],
  [344, 120, 'Factuurdatum'], [470, 120, '31-05-2026'], [344, 134, 'Factuurnummer'], [470, 134, number], [344, 148, 'Totaal te betalen'], [470, 148, total],
  [35, 190, 'Factuuradres'], [200, 190, 'Bezorgadres'], [386, 190, 'Verkocht door'],
  [35, 204, OWN_NAME], [200, 204, OWN_NAME], [386, 204, 'Exemple Retail S.à r.l., Belgisch bijkantoor'],
  [35, 218, 'Rue Exemple 1'], [200, 218, 'Rue Exemple 1'], [386, 218, 'Kunstlaan 27'],
  [35, 232, 'Bruxelles, 1000'], [200, 232, 'Bruxelles, 1000'], [386, 232, 'Brussel, 1040'], [35, 246, 'BE'], [200, 246, 'BE'], [386, 246, 'België'],
  [35, 280, 'Besteldatum'], [150, 280, '30-05-2026'], [35, 294, 'Bestelnummer'], [150, 294, order],
  [38, 330, 'Beschrijving'], [260, 330, 'Aantal'], [300, 330, 'Prijs per eenheid'], [380, 330, 'Btw-tarief'], [440, 330, 'Subtotaal item'], [300, 342, '(excl. btw)'], [440, 342, '(incl. btw)'],
  [38, 360, 'Moniteur Exemple 24 pouces'], [260, 360, '1'], [300, 360, net], [380, 360, '21 %'], [440, 360, total], [38, 374, 'Verzendkosten'], [300, 374, '0,00 €'], [440, 374, '0,00 €'],
  [298, 400, 'Totaal factuur'], [440, 400, total],
  [341, 430, 'Btw-tarief'], [400, 430, 'Subtotaal item'], [470, 430, 'Subtotaal btw'], [400, 442, '(excl. btw)'],
  [356, 460, '21 %'], [400, 460, net], [470, 460, vat], [301, 478, 'Totaal'], [400, 478, net], [470, 478, vat],
  [28, 760, 'Exemple Retail S.à r.l. - 38 avenue Exemple, L-1855 Luxembourg - Régime TVA LUXEMBOURGEOISE', 6],
  [28, 770, 'Bijkantoor Kunstlaan 27, Brussel, 1040, België • 0000.000.196 RPR Brussel', 6], [28, 780, `• IBAN ${SUPPLIER_IBAN} – BIC EXEMBEBB`, 6],
] : [
  [514, 20, 'Facture', 14], [330, 34, `Numéro de la facture ${number}`], [300, 74, 'Vendu par Exemple Retail S.à r.l., Succursale Belge'], [342, 88, `TVA ${LU_VAT}`],
  [250, 120, 'Date de la facture/Date de la livraison'], [470, 120, '31-05-2026'], [344, 134, 'Numéro de la facture'], [470, 134, number], [344, 148, 'Total à payer'], [470, 148, total],
  [35, 280, 'Date de la commande'], [150, 280, '30-05-2026'], [35, 294, 'Numéro de la commande'], [150, 294, order],
  [298, 400, 'Facture Total'], [440, 400, total], [373, 430, 'Taux TVA'], [420, 430, 'Total'], [470, 430, 'TVA'], [420, 442, '(HT)'],
  [389, 460, '21 %'], [420, 460, net], [470, 460, vat], [301, 478, 'Total'], [420, 478, net], [470, 478, vat],
]);

export const LAYOUTS = {
  /** X-Forwarding: date labels ABOVE their values, "BTW Import" as an invoice line, "Totaal" in the middle of a line, VAT number in the footer. */
  labelsAbove: () => makePdf([[
    [26, 40, 'BV Exemple-Transit', 12], [26, 56, 'Rootputstraat 31'], [26, 70, '9100 Sint-Niklaas'], [26, 84, 'België'], ...own(343, 120),
    [26, 220, 'Factuur INV/2026/00013', 14], [26, 245, 'Factuurdatum'], [200, 245, 'Vervaldatum'], [26, 262, '30-12-2025'], [200, 262, '14-01-2026'],
    [26, 300, 'Omschrijving'], [220, 300, 'Aantal'], [300, 300, 'Eenheidsprijs'], [400, 300, 'Btw'], [470, 300, 'Bedrag'],
    [36, 325, 'Import document'], [220, 325, '1,00'], [300, 325, '85,00'], [400, 325, '21%'], [470, 325, '85,00 €'],
    [26, 337, 'IM: 25BEH00000EXEMPLE dd. 29/12/2025'], [470, 337, '85,00 €'],
    [36, 350, 'Expeditie service'], [220, 350, '1,00'], [300, 350, '75,00'], [400, 350, '21%'], [470, 350, '75,00 €'],
    [36, 375, 'A00: Invoerrechten'], [220, 375, '1,00'], [300, 375, '0,38'], [470, 375, '0,38 €'],
    [36, 400, 'B00 : BTW Import'], [220, 400, '1,00'], [300, 400, '1.788,76'], [470, 400, '1.788,76 €'],
    [26, 450, `Mededeling betaling: ${COMM}`], [343, 450, 'Excl. btw'], [470, 450, '1.949,14 €'], [343, 470, 'BTW 21% op 160,00 €'], [470, 470, '33,60 €'],
    [118, 495, 'je bankapplicatie'], [343, 495, 'Totaal'], [470, 495, '1.982,74 €'], [26, 520, `op deze rekening: ${SUPPLIER_IBAN}`],
    [26, 780, 'info@exemple-transit.example - BE0000000196', 8],
  ]]),
  /** AILY: a PRO FORMA, whose number cell also says "INVOICE". */
  proforma: () => makePdf([[
    [247, 30, 'EXEMPLE GROUP', 14], [249, 46, 'Proforma Invoice', 12],
    [51, 70, 'SELLER:'], [134, 70, 'HANGZHOU EXEMPLE PRINTING TECHNOLOGY CO.,LTD'], [440, 70, 'INVOICE'], [500, 70, 'PF2503111'],
    [51, 86, 'BUYER:'], [134, 86, `Name - ${OWN_NAME}`], [440, 86, 'DATE:'], [480, 86, 'September 24, 2025'],
    [134, 200, 'UV printer'], [300, 200, '1'], [380, 200, '$9,000.00'], [460, 200, '$9,000.00'], [166, 300, 'TOTAL'], [460, 300, '$9,000.00'],
  ]]),
  /** Amazon: the same invoice in NL (p1) and FR (p2). */
  bilingual: () => makePdf([amazonPage({ number: 'LU62EXEMPLE01', total: '69,90 €', net: '57,77 €', vat: '12,13 €', order: '406-2146550-3713107' }),
    amazonPage({ lang: 'fr', number: 'LU62EXEMPLE01', total: '69,90 €', net: '57,77 €', vat: '12,13 €', order: '406-2146550-3713107' })]),
  /** Amazon: TWO different invoices in one PDF. */
  twoInvoices: () => makePdf([amazonPage({ number: 'BE66EXEMPLE01', total: '40,47 €', net: '33,45 €', vat: '7,02 €', order: '406-1740119-2061933' }),
    amazonPage({ number: 'BE66EXEMPLE02', total: '13,99 €', net: '11,56 €', vat: '2,43 €', order: '406-1740119-2061933' })]),
  /** CMA CGM: number under the "INVOICE" title, 26-MAR-2026 dates, "Account Number", "Total Excluding Tax", a sentence with "VAT" left of a total. */
  shipping: () => makePdf([[
    [21, 20, 'EXEMPLE - LINES', 10], [21, 30, 'BOULEVARD EXEMPLE'], [21, 40, "4 QUAI D'EXEMPLE"], [21, 50, '13235..MARSEILLE'], [21, 60, 'FRANCE'], [21, 70, `VAT NO. ${FR_VAT}`],
    [299, 90, 'INVOICE'], [360, 90, 'ORIGINAL'], [299, 100, 'EXDIC236019'], [24, 112, 'Your Ref:'], [150, 112, 'Date: 26-MAR-2026'],
    [298, 125, 'Invoice To:'], [368, 125, OWN_NAME], [298, 160, 'VAT NO.: BE0000000097'], [24, 175, 'Voyage: 0FMLTE1MA'], [300, 175, 'Call Date: 02 APR 2026'],
    [24, 190, 'Commodity Code'], [100, 190, 'Description'], [300, 190, 'Package'], [360, 190, 'Qty'], [25, 202, '961700'], [100, 202, 'Vacuum flasks'], [300, 202, '20ST'], [360, 202, '1'],
    [23, 220, 'Size/Type'], [80, 220, 'Charge Description'], [260, 220, 'Tax'], [300, 220, 'Based on'], [360, 220, 'Rate Currency'], [430, 220, 'Amount'], [490, 220, 'Amount in EUR'],
    [26, 232, '20ST C'], [80, 232, 'Terminal Handling Charge'], [260, 232, 'C2'], [300, 232, '1 UNI'], [360, 232, '250.00 EUR'], [430, 232, '250.00'], [490, 232, '250.00'],
    [80, 241, 'at destination'],
    [26, 252, '20ST C'], [80, 252, 'Documentation Fee'], [260, 252, 'C2'], [300, 252, '1 FIX'], [360, 252, '50.00 EUR'], [430, 252, '50.00'], [490, 252, '50.00'],
    [404, 270, 'Currency Charge Totals'], [385, 282, 'EUR'], [490, 282, '300.00'],
    [26, 295, 'VAT applied as indicated on charges'], [300, 295, 'Total Excluding Tax'], [490, 295, '300.00'], [27, 307, 'C2 Auto Liquidation - VAT due by the client'],
    [380, 325, 'Total VAT'], [490, 325, '0.00'], [380, 337, 'Total Including Tax'], [490, 337, '300.00'],
    [23, 600, `IBAN: ${SUPPLIER_IBAN} (EUR) SWIFT: EXEMBEBB`], [300, 600, 'Total Amount:'], [490, 600, '300.00 EUR'],
    [23, 612, 'BENEFICIARY: EXEMPLE SECURITIES BV'], [300, 612, 'Payable by 02-APR-2026'], [23, 650, 'Account Number.7367298 (EUR)'],
  ]]),
  /** Shopify: "Bill #", "Paid on Jan 12, 2026", Irish "Limited" and Eircode. */
  bill: () => makePdf([[
    [40, 20, 'Bill #472742124'], [220, 20, 'Domain registration'], [40, 33, 'Paid on Jan 12, 2026'], [220, 33, 'Domain registration for exemple.example'],
    [440, 60, 'Exemple International Limited'], [440, 71, '2nd Floor, 1-2 Exemple Buildings'], [440, 82, 'Haddington Road'], [440, 93, 'Dublin 4, D04 XN32, Ireland'], [440, 104, `VAT ${IE_VAT}`],
    [43, 160, 'TOTAL DUE'], [43, 184, '€14.85 EUR'], [189, 210, '* As recipient you are liable to account for reverse charge VAT'],
    [298, 300, 'Subtotal'], [400, 300, '€14.85 EUR'], [298, 314, 'VAT 0.0%*'], [400, 314, '€0.00 EUR'], [298, 335, 'Total'], [400, 335, '€14.85 EUR'],
  ]]),
  /** Shopify Hardware: "Receipt / Tax Invoice", item rows on 2-3 lines, "Thank you" line above the footer company, VAT in the footer. */
  receipt: () => makePdf([[
    [62, 20, 'EXEMPLE HARDWARE'], [389, 37, 'Receipt / Tax Invoice 264828-HWS'], [421, 50, '2026-05-29 09:33:53 -0400'],
    [62, 90, 'CUSTOMER'], [62, 104, OWN_NAME], [225, 190, 'VAT Number: BE 0000000097'],
    [117, 250, 'ITEMS'], [357, 250, 'PRICE'], [430, 250, 'QTY'], [480, 250, 'ITEM TOTAL'],
    [117, 270, 'Cash Drawer 16"'], [117, 283, 'Black'], [357, 283, '€99,00'], [430, 283, '1'], [480, 283, '€99,00'], [117, 296, 'SKU: 37969490'],
    [117, 320, 'Tablet Stand'], [357, 333, '€119,00'], [430, 333, '1'], [480, 333, '€119,00'],
    [429, 380, 'Subtotal'], [480, 380, '€218,00'], [430, 398, 'PL VAT -'], [524, 405, '€0,00'], [402, 412, 'POLAND 0.0%'], [409, 430, 'TOTAL (EUR)'], [480, 430, '€218,00'], [422, 448, 'Total paid'], [480, 448, '€218,00'],
    [155, 700, 'As the recipient you are liable to account for reverse charge VAT'], [231, 725, 'Thank you for shopping with us!'], [229, 749, 'Exemple International Limited'],
    [170, 763, '1-2 Exemple Buildings, Haddington Road D04 XN32, Dublin'], [254, 777, `VAT No: ${IE_VAT}`],
  ]]),
  /** Booking.com: a booking CONFIRMATION (not an invoice), a street number, an estimate, a print date. */
  booking: () => makePdf([[
    [421, 20, 'Confirmation de réservation', 12], [300, 34, 'NUMÉRO DE CONFIRMATION : 4894.780.823'], [44, 80, 'Heefun Exemple Apartment'], [44, 92, 'Brand New Exemple Plaza, No. 307 Exemple Avenue,'],
    [44, 160, '1 hébergement'], [300, 160, '€ 860'], [44, 172, 'Tarif'], [300, 172, 'environ € 860'], [470, 184, 'CNY 6 669,69'],
    [44, 220, 'Le montant affiché en EUR est seulement une estimation.'], [470, 800, '7/7/2026, 3:10 PM', 6],
  ]]),
  /** Chinese commercial invoice: "CO.,LIMITED", "DATE:2026/02/13", empty "Invoice NO.:", bank address "NO.158", RMB and USD. */
  china: () => makePdf([[
    [118, 20, 'ZHEJIANG EXEMPLE TRADE CO.,LIMITED', 12], [299, 40, 'INVOICE', 14], [36, 60, 'Street: Rue Exemple 1'], [300, 60, 'Invoice NO.:'],
    [36, 72, 'city : Bruxelles'], [300, 84, 'DATE:2026/02/13'], [36, 96, 'VAT: BE0000 000 097'],
    [36, 120, 'ITEM NO'], [100, 120, 'description'], [250, 120, 'PRICE'], [320, 120, 'PCS'], [400, 120, 'AMOUNT'],
    [36, 135, 'TA001'], [100, 135, 'C-C cable 2M'], [250, 135, '¥3.20'], [320, 135, '200'], [400, 135, '¥640.00'],
    [312, 300, 'RMB TOTAL:'], [400, 300, 'RMB'], [460, 300, '¥640.00'], [190, 330, 'USD TOTAL:'], [400, 330, 'USD'], [460, 330, '$91.43'],
    [36, 420, 'BANK ADDRESS: NO.158 EXEMPLE ROAD YIWU CITY'], [36, 432, 'BENEFICIARY: ZHEJIANG EXEMPLE TRADE CO.,LIMITED'],
  ]]),
  /** Trip.com: an e-receipt (not an invoice), "PTE. LTD." in capitals, "Aug 30, 2025", "EUR582.28" glued to its currency. */
  travelReceipt: () => makePdf([[
    [45, 20, 'TRIP.EXEMPLE TRAVEL SINGAPORE PTE. LTD.'], [45, 29, 'Company No/GST Reg. No: 201613701E'], [45, 43, 'Booking No. 1185315927488530'], [45, 52, 'Payment date Aug 30, 2025 (UTC+8)'],
    [278, 80, 'E-receipt', 12], [51, 230, 'Total amount'], [300, 230, 'EUR597.28'], [51, 243, 'Discount'], [300, 243, '-EUR15'], [291, 258, 'Total paid (Bancontact)'], [420, 258, 'EUR582.28'],
  ]]),
  /** Back Market: seller + address on ONE line with bullets, prices incl. VAT ("Sous-total" is VAT included), item on 2 lines, platform VAT in the footer. */
  marketplace: () => makePdf([[
    [97, 20, 'Exemple Trading B.V. • Exempelstraat 25-E • 7512HL Enschede • The Netherlands', 8], [369, 50, OWN_NAME], [43, 140, 'Facture', 14],
    [43, 170, 'Numéro de facture:'], [150, 170, '80184653'], [43, 185, 'Date de facture:'], [150, 185, '30-04-2026'],
    [57, 215, 'Description'], [300, 215, 'Remise'], [450, 215, 'Total'], [40, 235, '1 iPad Pro 12.9" 512 Go'], [300, 243, '€ 0.00'], [450, 243, '€ 650.00'],
    [397, 500, 'TVA (21% incl.)'], [470, 500, '€ 112.81'], [397, 520, 'Sous-total'], [470, 520, '€ 650.00'], [397, 540, 'Remise'], [470, 540, '€ 0.00'], [397, 560, 'Montant total'], [470, 560, '€ 650.00'],
    [164, 700, `Exemple Market • KvK: 93428855 • N° TVA: ${NL_VAT}`],
  ]]),
  /** FPS: "Invoice Date | : 19-12-2025", ETS / ETA dates, line descriptions that contain amounts, USD in a conversion line. */
  forwarder: () => makePdf([[
    [363, 40, 'INVOICE', 12], [363, 52, 'Invoice Number'], [430, 52, ': 25100231'], [363, 62, 'Invoice Date'], [430, 62, ': 19-12-2025'],
    [363, 72, 'File Number'], [430, 72, ': 125104485-04'], [363, 82, 'Debtor Number'], [430, 82, ': 107182'], [59, 60, OWN_NAME],
    [17, 150, 'E.T.S.'], [80, 150, '17-10-2025'], [17, 160, 'E.T.A.'], [80, 160, '17-12-2025'], [17, 200, 'Description'], [480, 200, 'Amount'],
    [17, 215, 'UNLOADING / RELOADING COST 2,690 CBM X 45,00'], [430, 215, 'EUR'], [480, 215, '121.05'], [17, 230, 'LOCAL IMPORT CHARGES USD 180,23 X 0,869'], [430, 230, 'EUR'], [480, 230, '156.62'],
    [17, 320, 'PAYMENT UPFRONT'], [380, 320, 'VAT Total'], [480, 320, '0.00'], [17, 334, 'VAT zero-rated or VAT exempt supply of services, according to art. 144'], [380, 334, 'Total incl. VAT EUR'], [470, 334, 'EUR 277.67'],
  ]]),
};
