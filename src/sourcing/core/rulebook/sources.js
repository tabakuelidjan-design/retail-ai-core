// Source records for the rulebook. `verification` says HOW the source was actually checked on `checkedAt` (2026-10-03):
//   OPENED_OFFICIAL         an official page (Commission / Belgian authority / marketplace) was opened and read
//   SECONDARY_OFFICIAL      an official publication that quotes the primary source (e.g. a European Parliament briefing citing the Commission database)
//   SEEN_IN_SEARCH_SNIPPET  an official page seen only as a search-result excerpt
//   NOT_OPENED_ELI          the primary legal text (EUR-Lex ELI link) was NOT opened in this session (the retrieval tool was blocked by EUR-Lex): confirm with the text
//   BACKGROUND_KNOWLEDGE    general knowledge, not backed by an opened page
//   PENDING_RESEARCH        a research item that had not returned when this record was written
// A rule whose weakest source is not OPENED_OFFICIAL is shown as PARTLY_VERIFIED / UNVERIFIED_EXPERT_CHECK_NEEDED. Nordla never presents these as verified legal fact.
export const CHECKED = '2026-10-03';
const mk = (verification) => (title, url, note = null) => ({ title, url, verification, checkedAt: CHECKED, ...(note ? { note } : {}) });
export const opened = mk('OPENED_OFFICIAL');
export const secondary = mk('SECONDARY_OFFICIAL');
export const snippet = mk('SEEN_IN_SEARCH_SNIPPET');
export const eli = mk('NOT_OPENED_ELI');
// Official Publications Office text of the ORIGINAL OJ version (the EUR-Lex pages themselves were blocked): read, but NOT checked for later consolidated amendments.
const ojText = (title, celex, note = '') => opened(title, `http://publications.europa.eu/resource/celex/${celex}`, `original OJ text read on the Publications Office; consolidated amendments not checked${note}`);
export const background = (title, note = null) => ({ title, url: null, verification: 'BACKGROUND_KNOWLEDGE', checkedAt: CHECKED, ...(note ? { note } : {}) });

