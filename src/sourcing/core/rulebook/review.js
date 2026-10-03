// Review status of EVERY existing rule (no rule was added), from the verification pass of 2026-10-03.
//   VERIFIED_CURRENT            a current / consolidated text was opened AND amendments and application dates were checked            (NO rule reaches this: no consolidated text could be opened)
//   VERIFIED_PRIMARY_TEXT_ONLY  an official primary source (the original Official Journal text, or the competent authority's own page) was read; consolidated
//                               text, corrigenda and some application dates were NOT checked
//   NEEDS_EXPERT_REVIEW         read in part, but scope, dates or amendments are contested or too complex to rely on without an expert
//   INCOMPLETE                  only partly covered
//   UNVERIFIED                  not opened (search leads only)
// A rule that APPLIES to a case and is NEEDS_EXPERT_REVIEW / INCOMPLETE / UNVERIFIED can never support an unconditional green verdict (core/decision.js).
// Do not upgrade a status without opening the consolidated text and checking amendments and dates.
const AT = '2026-10-03';
const r = (status, basis, extra = {}) => ({ status, checkedAt: AT, basis, ...extra });
const PRIMARY = 'original Official Journal text read via the Publications Office; consolidated text, corrigenda and some dates not checked';
const AUTH = "the competent authority's own page was read (undated or dated as stated); the legal text (Official Gazette / Justel) was not read";

