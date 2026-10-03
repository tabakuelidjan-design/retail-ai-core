# China operating procedure (field mode V0)

Read `docs/sourcing-field-mode.md` first for what the tool is. This is the exact procedure. Nothing here publishes or deploys anything.

## What you can and cannot rely on (short version)

- **Rely on**: the arithmetic (landed cost, maximum purchase price, what-if), the questions to ask, the document comparison (model / manufacturer / pages / dates / standards), the Safety Gate matching **of the weeks downloaded**, and the case being kept on the phone.
- **Do NOT rely on as legal fact**: any "GREEN"/compliance statement for your product. 13 of the 31 rules now match the current consolidated EU text (VERIFIED_CURRENT), but that is about the rules, not your product; power banks and other batteries stay CONDITIONAL_GO at best until an expert reviews the Batteries rules (`docs/sourcing-regulatory-closure.md`). An expert must still review the rulebook before a deposit on a regulated product.
- **Never**: a photographed paper is only a machine reading until you check it against the paper; "NO MATCH FOUND" in the Safety Gate does not prove safety; an HS/CN code is a candidate until your customs broker confirms it; Amazon fees and category restrictions are only what you type.

## A. At home, before leaving (30 minutes)

1. **Start the server** on the machine that keeps your cases: `npm run sourcing`. It writes the access token to `data/local/sourcing/token.txt` (never printed) and downloads the Safety Gate weekly reports (26 weeks by default; `SOURCING_SAFETY_REPORTS=52` for a year). Wait for "Safety Gate cache refreshed".
2. **Make it reachable from the phone over HTTPS** (a phone only keeps the app for offline use over HTTPS or on `localhost`). Do **not** open the machine to the internet directly. The safe options, in order:
   1. A private network tunnel you control (for example Tailscale with `tailscale serve`, or a Cloudflare Tunnel in front of `127.0.0.1:8787`). Then start the server with `SOURCING_ALLOWED_HOSTS=<the tunnel host name>` so any other Host header is refused (421).
   2. The same machine on your home Wi-Fi with an HTTPS reverse proxy you already trust.
   The server itself needs the token for every `/api` call, locks out an address after 8 wrong tokens in a minute (429), sends a strict Content-Security-Policy, and only serves its own app files.
   **Untested here**: reaching it from China. Check that your chosen tunnel works from a Chinese network (many do not); after the first successful load the phone does not need it except to sync and refresh.
3. **On the phone**: open the HTTPS address, sign in with the token (copy it by a channel you trust; do not type it in a public place), then **Add to Home Screen**. Open the app once with Wi-Fi ON and tap **Rules > Refresh live evidence (Safety Gate)**: the phone now holds its own copy of the Safety Gate alerts (about 1 MB).
4. **Offline rehearsal at home (mandatory)**: create a test case, then switch the phone to **airplane mode**, close the app completely, reopen it from the home screen. The case must open and compute; the header must read **CACHED**. If it does not open, the offline install did not work: do not travel relying on it (fall back to the paper checklist below).
5. Optional photo reading: if you configured a vision provider (`SOURCING_VISION_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`), remember it needs internet from China and that each image is sent only after you tap OK. Without it, photos are kept as evidence and you type what the paper says.
6. Check `docs/sourcing-field-acceptance.md` to see what a finished card looks like.

## B. In front of a supplier

1. Menu (top left) > **New product case**.
2. **Case** tab: type what it is, model, manufacturer (as printed on the label), photograph the product / label. The photo is **evidence only**: Nordla does not recognise products. Choose the category and answer the trait questions (battery? radio? for children? touches food?). Unknown stays unknown.
3. Say who is responsible: sold under **your** brand? Is the manufacturer in the EU? (Own brand makes you the manufacturer: a HIGH warning.)
4. **Money** tab: supplier unit price, currency, **your** quantity, **MOQ**, Incoterm, lead time. Enter freight / testing / other import costs as estimates (blank = UNKNOWN; unknown critical costs give INFORMATION INSUFFICIENT rather than a guess). Enter the customs duty rate your broker gave you and the selling price **with its basis** (TARGET = what you intend, OBSERVED = a listing you saw, ASSUMED = a placeholder).
5. **Decision** tab: read the verdict, the hard blockers and the **maximum purchase price**. Type the supplier's counter-offer in "Supplier says (USD)" > **What if**.
6. **Ask** tab: show the questions to the supplier (**Show to supplier (EN + 中文)**): model numbers are inserted exactly. The Chinese sentences are a fixed phrasebook written once: have a Chinese speaker check them before the trip.
7. **Docs** tab, for each paper or file:
   - PDF with a text layer: pick the file (read on your server: needs a connection).
   - Paper: photograph it. With a reader configured you are asked before the image is sent, the text comes back as **UNVERIFIED OCR**: fix it while looking at the paper, then tap **I checked the fields against the paper: confirm**. Without a reader (the default), use **Type from the paper**: model, manufacturer, directives, standards, laboratory, date, "Page x of y". It works fully offline.
   - A document for another model, a missing page, a wrong manufacturer or an expired date is flagged. SUSPICIOUS means several independent inconsistencies, never proof of forgery.
8. **Rules** tab: CE status, Safety Gate (shown as CACHED offline), customs candidates, each rule with its review status. **Market** tab: type Amazon listings you looked at (marketplace, price, pack, ASIN, reviews, rating); mark whether the category is gated in Seller Central.
9. Do **not** pay a deposit on a CONDITIONAL_GO. Get the listed documents, a sample and an agreed inspection first; ask an expert to review the regimes that apply.

## C. Back online

Open the app: when the server is reachable the header turns LIVE VERIFIED, cases changed offline are pushed to your server (a case changed on two devices is reported, never overwritten), and **Refresh live evidence** updates the Safety Gate copy.

## D. If the app does not work in the field (paper fallback)

Ask for: model number, manufacturer legal name and address, EU Declaration of Conformity for the exact model, accredited-laboratory test reports (EMC, safety, radio, RoHS as applicable), battery UN 38.3 summary, MOQ, Incoterm, carton data. Photograph everything. Do not pay a deposit.
