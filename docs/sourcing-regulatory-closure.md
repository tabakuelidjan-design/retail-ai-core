# China sourcing V0 - regulatory closure (2026-10-03)

Generated from `src/sourcing/core/rulebook/review.js`; do not edit by hand. Nothing here adds a rule: it verifies and hardens the 31 existing rules.

## Method and limits

- **EU acts**: the CONSOLIDATED text of each act was read from the Publications Office (consolidated CELEX 0YYYY...), and the list of amending acts and corrigenda of each act was read from its SPARQL endpoint. A rule is VERIFIED_CURRENT only if the current consolidated text matches every claim, the application dates cited were read in the text, and no amending act and no corrigendum is dated after the consolidation date. Corrigenda are not retrievable as text through this route, so any corrigendum dated after a consolidation keeps a rule at PRIMARY_TEXT_ONLY.
- **Belgium**: the federal Code de droit economique (Art. VI.8) from Justel; Wallonia from Wallex; Flanders from OVAM; Brussels Environment, FPS Economy, BIPT and FASFC authority pages. The Flemish VLAREMA and Brussels legal texts, the Royal Decree of 2016-03-25 and the packaging agreements were not read.
- **Amazon**: only Amazon's public seller pages and an official Amazon announcement were readable; Seller Central Help is login-walled.
- **UN 38.3**: the UNECE site refused the automated request (HTTP 403).
- **Not legal advice**: Nordla is decision support. VERIFIED_CURRENT means "the encoded claim matches the current consolidated text as of the check date", never "your product complies".

## Counts

| Status | Before | After |
|---|---|---|
| VERIFIED_CURRENT | 0 | 13 |
| PRIMARY_TEXT_ONLY | 13 | 12 |
| NEEDS_EXPERT_REVIEW | 6 | 1 |
| INCOMPLETE | 2 | 2 |
| UNVERIFIED | 10 | 3 |

## Per rule

### eu.gpsr - General Product Safety Regulation (EU) 2023/988

- **Status:** VERIFIED_CURRENT (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - General Product Safety Regulation (EU) 2023/988, consolidated with Reg. (EU) 2024/2748 - consolidated version: 2026-05-29 - articles: Art. 2(1) (harmonised products: Chapter II partly, Chapter IIa, Chapter III Section 1 (Arts 9-18), Chapters V, VII, IX-XI do not apply), Art. 11, 13(1)-(3), 16, 19, 22, 52 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02023R0988-20260529)
- **Application dates:** applies from 2024-12-13 (Art. 52)
- **Nordla interpretation:** Consumer products: GPSR applies in full to non-harmonised products; for CE-harmonised products Arts 9-18 (manufacturer, importer, own-brand = manufacturer Art. 13, responsible person Art. 16) do NOT apply (the sector law and Reg. 2019/1020 Art. 4 do) while Art. 19 (distance sales information), 20, 21 and 22 (marketplaces) still do. Own name or trademark = manufacturer (Art. 13(1)); substantial modification with an impact on safety = manufacturer (Art. 13(2)-(3)).
- **Remaining uncertainty:** Which risks a sector act "covers" for a given harmonised product (residual GPSR scope) is product-specific.

### eu.nlf_operator - Economic operator duties for harmonised products (Reg. 2019/1020 Art. 4; Decision 768/2008)

- **Status:** VERIFIED_CURRENT (before: NEEDS_EXPERT_REVIEW) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Regulation (EU) 2019/1020 (market surveillance), consolidated 2026-08-12 - consolidated version: 2026-08-12 - articles: Art. 4(1)-(5) (EU economic operator; current list in Art. 4(5) includes Directives 2009/48, 2011/65, 2014/30, 2014/35, 2014/53 and Regulations 2016/425, 2023/1542, 2024/1252), Art. 4(4), Art. 6, Art. 44 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02019R1020-20260812)
  - Own name / trade mark = manufacturer: EMC Directive Art. 11 (consolidated 2026-05-30) - consolidated version: 2026-05-30 - articles: Art. 11: an importer or distributor is a manufacturer when it places apparatus on the market under its name or trade mark or modifies it so that compliance may be affected (the same wording is in LVD Art. 10, not counted here: a LVD corrigendum is dated after its consolidation) - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02014L0030-20260530)
  - Own name / trade mark = manufacturer: RED Art. 14 (consolidated 2026-05-30) - consolidated version: 2026-05-30 - articles: Art. 14 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02014L0053-20260530)
  - Own name / trade mark = manufacturer: PPE Regulation Art. 12 (consolidated 2026-05-29) - consolidated version: 2026-05-29 - articles: Art. 12 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02016R0425-20260529)
  - Own name / trade mark = manufacturer: Toy Safety Directive Art. 8 (consolidated 2026-08-29) - consolidated version: 2026-08-29 - articles: Art. 8 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02009L0048-20260829)
  - Own name / trade mark = manufacturer: RoHS Directive manufacturer definition (consolidated 2026-07-01) - consolidated version: 2026-07-01 - articles: Art. 3: a person who has EEE designed or manufactured and markets it under its name or trademark - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02011L0065-20260701)
  - Own name / trade mark = manufacturer: Batteries Regulation (consolidated 2026-08-13) - consolidated version: 2026-08-13 - articles: importers and distributors treated as manufacturers when the battery is placed on the market under their own name or trademark or modified - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02023R1542-20260813)
