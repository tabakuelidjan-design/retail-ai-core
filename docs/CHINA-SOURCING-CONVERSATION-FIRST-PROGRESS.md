# China Sourcing - Conversation First : progress, owner decisions, checkpoint #3

Branch `feature/china-sourcing-field-mode`. Design: `CHINA-SOURCING-CONVERSATION-FIRST-DESIGN.md` (commit `7df7852`). Nothing pushed, merged or deployed.

## Owner decisions applied (2026-10-06)

| Q | Decision | Where it is in the code |
|---|---|---|
| Q1 | "Démarrer la conversation" opens the thread; text is the main means; the keyboard is not forced | `fm-start` (CONVERSATION_START only), e2e check 3 |
| Q2, Q3 | No audio recording in this phase; later: local by default, PC copy only on explicit request, no automatic sync | nothing built (C7 not executed) |
| Q4 | ✓ means exactly "confirmed by the user", never "verified"; documents keep their own states and never get ✓ | `core/topics.js` `topicChips`, legend in the summary sheet, e2e check 8 |
| Q5 | Detailed evaluation stays in the Résumé sheet; no permanent verdict in the conversation; only a banner for a contradiction / safety / critical document blocker; "Décision d'achat" replaced by "Évaluation d'achat" and "Décision d'entreprise (pas encore disponible, relève du socle)" | `core/context-engine.js` alerts, `fieldhome.js` wording, e2e checks 9-10 |
| Q6 | Transport, duty, rate, selling price, margin and other details are owner inputs in a sheet on demand, labelled "hypothèses de ce dossier"; the conversation only shows a compact state ("Coût rendu incomplet.") | summary sheet "À RENSEIGNER PAR VOUS"; e2e check 10 |
| Q7 | Defaults: silence 1.5 s, hold 8 s, pause 10 s, configurable | `DEFAULT_TIMING` / `normalizeTiming`, localStorage `nordla.sourcing.timing` |
| Q8 | Grouped confirmation on demand (sheet from the pill "N éléments à confirmer"), never opened automatically | e2e check 7 |
| Provenance | Machine transcription/translation: capped at MEDIUM, never grouped, individual confirmation, original → transcription → translation → extraction kept apart | `core/providers.js`, `conversation.js` derive `extract`, `understanding.js` MACHINE_DERIVED |
| Providers | Only the boundary and an empty registry; explicit selection, no routing, no download, no paid API, no new provider | `core/providers.js` |

## Commits (local)

| Commit | Content |
|---|---|
| `7df7852` | Phase A design document |
| `e510027` | test: K4 formatter-reuse check made load-independent (the 1727/1728 anomaly) |
| `6eb68f1` | `core/topics.js`: current topic + compact state chips |
| `4b7c2ab` | `core/context-engine.js`: one adjacent suggestion, alerts, compact messages (P5 only exports two helpers) |
| `377b660` | `core/suggestion-presenter.js`: timing / anti-interruption (pure, injected clock) |
| `d3c579d` | `core/providers.js` + machine-derived provenance rules |
| `892d568` | `ui/screens/fieldfirst.js`, `ui/field.css`, wiring in `ui/app.js`, e2e rewritten (14 checks), cache v0-8 |

## The 1727/1728 anomaly

Test `K4` in `test/analyses-truth-customer-ids.test.js` (Analyses, not sourcing) asserted an absolute wall-clock bound (< 800 ms for 50 000 date-format calls). It failed (1322 ms) only when other suites ran at the same time on the machine, which is how the intermittent failure appeared. It was reproduced on demand by running the Edge e2e suites in parallel with `npm test`. The assertion now measures the property it is about (formatters are reused) as a RATIO against building a formatter per call, in the same process; it still fails if the reuse is removed (ratio 0.9 instead of about 50), and it passes under CPU saturation and with the whole suite run alongside the e2e suites. Other wall-clock bounds exist (listed in the report) and were not changed.

## FIELD UX CHECKPOINT #3 (physical Android phone, Firefox)

The owner uses Nordla naturally, without a procedure and without being told where to tap (spec section 17). The same mission as checkpoint #2: "You are in front of a Chinese supplier and are considering buying their power bank. Use Nordla until you understand what to do next."

What the assistant observes and asks afterwards (not told to the owner beforehand):
1. First reflex: does the owner find "Démarrer la conversation" and the bottom bar without help?
2. Is the screen calm (no feeling of questionnaire)? Is the suggestion relevant and not interrupting? Does it vanish when the supplier already answered?
3. Are the timing defaults right (1.5 s / 8 s / 10 s)? Adjustable through `nordla.sourcing.timing` without a code change.
4. Is the pill "N éléments à confirmer" enough, or is the grouped sheet missed / opened too rarely?
5. Do ✓ ◐ ◌ ! ? read correctly without explanation? (a legend exists in the summary sheet)
6. Is the contradiction banner noticed? Are the Avant / Maintenant choices clear?
7. Is "Évaluation d'achat" / "Décision d'entreprise : pas encore disponible" understood?
8. Offline: airplane mode, reload, write, reconnect.
9. Expert still reachable (menu) and intact.

After the natural pass only, the technical checks (offline, Expert, documents, contradictions) are done in a second pass.

## Not done on purpose

Audio recording (Q2), any provider, translation or speech engine, Document Intelligence, Market (P10), Money (P7), P6, anything touching `socle-decision`, push / merge / deploy.