export const SRC = Object.freeze({
  GPSR: ojText('Regulation (EU) 2023/988 (GPSR)', '32023R0988'),
  MSR: ojText('Regulation (EU) 2019/1020 (market surveillance), Art. 4', '32019R1020'),
  NLF: ojText('Decision 768/2008/EC (New Legislative Framework: DoC content, importer duties)', '32008D0768'),
  CE765: ojText('Regulation (EC) 765/2008, Art. 30 (CE marking)', '32008R0765'),
  LVD: ojText('Directive 2014/35/EU (Low Voltage)', '32014L0035'),
  EMC: ojText('Directive 2014/30/EU (EMC)', '32014L0030'),
  RED: ojText('Directive 2014/53/EU (Radio Equipment)', '32014L0053'),
  RED_CYBER: ojText('Delegated Regulation (EU) 2022/30 (RED cybersecurity; application 1 Aug 2025 per 2023/2444; repealed from 11 Dec 2027 by 2026/339)', '32022R0030'),
  ROHS_PAGE: opened('Commission: RoHS Directive', 'https://environment.ec.europa.eu/topics/waste-and-recycling/rohs-directive_en'),
  ROHS: ojText('Directive 2011/65/EU (RoHS) with Delegated Directive (EU) 2015/863', '32011L0065'),
  REACH_PAGE: opened('Commission: REACH explained', 'https://single-market-economy.ec.europa.eu/sectors/chemicals/reach/reach-explained_en'),
  REACH: eli('Regulation (EC) 1907/2006 (REACH)', 'https://eur-lex.europa.eu/eli/reg/2006/1907/oj'),
  BATT_PAGE: opened('Commission: Batteries', 'https://environment.ec.europa.eu/topics/waste-and-recycling/batteries_en'),
  BATT_FAQ: opened('Commission: Digital Product Passport - Batteries FAQ (importer responsibility for imported batteries)', 'https://single-market-economy.ec.europa.eu/single-market/digital-product-passport/eu-digital-product-passport-faq-batteries_en'),
  BATT: eli('Regulation (EU) 2023/1542 (Batteries)', 'https://eur-lex.europa.eu/eli/reg/2023/1542/oj'),
  BATT_BE: opened('FPS Health: Batteries (Belgium)', 'https://www.health.belgium.be/en/professionals/enterprises/environment/resource-management-circular-economy/batteries'),
  UN383: snippet('UN Manual of Tests and Criteria, Section 38.3 (lithium batteries for transport)', 'https://unece.org/fileadmin/DAM/trans/danger/publi/manual/Manual%20Rev5%20Section%2038-3.pdf'),
  WEEE_PAGE: opened('Commission: WEEE', 'https://environment.ec.europa.eu/topics/waste-and-recycling/waste-electrical-and-electronic-equipment-weee_en'),
  WEEE_FAQ: opened('Commission: WEEE FAQ', 'https://ec.europa.eu/environment/pdf/waste/weee/faq.pdf'),
  PACK_PAGE: opened('Commission: Packaging waste (PPWR applies from 12 Aug 2026)', 'https://environment.ec.europa.eu/topics/waste-and-recycling/packaging-waste_en'),
  PACK_NEWS: opened('Commission: new packaging rules enter into application', 'https://environment.ec.europa.eu/news/new-eu-rules-packaging-enter-application-2026-08-11_en'),
  PPWR: eli('Regulation (EU) 2025/40 (PPWR)', 'https://eur-lex.europa.eu/eli/reg/2025/40/oj'),
  FCM_PAGE: opened('Commission: Food contact materials', 'https://food.ec.europa.eu/safety/chemical-safety/food-contact-materials_en'),
  FCM_LEG: opened('Commission: FCM legislation list', 'https://food.ec.europa.eu/safety/chemical-safety/food-contact-materials/legislation_en'),
  FCM_BPA: snippet('Regulation (EU) 2024/3190 (bisphenols in food contact materials)', 'https://eur-lex.europa.eu/eli/reg/2024/3190/oj'),
  FCM_BE: opened('FASFC: food-contact materials (declaration of compliance mandatory)', 'https://favv-afsca.be/fr/themes/alimentation/produire-et-vendre-des-aliments/materiaux-de-contact'),
  TEXT_FAQ: opened('Commission: FAQ on Regulation (EU) 1007/2011 (textile fibre labelling)', 'https://single-market-economy.ec.europa.eu/document/download/34fcf863-59ef-4352-8489-a2577102fd8f_en'),
  COSM_PAGE: opened('Commission: Cosmetics legislation (responsible person, CPNP, safety report)', 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/legislation_en'),
  PPE_PAGE: opened('Commission: Personal protective equipment', 'https://single-market-economy.ec.europa.eu/sectors/mechanical-engineering/personal-protective-equipment-ppe_en'),
  CLP: snippet('Regulation (EC) 1272/2008 (CLP)', 'https://single-market-economy.ec.europa.eu/sectors/chemicals/classification-and-labelling-clpghs_en'),
  TOYS_BE: opened('FPS Economy: toy safety (Directive 2009/48/EC; Regulation (EU) 2025/2509 from 1 Aug 2030)', 'https://economie.fgov.be/en/themes/quality-and-safety/toys-and-childrens-articles/safety-toys'),
  TOYS: ojText('Directive 2009/48/EC (Toy Safety; repealed 1 Aug 2030)', '32009L0048'),
  BE_GENERAL: opened('FPS Economy: general regulations on product safety (GPSR applied directly; Safety Business Gateway)', 'https://economie.fgov.be/en/general-regulations-safety'),
  BE_ELECTRICAL: opened('FPS Economy: safety of electrical appliances', 'https://economie.fgov.be/en/themes/quality-and-safety/safety-products-and-services/specific-regulations/electrical-products/safety-electrical-appliances'),
  BE_BIPT: opened('BIPT: obligations of economic operators (radio equipment; FR+NL+DE instructions)', 'https://www.bipt.be/operators/obligations-of-economic-operators'),
  BE_LANG: opened('ConsumerConnect (FPS Economy): language of labels and instructions', 'https://consumerconnect.be/fr/themes/achat-produit-ou-service/manuelle/etiquetage-et-mode-demploi/langue'),
  BE_RECUPEL: opened('Recupel: legal obligations (registration, online sellers, visible contribution)', 'https://www.recupel.be/en/place-appliances-market/legal-obligations'),
  BE_RECUPEL_RETAIL: opened('Recupel: what a retailer or distributor must know', 'https://www.recupel.be/en/what-do-you-need-know-retailer-or-distributor'),
  BE_BEBAT: opened('Bebat: join / producer obligations', 'https://www.bebat.be/en/producing-importing/join-bebat'),
  BE_FOSTPLUS: opened('Fost Plus: become a member (household packaging)', 'https://www.fostplus.be/en/members/become-a-fost-plus-member'),
  BE_VALIPAC: opened('Valipac: industrial packaging', 'https://www.valipac.be/en/industrial-packaging/'),
  EORI: opened('Commission: EORI (economic operators registration and identification)', 'https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/economic-operators-registration-and-identification-eori_en'),
  LOW_VALUE: opened('Commission: customs formalities for low-value consignments', 'https://taxation-customs.ec.europa.eu/customs/customs-procedures-import-and-export/customs-operations/customs-formalities-low-value-consignments_en'),
  BE_VAT: opened('FPS Finance: Belgian VAT rates (21 / 12 / 6 / 0 %)', 'https://finances.belgium.be/fr/node/12036'),
  VAT_EP: secondary('European Parliament briefing EPRS(2026)782613 quoting the Commission Taxes in Europe Database (standard rates BE 21, FR 20, DE 19, NL 21; TEDB update of 1 July 2025)', 'https://www.europarl.europa.eu/RegData/etudes/BRIE/2026/782613/EPRS_BRI(2026)782613_EN.pdf'),
  AMAZON_GPSR: opened('Amazon (Europe sellers): GPSR - EU Responsible Person, manufacturer / importer details, safety information', 'https://go.amazonsellerservices.com/gpsr20241-en'),
  AMAZON_COMPLIANCE: opened('Amazon.es seller compliance: regulated product areas and EU responsible person statement', 'https://sell.amazon.es/en/soluciones-cumplimiento/producto'),
  AMAZON_FBA_RATES: opened('Amazon Europe FBA Rate Card effective 1 July 2026 (referral, fulfilment, storage; dangerous-goods surcharge)', 'https://m.media-amazon.com/images/G/02/sell/images/260630-FBA-Rate-Card-EN1.pdf'),
  SAFETY_GATE: opened('EU Safety Gate: weekly report XML (index and detail)', 'https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en'),
  TARIC: opened('Commission: EU Customs Tariff (TARIC) - daily publications', 'https://ec.europa.eu/taxation_customs/dds2/taric/daily_publications.jsp'),
  EBTI: opened('Commission: EBTI (binding tariff information)', 'https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/european-binding-tariff-information-ebti_en'),
  GPSR_GUIDE: ojText('Commission Notice C/2025/6233: GPSR guidelines for businesses', '52025XC06233'),
  BLUE_GUIDE: ojText('Commission Blue Guide on EU product rules 2022 (OJ C 247, 29.6.2022)', '52022XC0629(04)'),
  CHARGER: ojText('Directive (EU) 2022/2380 (common charger, USB Type-C)', '32022L2380'),
  TOYS_REG: ojText('Regulation (EU) 2025/2509 (Toy Safety Regulation; applies from 1 Aug 2030)', '32025R2509'),
  PPE_REG: ojText('Regulation (EU) 2016/425 (PPE)', '32016R0425'),
  MACHINERY: ojText('Regulation (EU) 2023/1230 (Machinery; applies from 14 Jan 2027)', '32023R1230'),
  ESPR: ojText('Regulation (EU) 2024/1781 (ESPR; Art. 25 destruction ban for apparel/footwear from 19 Jul 2026)', '32024R1781'),
  CE_PAGE: opened('Commission: CE marking (not a safety approval; forbidden where no harmonisation act provides for it)', 'https://single-market-economy.ec.europa.eu/single-market/ce-marking_en'),
  CRA_NEWS: opened('Commission news on the Cyber Resilience Act (reporting from 11 Sep 2026, main obligations 11 Dec 2027); the CRA text itself was not opened', 'https://commission.europa.eu/news-and-media/news/safer-and-more-secure-digital-products-2026-09-11_en'),
});