- **Application dates:** applies from 2021-07-16 (Art. 44)
- **Nordla interpretation:** A harmonised product may be placed on the market only if an EU-established operator (EU manufacturer, else importer, else authorised representative with a written mandate, else fulfilment service provider) performs the Art. 4(3) tasks; its name and contact details go on the product, packaging, parcel or document. 10-year retention comes from each sector act.
- **Pending change:** A "European product act" reviewing 765/2008, 768/2008 and 2019/1020 is announced; no adopted text exists in the Publications Office metadata on the check date. An expert must re-check importer / private-label duties when it is adopted.
- **Remaining uncertainty:** Decision 768/2008 (reference provisions) was not read directly: the sector acts that apply them were.

### eu.ce - CE marking

- **Status:** VERIFIED_CURRENT (before: NEEDS_EXPERT_REVIEW) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Regulation (EC) 765/2008, consolidated 2021-07-16 - consolidated version: 2021-07-16 - articles: Art. 30(1)-(6) - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02008R0765-20210716)
  - Regulation (EU) 2019/1020 Art. 4(5) (list of acts requiring an EU operator, incl. Batteries Reg. 2023/1542) - consolidated version: 2026-08-12 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02019R1020-20260812)
- **Application dates:** Art. 30 in force (applies from 2010-01-01 per the Regulation)
- **Nordla interpretation:** CE marking is affixed only by the manufacturer or its authorised representative, only to products for which a harmonisation act provides for it, and never to any other product. It is the only marking attesting conformity; misleading marks are prohibited. Nordla treats electrical / electronic, radio, toy, PPE and battery products as CE-regime candidates; textiles, cosmetics, food-contact and most household goods are not.
- **Remaining uncertainty:** There is no official list of products without CE marking: Nordla only models the regimes it encodes (electrical, radio, toys, PPE, batteries). Machinery, construction products, medical devices and other CE regimes are outside V0.