export const REVIEW = Object.freeze({
  'eu.gpsr': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; applies from 13 Dec 2024 (Art. 52); amended only by 2024/2748 (emergency procedures); four corrigenda (latest 18 Mar 2026) not read`, { needsExpert: 'residual scope for harmonised products' }),
  'eu.nlf_operator': r('NEEDS_EXPERT_REVIEW', 'Art. 4 mechanics read in the original 2019/1020 text; Art. 4(5) was REPLACED by Reg. 2024/1252 (list still includes LVD, EMC, RED, RoHS, PPE, Toys) and the regulation has been amended several times; Decision 768/2008 not opened; a "European product act" that reviews 765/2008, 768/2008 and 2019/1020 is pending (adoption scheduled 6 Oct 2026, not adopted)'),
  'eu.ce': r('NEEDS_EXPERT_REVIEW', 'Reg. 765/2008 Art. 30 and the Commission CE page were read; the framework is under review by the pending European product act; the list of products without CE marking has no official source'),
  'eu.lvd': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; scope 50-1000 V AC / 75-1500 V DC confirmed; amended only by 2024/2749 (emergency procedures); corrigenda R(03)-R(05) of 2025-2026 not read`),
  'eu.emc': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; Art. 2 scope read; amendments: 2018/1139, 2024/2749`),
  'eu.red': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; Art. 1(4) removes radio equipment from the LVD except health and safety (confirmed)`),
  'eu.red_cyber': r('VERIFIED_PRIMARY_TEXT_ONLY', 'Delegated Reg. 2022/30 applies from 1 Aug 2025 (2023/2444); repealed from 11 Dec 2027 by 2026/339 (full OJ text read); CRA Art. 71 dates read in the OJ text (reporting 11 Sep 2026, general 11 Dec 2027, Chapter IV 11 Jun 2026); the interplay of the two regimes needs an expert', { needsExpert: 'RED cybersecurity / CRA interplay' }),
  'eu.charger': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; 28 Dec 2024 (points 1.1-1.12) and 28 Apr 2026 (point 1.13); the Annex Ia category list was not opened`),
  'eu.rohs': r('NEEDS_EXPERT_REVIEW', 'about 120 amending acts (mostly Annex III/IV exemptions; 2025/1802, 2025/2363, 2025/2364, 2025/2456 recent); exact Annex II limits and current exemptions not verified'),
  'eu.batteries': r('NEEDS_EXPERT_REVIEW', 'Commission battery page read; staggered dates from secondary leads: due diligence postponed to 18 Aug 2027 (Reg. 2025/1561, lead); the labelling and CE-marking dates conflict between sources and are UNRESOLVED'),
  'transport.lithium': r('UNVERIFIED', 'the UN Manual of Tests and Criteria 38.3 was seen only as a search result; carriers and Amazon apply their own dangerous-goods rules'),
  'eu.weee': r('UNVERIFIED', 'Commission pages seen only as search results; no text opened; a WEEE revision is expected in the autumn 2026 Circular Economy Act proposal (lead)'),
  'eu.reach': r('UNVERIFIED', 'Commission explainer page only; no legal text opened; Commission announced (27 Apr 2026, lead) that it will not do a full REACH revision; Candidate List and Annex XVII change often'),
  'eu.clp': r('UNVERIFIED', 'search leads only; the CLP simplification omnibus (COM(2025)526) is pending or newly adopted (not confirmed)'),
  'eu.toys': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; Regulation 2025/2509 published 12 Dec 2025, applies from 1 Aug 2030 but Arts. 28-44 and 49-55 apply from 1 Jan 2026; Directive 2026/192 amends Annex II (cobalt)`, { needsExpert: 'which Regulation articles already bind operators' }),
  'eu.fcm': r('UNVERIFIED', 'FASFC and Commission pages only for the declaration of compliance; amendments 2025/351 (supply-chain compliance from 16 Sep 2026, lead) and 2026/245 (lead); bisphenol Reg. 2024/3190 transition dates from leads only'),
  'eu.textiles': r('UNVERIFIED', 'Commission FAQ read; the 1007/2011 revision (origin, care, digital labels) was expected in 2026 and its status is not confirmed; ESPR destruction-ban dates are leads'),
  'eu.cosmetics': r('UNVERIFIED', 'Commission cosmetics page only; the CMR omnibus Reg. 2026/78 (applies from 1 May 2026, lead) is not reflected in the rule'),
  'eu.ppe': r('VERIFIED_PRIMARY_TEXT_ONLY', `${PRIMARY}; Art. 2 scope and module assignment read; the Annex I category definitions and notified-body role were inferred from the modules`),
  'eu.packaging': r('NEEDS_EXPERT_REVIEW', 'Commission page read (in force 11 Feb 2025, applies 12 Aug 2026); the phased obligations were not verified; a Dec 2025 proposal would suspend the authorised-representative duty for some distance sellers until 2035'),
  'eu.medical_boundary': r('INCOMPLETE', 'only the Commission overview page was read: the intended-purpose definition and scope were not opened'),
  'customs.eori': r('NEEDS_EXPERT_REVIEW', 'Commission EORI and low-value consignment pages read; duty, classification and any trade-defence measure must come from a customs broker or an official lookup'),
  'be.language': r('VERIFIED_PRIMARY_TEXT_ONLY', `${AUTH}: FPS Economy (updated 6 Oct 2025, 21 Nov 2025) and ConsumerConnect: the legal basis is Code de droit economique art. VI.8: a language understandable to the average consumer, taking the linguistic region into account; German is explicit only for radio equipment`, { needsExpert: 'whether a Belgium-wide shop may use French only toward Wallonia' }),
  'be.recupel': r('VERIFIED_PRIMARY_TEXT_ONLY', `${AUTH}: Recupel (footer 2026): anyone selling electrical appliances in Belgium, physical or online, must register or file an individual plan; non-Belgian sellers can appoint Recupel as authorised representative; marketplaces must verify since 29 Mar 2025`),
  'be.bebat': r('VERIFIED_PRIMARY_TEXT_ONLY', `${AUTH}: Bebat: producers register with the three regional governments; joining Bebat is optional; foreign distance sellers need a Belgian authorised representative; due diligence postponed to 18 Aug 2027`),
  'be.packaging': r('INCOMPLETE', 'Fost Plus and Valipac pages read but the obligated-party definition, thresholds, exemptions and online-seller rules were not confirmed from official pages (third-party blogs only)'),
  'be.bipt': r('VERIFIED_PRIMARY_TEXT_ONLY', `${AUTH}: BIPT: importers must provide instructions in French, Dutch AND German, keep the EU DoC 10 years, and show their identity; legal basis Law of 13 Jun 2005, Royal Decree of 25 Mar 2016, RED`),
  'be.fcm': r('VERIFIED_PRIMARY_TEXT_ONLY', `${AUTH}: FASFC: a declaration of compliance is mandatory for all food-contact materials (Reg. 1935/2004 art. 16); whether a pure importer must register with the FASFC was not confirmed`),
  'amazon.gpsr_listing': r('UNVERIFIED', 'one Amazon seller-forum post by Amazon\'s official account; no Seller Central help page was opened (login-walled)'),
  'amazon.category_documents': r('UNVERIFIED', 'no Amazon help page opened; documents asked depend on the marketplace, category and product'),
  'amazon.dangerous_goods': r('UNVERIFIED', 'third-party sources only for the safety data sheet, exemption sheet and UN 38.3 summary'),
});

export const REVIEW_STATUSES = Object.freeze(['VERIFIED_CURRENT', 'VERIFIED_PRIMARY_TEXT_ONLY', 'NEEDS_EXPERT_REVIEW', 'INCOMPLETE', 'UNVERIFIED']);