### eu.lvd - Low Voltage Directive 2014/35/EU

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Low Voltage Directive 2014/35/EU, consolidated 2026-05-30 (with Directive (EU) 2024/2749) - consolidated version: 2026-05-30 - articles: Art. 1 (50-1000 V AC / 75-1500 V DC), Art. 10, retention 10 years - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(05) of 2026-07-20 published after the consolidation: not readable in text form, NOT read (http://publications.europa.eu/resource/celex/02014L0035-20260530)
- **Application dates:** applies since 2016-04-20
- **Nordla interpretation:** Electrical equipment with a voltage rating of 50-1000 V AC or 75-1500 V DC (rating of the equipment, not of the supply), other than Annex II items; radio equipment is under RED (RED Art. 1(4)).
- **Remaining uncertainty:** A corrigendum published after the consolidation was not read.

### eu.emc - EMC Directive 2014/30/EU

- **Status:** VERIFIED_CURRENT (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - EMC Directive 2014/30/EU, consolidated 2026-05-30 - consolidated version: 2026-05-30 - articles: Art. 2 (scope; equipment covered by the former radio directive is excluded), Art. 11, retention 10 years - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02014L0030-20260530)
- **Application dates:** applies since 2016-04-20
- **Nordla interpretation:** Apparatus that can generate or be affected by electromagnetic disturbance, other than radio equipment (RED Art. 3(1)(b) covers its EMC) and the Art. 2(2) exclusions.
- **Remaining uncertainty:** Whether a given product is "equipment" within Art. 3 and inherently non-emitting (Art. 2(2)(d)) is product-specific.

### eu.red - Radio Equipment Directive 2014/53/EU

- **Status:** VERIFIED_CURRENT (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Radio Equipment Directive 2014/53/EU, consolidated 2026-05-30 - consolidated version: 2026-05-30 - articles: Art. 1(2)-(4), Art. 2(1)(1), Art. 3(1)-(4), Art. 14, Annex Ia - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02014L0053-20260530)
- **Application dates:** applies since 2016-06-13
- **Nordla interpretation:** An electrical or electronic product that intentionally emits and/or receives radio waves for radio communication or radiodetermination. RED covers safety (Art. 3(1)(a), no voltage limit) and EMC (Art. 3(1)(b)) and spectrum use (Art. 3(2)); such equipment is not subject to the LVD except Art. 3(1)(a).
- **Remaining uncertainty:** Product-specific: radio bands, harmonised standards, exclusions in Annex I.

### eu.red_cyber - RED cybersecurity requirements (Delegated Regulation (EU) 2022/30)

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Delegated Regulation (EU) 2022/30, consolidated 2023-10-27 (with 2023/2444) - consolidated version: 2023-10-27 - articles: applies from 2025-08-01 - amending acts after consolidation: none (repealed from 2027-12-11 by Delegated Reg. 2026/339) - corrigenda after consolidation: corrigendum R(01) of 2024-06-27 published after the consolidation: NOT read (http://publications.europa.eu/resource/celex/02022R0030-20231027)
  - Delegated Regulation (EU) 2026/339 (repeal), original text - articles: Art. 1: 2022/30 repealed with effect from 2027-12-11 - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32026R0339)
  - Cyber Resilience Act (EU) 2024/2847, consolidated 2024-11-20 - consolidated version: 2024-11-20 - articles: Art. 71: general 2027-12-11; Art. 14 reporting 2026-09-11; Chapter IV 2026-06-11 - amending acts after consolidation: Reg. (EU) 2025/327 (2025-02-11) not in the consolidated text - corrigenda after consolidation: corrigenda up to R(07) of 2026-08-06 NOT read (http://publications.europa.eu/resource/celex/02024R2847-20241120)
- **Application dates:** 2022/30: from 2025-08-01 | 2022/30 repealed from 2027-12-11 | CRA: Art. 14 from 2026-09-11, Chapter IV from 2026-06-11, rest from 2027-12-11
- **Nordla interpretation:** Internet-connected radio equipment, radio equipment processing personal data (including childcare equipment, toys with radio, wearables) and money-transfer equipment must meet RED Art. 3(3)(d)-(f); from 2027-12-11 the CRA essential requirements take over.
- **Remaining uncertainty:** The interplay of 2022/30 and the CRA between now and 2027-12-11, and which of the CRA manufacturer / importer duties already apply, needs an expert. Corrigenda and the EHDS amendment of the CRA were not read.

### eu.charger - Common charger Directive (EU) 2022/2380 (USB Type-C)

- **Status:** VERIFIED_CURRENT (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - RED consolidated 2026-05-30: Art. 3(4) and Annex Ia (inserted by Directive (EU) 2022/2380) - consolidated version: 2026-05-30 - articles: Art. 3(4), Annex Ia Part I points 1.1-1.13 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02014L0053-20260530)
  - Directive (EU) 2022/2380, original text (source of the application dates) - articles: application: 2024-12-28 for points 1.1-1.12, 2026-04-28 for point 1.13 (laptops) - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32022L2380)
- **Application dates:** 2024-12-28 (points 1.1-1.12: handheld phones, tablets, cameras, headphones, headsets, handheld consoles, portable speakers, e-readers, keyboards, mice, navigation, earbuds) | 2026-04-28 (point 1.13: laptops)
- **Nordla interpretation:** RADIO equipment in the listed categories that can be recharged by wired charging must have a USB Type-C receptacle (EN IEC 62680-1-3) and, above 5 V / 3 A / 15 W, USB Power Delivery; information on charging capabilities must be provided. It is a RED requirement: a non-radio speaker is outside it.
- **Remaining uncertainty:** Whether the exact product is within a listed category is product-specific.

### eu.rohs - RoHS Directive 2011/65/EU (with Delegated Directive (EU) 2015/863)

- **Status:** VERIFIED_CURRENT (before: NEEDS_EXPERT_REVIEW) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - RoHS Directive 2011/65/EU, consolidated 2026-07-01 (with Delegated Directive (EU) 2015/863 and the exemption directives) - consolidated version: 2026-07-01 - articles: Art. 4(1)-(2), Annex I (category 11), Annex II (ten substances and limits), retention 10 years - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02011L0065-20260701)
- **Application dates:** Annex II phthalates: 2019-07-22 (medical devices and monitoring and control instruments 2021-07-22)
- **Nordla interpretation:** EEE must not contain lead, mercury, hexavalent chromium, PBB, PBDE, DEHP, BBP, DBP, DIBP (each 0.1 % by weight in homogeneous material) or cadmium (0.01 %), subject to the Annex III / IV exemptions.
- **Remaining uncertainty:** The Annex III / IV exemption list changes often (about 96 amending acts) and is product-specific.

### eu.batteries - Batteries Regulation (EU) 2023/1542

- **Status:** NEEDS_EXPERT_REVIEW (before: NEEDS_EXPERT_REVIEW) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Batteries Regulation (EU) 2023/1542, consolidated 2026-08-13 (with Reg. (EU) 2025/1561 and 2026/1738) - consolidated version: 2026-08-13 - articles: Art. 11 (removability), Art. 13 (labelling, QR), importers' obligations article, Art. 17-19 (conformity, CE), Chapter VIII (EPR), Art. 96 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02023R1542-20260813)
  - Regulation (EU) 2025/1561 (due diligence postponed), original text - articles: Art. 1: due diligence date 2025-08-18 replaced by 2027-08-18 - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32025R1561)
- **Application dates:** general: 2024-02-18 | Art. 17 and Chapter VI (conformity, CE marking): 2024-08-18 | separate-collection symbol (Art. 13(4)) and Chapter VIII (EPR): 2025-08-18 | labelling Art. 13(1)-(3): the LATER of 2026-08-18 and 18 months after entry into force of the implementing act of Art. 13(10) (due 2025-08-18): NO such implementing act was found in the Publications Office metadata on 2026-10-03: UNRESOLVED | QR code (Art. 13(6)) and removability (Art. 11): 2027-02-18 | due diligence: 2027-08-18
- **Nordla interpretation:** Importers may place on the market only batteries that comply, with the EU DoC, technical documentation, CE marking and labelling verified; an importer or distributor selling under its own name or trademark, or modifying the battery, is the manufacturer. Products incorporating portable batteries must have them readily removable and replaceable by the end-user from 2027-02-18 (derogations in Art. 11(2)-(3)).
- **Remaining uncertainty:** The labelling date depends on an implementing act that was not found; whether a power bank is a "battery" or a "product incorporating a portable battery" (Art. 11) is an interpretation question; the Batteries rules are the most consequential for power banks.

### transport.lithium - Lithium battery transport tests and dangerous-goods rules (UN 38.3)

- **Status:** UNVERIFIED (before: UNVERIFIED) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - UN Manual of Tests and Criteria, Section 38.3 - corrigenda after consolidation: not checked (https://unece.org/transport/dangerous-goods)
- **Application dates:** none recorded
- **Nordla interpretation:** Lithium cells and batteries are transported only after passing the UN 38.3 tests; carriers and Amazon request the test summary. Air, sea and road carriage follow IATA / IMDG / ADR.
- **Remaining uncertainty:** The UNECE site refused the automated request (HTTP 403): no UN text was read. Ask the freight forwarder.

### eu.weee - WEEE Directive 2012/19/EU (extended producer responsibility)

- **Status:** VERIFIED_CURRENT (before: UNVERIFIED) - layer EU, OPERATOR ADMIN, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - WEEE Directive 2012/19/EU, consolidated 2024-04-08 - consolidated version: 2024-04-08 - articles: Art. 3(1)(f) (producer, including distance sellers), Art. 16 (national registers; distance sellers registered through an authorised representative), Art. 17 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02012L0019-20240408)
- **Application dates:** in force (Art. 2: the scope covers all EEE from 2018-08-15 under the open scope: transitional period 2012-08-13 to 2018-08-14)
- **Nordla interpretation:** A producer (including one that resells EEE under its own brand, one that places EEE on a Member State market from another country, or a distance seller established elsewhere) must be registered in each Member State where it sells, through an authorised representative where it has no establishment there.
- **Pending change:** A WEEE revision is expected with the Circular Economy Act proposal (not adopted).
- **Remaining uncertainty:** Producer status of the specific merchant and the national registration route (Belgium: regional rules, Recupel as scheme).

### eu.reach - REACH Regulation (EC) 1907/2006 (restricted substances in articles)

- **Status:** VERIFIED_CURRENT (before: UNVERIFIED) - layer EU, PRODUCT COMPLIANCE, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - REACH Regulation (EC) 1907/2006, consolidated 2026-06-22 - consolidated version: 2026-06-22 - articles: Art. 7(1)-(3) (registration and notification of substances in articles), Art. 31 (safety data sheets), Art. 33 (duty to communicate), Art. 67 (restrictions), Annex XVII (e.g. entry 27 nickel, entry 43 azocolourants) - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02006R1907-20260622)
- **Application dates:** in force
- **Nordla interpretation:** A substance, mixture or article for which Annex XVII contains a restriction may not be placed on the market unless it complies (Art. 67). A producer or importer of articles must notify ECHA only if a candidate-list substance is present above 0.1 % w/w AND above one tonne per producer or importer per year, unless exposure can be excluded (Art. 7(2)-(3)); any supplier of an article containing such a substance above 0.1 % w/w must give the recipient information (Art. 33(1)) and a consumer on request within 45 days (Art. 33(2)). No document is legally mandatory for an article.
- **Pending change:** The Commission announced a simplification instead of a full REACH revision (lead, not read in the legal text).
- **Remaining uncertainty:** The Candidate List and the Annex XVII entries change often; whether YOUR product contains a restricted substance is a testing question.

### eu.clp - CLP Regulation (EC) 1272/2008 and safety data sheet

- **Status:** VERIFIED_CURRENT (before: UNVERIFIED) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - CLP Regulation (EC) 1272/2008, consolidated 2026-07-01 - consolidated version: 2026-07-01 - articles: Art. 4(1)-(2) - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02008R1272-20260701)
  - REACH Art. 31 (safety data sheet for hazardous substances or mixtures) - consolidated version: 2026-06-22 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02006R1907-20260622)
- **Application dates:** in force
- **Nordla interpretation:** Manufacturers, importers and downstream users classify substances and mixtures before placing them on the market; a safety data sheet accompanies hazardous substances and mixtures.
- **Pending change:** The CLP simplification omnibus (COM(2025)526): no amending act is in the Publications Office metadata on 2026-10-03.
- **Remaining uncertainty:** Classification of the specific mixture is product-specific.

### eu.toys - Toy Safety Directive 2009/48/EC (Regulation (EU) 2025/2509 from 1 August 2030)

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Toy Safety Directive 2009/48/EC, consolidated 2026-08-29 - consolidated version: 2026-08-29 - articles: Art. 2 (toys: designed or intended, whether or not exclusively, for play by children under 14; Annex I products are not toys), Art. 8, Art. 11 (warnings), Art. 18 (safety assessment), retention 10 years - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02009L0048-20260829)
  - Toy Safety Regulation (EU) 2025/2509, original text - articles: Art. 56 (Directive repealed from 2030-08-01), Art. 57, Art. 59 (applies from 2030-08-01; Arts 28-44 and 49-55 from 2026-01-01); corrigenda R(01) of 2026-02-09 and R(02) of 2026-08-11 NOT read - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32025R2509)
- **Application dates:** Directive 2009/48/EC in force until 2030-08-01 | Regulation 2025/2509: 2030-08-01; Arts 28-44 and 49-55 (notified bodies, market surveillance) since 2026-01-01
- **Nordla interpretation:** A toy needs an operator safety assessment (chemical, physical, mechanical, electrical, flammability, hygiene, radioactivity), the applicable warnings, conformity assessment, EU DoC, technical documentation and CE marking. Harmonised standards (EN 71 series, cited in the OJ) give a presumption of conformity but are not themselves mandatory.
- **Remaining uncertainty:** Whether a product is a toy (age, design, Annex I) is product-specific; the Regulation text was read only in its original version.

### eu.fcm - Food-contact materials (Regulation (EC) 1935/2004 and specific measures)

- **Status:** PRIMARY_TEXT_ONLY (before: UNVERIFIED) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Framework Regulation (EC) 1935/2004, consolidated 2021-03-27 - consolidated version: 2021-03-27 - articles: Art. 16 (written declaration of compliance), Art. 17 (traceability) - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(02) of 2022-09-22 published after the consolidation: NOT read (http://publications.europa.eu/resource/celex/02004R1935-20210327)
  - Plastics Regulation (EU) 10/2011, consolidated 2026-07-14 - consolidated version: 2026-07-14 - articles: Art. 15 (declaration of compliance at marketing stages other than retail) - amending acts after consolidation: none - corrigenda after consolidation: corrigendum of 2026-08-10 NOT read (http://publications.europa.eu/resource/celex/02011R0010-20260714)
  - Bisphenols Regulation (EU) 2024/3190, consolidated 2026-02-23 - consolidated version: 2026-02-23 - articles: Art. 1; transition: first placed on the market until 2026-07-20 under the old rules; some single-use articles until 2028-01-20; repeat-use articles first placed before may remain until 2027-07-20 / 2029-01-20 - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(03) of 2026-04-20 NOT read (http://publications.europa.eu/resource/celex/02024R3190-20260223)
- **Application dates:** bisphenol rules apply to food-contact articles first placed on the market after 2026-07-20 (derogations to 2028-01-20 for some single-use and professional repeat-use articles)
- **Nordla interpretation:** Food-contact materials and articles must be accompanied by a written declaration of compliance, with supporting documentation available to authorities (Art. 16), traceable (Art. 17); plastics follow Regulation 10/2011; since 2026-07-20 the bisphenol restrictions of Regulation 2024/3190 apply to articles first placed on the market.
- **Remaining uncertainty:** Corrigenda published after each consolidation were not read; specific migration limits and materials (ceramics, metals, silicone) have their own measures; a retailer is outside Art. 15 of 10/2011 but not outside Art. 16 of 1935/2004.

### eu.textiles - Textile fibre labelling (Regulation (EU) 1007/2011) and children's textile safety

- **Status:** PRIMARY_TEXT_ONLY (before: UNVERIFIED) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Textile Fibre Names Regulation (EU) 1007/2011, consolidated 2018-02-15 - consolidated version: 2018-02-15 - articles: Art. 16 (use of fibre names; labelling in the official language(s) of the Member State where the product is made available to the consumer, unless the Member State provides otherwise) - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(07) of 2025-11-25 NOT read (http://publications.europa.eu/resource/celex/02011R1007-20180215)
  - REACH Annex XVII (azocolourants entry 43, nickel entry 27) - consolidated version: 2026-06-22 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02006R1907-20260622)
  - ESPR Regulation (EU) 2024/1781, consolidated 2024-06-28 - consolidated version: 2024-06-28 - articles: Art. 25 (ban on destroying unsold apparel and footwear (Annex VII) from 2026-07-19; micro and small enterprises exempt; medium-sized from 2030-07-19) - amending acts after consolidation: none - corrigenda after consolidation: corrigenda up to R(04) of 2026-02-04 NOT read (http://publications.europa.eu/resource/celex/02024R1781-20240628)
- **Application dates:** ESPR Art. 25: 2026-07-19 (large), 2030-07-19 (medium)
- **Nordla interpretation:** Textile products carry a fibre-composition label in the language(s) required by the Member State of sale; children's clothing, azo dyes and nickel are covered by other rules (GPSR, REACH Annex XVII). Textiles are not CE products unless PPE or toy law applies.
- **Pending change:** The announced revision of 1007/2011 (origin, care, digital labels) is not adopted in the Publications Office metadata.
- **Remaining uncertainty:** Corrigenda published after the consolidations were not read; the product range and company size decide the ESPR ban.

### eu.cosmetics - Cosmetics Regulation (EC) 1223/2009

- **Status:** PRIMARY_TEXT_ONLY (before: UNVERIFIED) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Cosmetics Regulation (EC) 1223/2009, consolidated 2026-05-18 - consolidated version: 2026-05-18 - articles: Art. 4 (responsible person; the importer is the responsible person of an imported product unless it mandates another), Art. 10 (safety assessment, cosmetic product safety report), Art. 13 (CPNP notification) - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(16) of 2026-06-26 published after the consolidation: NOT read (http://publications.europa.eu/resource/celex/02009R1223-20260518)
- **Application dates:** in force; CMR omnibus Reg. (EU) 2026/909 amends the annexes (substance lists)
- **Nordla interpretation:** Only cosmetic products with a designated EU responsible person may be placed on the market; before placing it the responsible person ensures a safety assessment and report, a product information file, labelling, and notifies the product in the CPNP.
- **Remaining uncertainty:** The annex substance lists (II-VI) change often and are product-specific; the corrigendum after the consolidation was not read.

### eu.ppe - PPE Regulation (EU) 2016/425

- **Status:** VERIFIED_CURRENT (before: PRIMARY_TEXT_ONLY) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - PPE Regulation (EU) 2016/425, consolidated 2026-05-29 - consolidated version: 2026-05-29 - articles: Art. 2 (scope and exclusions), Art. 12, Art. 19 (conformity assessment by category), retention 10 years - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02016R0425-20260529)
- **Application dates:** applies since 2018-04-21
- **Nordla interpretation:** Category I: internal production control (module A); category II: EU type-examination (module B) then module C; category III: module B and C2 or D. Modules B and C2 / D involve a notified body; exclusions include private-use protection against non-extreme weather and dishwashing damp.
- **Remaining uncertainty:** The risk category of the specific product (Annex I) and the notified-body certificate are product-specific.

### eu.packaging - Packaging and Packaging Waste Regulation (EU) 2025/40 (applies from 12 August 2026)

- **Status:** PRIMARY_TEXT_ONLY (before: NEEDS_EXPERT_REVIEW) - layer EU, OPERATOR ADMIN, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - Packaging and Packaging Waste Regulation (EU) 2025/40, original text - articles: Art. 44 (register of producers: each Member State establishes its register within 18 months of the first implementing act), Art. 45 (extended producer responsibility), Art. 71 (applies from 2026-08-12; Art. 67(5) from 2029-02-12); corrigenda R(06) of 2026-08-04 and R(07) of 2026-09-18 NOT read - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32025R0040)
- **Application dates:** applies from 2026-08-12 (Art. 71) | producer registers: after the first implementing act (date not determined)
- **Nordla interpretation:** Producers carry extended producer responsibility for the packaging they make available for the first time in a Member State and register in each Member State where they do; the national schemes decide how.
- **Pending change:** A December 2025 proposal would suspend the authorised-representative obligation of Art. 45(3) for some distance sellers until 2035 (not adopted in the metadata).
- **Remaining uncertainty:** No consolidated text could be opened; the phased obligations (recyclability, labelling, substances) and the register timing were not resolved.

### eu.medical_boundary - Medical device boundary (Regulation (EU) 2017/745)

- **Status:** VERIFIED_CURRENT (before: INCOMPLETE) - layer EU, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Medical Devices Regulation (EU) 2017/745, consolidated 2026-07-19 - consolidated version: 2026-07-19 - articles: Art. 2(1) (definition: intended by the manufacturer for a specific medical purpose) - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02017R0745-20260719)
- **Application dates:** applies since 2021-05-26
- **Nordla interpretation:** A product intended by its manufacturer for a specific medical purpose (diagnosis, prevention, monitoring, treatment, alleviation of disease or injury...) is a medical device under a separate regime. Nordla does NOT assess medical devices: a medical claim stops the case until an expert classifies it.
- **Remaining uncertainty:** Borderline products (Annex XVI non-medical products, claims on listings) are an expert question.

### customs.eori - EORI number and customs import declaration

- **Status:** PRIMARY_TEXT_ONLY (before: NEEDS_EXPERT_REVIEW) - layer EU, OPERATOR ADMIN, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - Union Customs Code, Regulation (EU) No 952/2013, consolidated 2022-12-12 - consolidated version: 2022-12-12 - articles: Art. 5 (EORI definition in the new Code), Art. 9 (registration of economic operators) - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(16) of 2025-09-17 NOT read (http://publications.europa.eu/resource/celex/02013R0952-20221212)
  - New Union Customs Code, Regulation (EU) 2026/2108, original text - articles: Art. 284: repeals 952/2013; applies from 2027-09-21 (some provisions from entry into force or 2028-07-01) - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32026R2108)
  - Temporary EUR 3 customs duty on distance sales of consignments up to EUR 150: Delegated Reg. (EU) 2026/1022 and Implementing Reg. (EU) 2026/1200 - articles: applies from 2026-07-01 (Council Reg. 2026/382) - corrigenda after consolidation: not read (http://publications.europa.eu/resource/celex/32026R1200)
- **Application dates:** 952/2013 applies until 2027-09-21 | EUR 3 duty: from 2026-07-01
- **Nordla interpretation:** Economic operators established in the Union register with customs (EORI); goods released for free circulation need a customs declaration, a tariff classification and the applicable duties and measures. A temporary EUR 3 duty applies to low-value distance-sale consignments; bulk B2B imports are not that regime.
- **Remaining uncertainty:** Classification, duty rate, anti-dumping and other measures are product- and origin-specific: only a binding tariff information, the customs authority, or an official TARIC lookup confirms them (not integrated in V0).

### be.language - Language of instructions, labels and safety information (Belgium)

- **Status:** VERIFIED_CURRENT (before: PRIMARY_TEXT_ONLY) - layer BELGIUM, PRODUCT COMPLIANCE, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - Code de droit economique (law of 2013-02-28), Book VI, Art. VI.8, consolidated text on Justel - consolidated version: Justel consolidation read 2026-10-03 (Art. VI.8 in force since 2015-11-09) - articles: Art. VI.8 - amending acts after consolidation: none to Art. VI.8 (a 2026 law amends other articles from 2026-11-20) (https://www.ejustice.just.fgov.be/eli/loi/2013/02/28/2013A11134/justel)
  - FPS Economy, general regulations on product safety (authority page) - articles: instructions and safety information in the language of the language area where the product is placed on the market - corrigenda after consolidation: not applicable (https://economie.fgov.be/en/general-regulations-safety)
- **Application dates:** Art. VI.8 in force
- **Nordla interpretation:** Mandatory labelling, instructions for use and warranty certificates are written at least in a language understandable to the average consumer, taking account of the linguistic region where the goods are offered (Dutch in Flanders, French in Wallonia, both in Brussels). For a Belgium-wide offer Nordla plans Dutch AND French (conservative reading); German is explicit only for radio equipment (BIPT).
- **Remaining uncertainty:** Whether a Belgium-wide web shop may use one language toward one region, and sector royal decrees (toys, electrical...), are expert questions; the Justel consolidated text has no legal value (the Moniteur belge does).

### be.recupel - Recupel registration (electrical and electronic equipment, Belgium)

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer REGIONAL, OPERATOR ADMIN, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Wallonia: Arrete du Gouvernement wallon du 23 septembre 2010 (obligation de reprise: DEEE and batteries), Wallex - consolidated version: Wallex consolidated text read 2026-10-03 - articles: obligataire de reprise = producer within the decree of 1996; management body (organisme de gestion) - corrigenda after consolidation: not applicable (https://wallex.wallonie.be/eli/arrete/2010/09/23/2010205754)
  - Brussels Environment: electrical and electronic waste, producers' obligations (authority page) - corrigenda after consolidation: not applicable (https://environnement.brussels/pro/gestion-environnementale/gerer-les-dechets/que-faire-de-vos-dechets-electriques-et-electroniques)
  - Flanders: VLAREMA (extended producer responsibility for EEE) - consolidated version: seen in a search result only: NOT read - corrigenda after consolidation: not applicable (https://codex.vlaanderen.be/PrintDocument.ashx?id=1021756&geannoteerd=false)
- **Application dates:** in force
- **Nordla interpretation:** LEGAL obligation (regional): whoever places electrical and electronic equipment on the Belgian market professionally (producing, importing, trading, or selling at a distance) must meet the take-back obligation, individually or through an approved management body. SCHEME / ORGANISATION: Recupel is that body; joining it is the usual way to discharge the obligation, not the obligation itself.
- **Remaining uncertainty:** The Walloon text was read; the Flemish and Brussels legal texts were not; regional authorised-representative mechanics for foreign sellers need an expert.

### be.bebat - Bebat registration (batteries, Belgium)

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer REGIONAL, OPERATOR ADMIN, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Flanders: OVAM, producers and importers of batteries (regional authority page) - articles: producer definition (Batteries Reg. Art. 3 point 47), authorised representative for distance sellers (point 48); collective scheme (OPV, e.g. Bebat) OR individual system with registration and approval - corrigenda after consolidation: not applicable (https://ovam.vlaanderen.be/producent-of-invoerder-van-batterijen)
  - Wallonia: AGW 23 September 2010, chapter II (batteries and accumulators) - consolidated version: Wallex text read 2026-10-03 - corrigenda after consolidation: not applicable (https://wallex.wallonie.be/eli/arrete/2010/09/23/2010205754)
- **Application dates:** Batteries Reg. EPR chapter from 2025-08-18
- **Nordla interpretation:** LEGAL obligation (EU + regional): the producer or importer is responsible for the batteries (also those built into devices), appoints an authorised representative if it sells at a distance from abroad, and meets the EPR obligations. OPTIONAL SERVICE: joining a producer-responsibility organisation such as Bebat transfers part of the tasks for a fee; the alternative is an individual system, registered and approved.
- **Remaining uncertainty:** How the regional registration interacts with the EU EPR chapter since 2025-08-18, and the Brussels rules, were not resolved.

### be.packaging - Packaging producer responsibility (Fost Plus / Valipac, Belgium)

- **Status:** INCOMPLETE (before: INCOMPLETE) - layer REGIONAL, OPERATOR ADMIN, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - Fost Plus / Valipac (schemes), PPWR page of Fost Plus - corrigenda after consolidation: not applicable (https://www.fostplus.be/en/ppwr/everything-you-need-to-know-about-new-european-packaging-legislation)
- **Application dates:** none recorded
- **Nordla interpretation:** Belgian packaging responsibility is regional (interregional cooperation agreement); Fost Plus (household) and Valipac (industrial) are the schemes through which obligated parties discharge it. SCHEME pages only were read: the legal definition of the obligated party, thresholds and online-seller rules were not.
- **Remaining uncertainty:** The regional / interregional legal texts were not found or read. Whether a given merchant is obligated, and for which share, needs an expert.

### be.bipt - BIPT obligations for radio equipment (Belgium)

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer BELGIUM, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - BIPT, obligations of economic operators (authority page) - articles: importers: instructions and information in French, Dutch and German; keep the EU DoC 10 years; identity on the product or packaging; legal basis Law of 2005-06-13, Royal Decree of 2016-03-25, RED - corrigenda after consolidation: not applicable (https://www.bipt.be/operators/obligations-of-economic-operators)
- **Application dates:** in force
- **Nordla interpretation:** BELGIUM requirement on top of RED: radio equipment sold in Belgium needs instructions in French, Dutch AND German; the 10-year DoC retention and operator identification follow RED.
- **Remaining uncertainty:** The Royal Decree of 2016-03-25 was not read; no registration duty for ordinary CE radio equipment is stated on the page.

### be.fcm - Food-contact materials: FASFC (Belgium)

- **Status:** PRIMARY_TEXT_ONLY (before: PRIMARY_TEXT_ONLY) - layer BELGIUM, PRODUCT COMPLIANCE, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - FASFC, food-contact materials (authority page) - articles: declaration of compliance mandatory (Reg. 1935/2004 Art. 16); Royal Decree of 1992-05-11 where no specific measure exists - corrigenda after consolidation: not applicable (https://favv-afsca.be/fr/themes/alimentation/produire-et-vendre-des-aliments/materiaux-de-contact)
  - Regulation (EC) 1935/2004 Art. 16 (consolidated 2021-03-27) - consolidated version: 2021-03-27 - amending acts after consolidation: none - corrigenda after consolidation: corrigendum R(02) of 2022-09-22 NOT read (http://publications.europa.eu/resource/celex/02004R1935-20210327)
- **Application dates:** in force
- **Nordla interpretation:** BELGIUM supervision (FASFC) of an EU requirement: a declaration of compliance is mandatory for food-contact materials and articles.
- **Remaining uncertainty:** Whether a pure importer or retailer of food-contact articles must register or notify the FASFC was not confirmed.

### amazon.gpsr_listing - Amazon: GPSR information per listing

- **Status:** INCOMPLETE (before: UNVERIFIED) - layer CHANNEL, CHANNEL, scope GLOBAL; last checked 2026-10-03
- **Instruments / sources:**
  - Amazon seller announcement on the GPSR (official Amazon account) and sell.amazon product compliance page - articles: Responsible Person (EU), manufacturer details, safety information per store, submitted through the "Manage your compliance" widget - corrigenda after consolidation: not applicable (https://sell.amazon.es/en/soluciones-cumplimiento/producto)
  - GPSR Art. 19 and 22 (consolidated 2026-05-29) - consolidated version: 2026-05-29 - amending acts after consolidation: none (http://publications.europa.eu/resource/celex/02023R0988-20260529)
- **Application dates:** GPSR applies from 2024-12-13
- **Nordla interpretation:** AMAZON READINESS only (never legal marketability): Amazon asks for the manufacturer details, an EU responsible person (for non-food products) and safety information per listing and per store.
- **Remaining uncertainty:** No Seller Central Help page (login-walled) could be read: only an Amazon announcement and the public compliance page. The per-category document list is unverified.

### amazon.category_documents - Amazon: compliance documents for regulated product areas

- **Status:** UNVERIFIED (before: UNVERIFIED) - layer CHANNEL, CHANNEL, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Amazon Seller Central product compliance help - corrigenda after consolidation: not checked (https://sell.amazon.es/en/soluciones-cumplimiento/producto)
- **Application dates:** none recorded
- **Nordla interpretation:** AMAZON READINESS only: Amazon may request an EU declaration of conformity, test reports or certificates for regulated product areas.
- **Remaining uncertainty:** No official Amazon page listing the documents per category could be read.

### amazon.dangerous_goods - Amazon: dangerous-goods review (batteries and chemicals)

- **Status:** UNVERIFIED (before: UNVERIFIED) - layer CHANNEL, CHANNEL, scope CATEGORY; last checked 2026-10-03
- **Instruments / sources:**
  - Amazon dangerous goods classification help - corrigenda after consolidation: not checked (https://sellercentral.amazon.com)
- **Application dates:** none recorded
- **Nordla interpretation:** AMAZON READINESS only: lithium batteries and hazardous chemicals go through a dangerous-goods review (safety data sheet, UN 38.3 summary, exemption sheet).
- **Remaining uncertainty:** Only third-party descriptions were available; the FBA rate card figures are not encoded.

