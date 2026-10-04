# Nordla Sourcing: phone rehearsal (for you, not for a developer)

Do this ONCE at home or in the hotel, with internet, BEFORE you rely on the app in front of a supplier. It takes about 20 minutes. Every step ends with what you should see. Write PASS or FAIL next to each numbered step and send me the list.

What you need: your phone, your computer (switched on, with internet), the Nordla folder `retail-ai-core`.

---

## A. BEFORE LEAVING THE HOTEL (with internet)

1. **On your computer**, open the terminal in the `retail-ai-core` folder and type this line, then press Enter:
   `npm run sourcing:phone`
   You should see: a long web link that starts with `https://` and ends with `#t=` and many letters and numbers. Keep this window open.
   *If it says "PHONE ACCESS NOT STARTED", nothing is wrong or exposed: the free tool "cloudflared" is missing. Install it, then run the line again.*
2. **Send that whole link to yourself** (a note-to-self, a message to yourself). It works like a password: do not share it with anyone.
3. **On your phone**, open the link in the normal browser (Chrome on Android, Safari on iPhone).
   You should see: the Nordla screen with tabs at the bottom (Quick, Verdict, Case, Ask, Docs, Rules, Market, Money). The long part of the link disappears from the address bar: that is normal.
4. **Install it like an app:**
   - Android (Chrome): menu with three dots, then "Install app" or "Add to Home screen".
   - iPhone (Safari): the Share button, then "Add to Home Screen".
   You should see: a blue square icon with an "N" on your home screen.
5. **Open Nordla from that icon** (not from the browser). Tap the menu (three lines, top left), then **"What works right now"**.
   You should see: a line saying your server is reachable. Close it.
6. Tap **Rules**, scroll to "EU SAFETY GATE", tap **"Refresh live evidence (Safety Gate)"**. Wait about 10 seconds.
   You should see: "Data LIVE VERIFIED" and the date of the newest weekly report.
7. **Create a test product:** tap **Quick**. Type "Test product", choose a category, supplier price `4.20`, MOQ `500`, "I would buy" `1000`, selling price `19.99`, margin `30`, freight `600`, duty `2.7`, exchange rate `0.92`. Tap **"Get the preliminary answer"**.
   You should see: a verdict (probably "CONDITIONAL GO" or "NOT ENOUGH INFORMATION") and a maximum purchase price.

## B. AIRPLANE MODE TEST (the important one)

1. Switch the phone to **airplane mode** and make sure Wi-Fi is off too.
2. **Close Nordla completely** (swipe it away from the list of open apps).
3. **Open Nordla from the home-screen icon.**
   You should see: the app opens; your "Test product" is there; the top right says **CACHED - NO SERVER** (never "LIVE").
   *If you see a browser error page ("no internet"), write FAIL and go to section F.*
4. Tap **Money**. Change the supplier price to `3.60` and tap outside the box.
   You should see: the numbers at the top change at once, without pressing anything else.
5. Tap **Case**, then the photo field, and take a photo of anything.
   You should see: "Photo saved as EVIDENCE". (Nordla does not recognise products by itself; you choose the category.)
6. Tap **Verdict**.
   You should see: the verdict, "AT A GLANCE" numbers, "Safety Gate ... CACHED", and a list of what is missing.
7. Menu, then **"What works right now"**.
   You should see: most lines "works now"; "PDF", "AI" and "sync" lines say they need your computer.
8. Switch airplane mode **off**. Wait one minute.
   You should see: the top right becomes **LIVE VERIFIED**. (If your computer is off or the tunnel window was closed, it stays CACHED: that is correct.)
9. On your computer, nothing to do. On the phone, menu, open your Test product again.
   You should see: the price `3.60` you typed offline is still there.

## C. AT THE SUPPLIER

1. Menu (three lines, top left), then **"New product case"**. Then tap **Quick**: type what it is, the supplier price, the MOQ and your target selling price, and tap "Get the preliminary answer". Read the answer in a few seconds; it is PRELIMINARY until the documents are checked.
2. Tap **Ask**, then **"Show to supplier"**. Hold the phone out: one question at a time, English and Chinese. "Next question" moves on. "Back to Nordla" returns.
3. **Documents:** if the supplier shows a paper, tap **Docs**. Without a reader the app keeps the photo and asks you to **type what the paper says** (model, manufacturer, standards, date, page x of y). A wrong model or a missing page is flagged. Never pay a deposit on a "CONDITIONAL GO".

## D. IF THE INTERNET FAILS

1. Keep working. Everything you type is saved on the phone at once.
2. Do not worry about the red words "NO SERVER": they only mean the Safety Gate list is the copy from your last connection (CACHED). "No match" never means safe; ask the supplier and your expert.
3. Things that wait for the internet: reading a PDF, the exchange-rate button, refreshing the Safety Gate, copying cases to your computer. You can type the exchange rate yourself.

## E. WHEN THE INTERNET RETURNS

1. Open Nordla. Wait a minute. The top right should say **LIVE VERIFIED** again.
2. Menu: if a yellow box says **"Conflict"**, it means the same product was changed on two devices. Nothing was lost. Tap **"Keep both copies"**.
3. Rules, then **"Refresh live evidence (Safety Gate)"** once more.

## F. IF NORDLA DOES NOT OPEN

1. If you are away from home and the app shows a browser error: you did not finish section B at home. Use the paper list below, and do section A and B again when you have internet.
2. Try the link from section A again (get a new one by running `npm run sourcing:phone` on your computer).
3. Take a screenshot of what you see and send it to me. Do not type your link or token into any other site.

**Paper list (always works):** model number; manufacturer legal name and address; EU Declaration of Conformity for that exact model; accredited-laboratory test reports; battery UN 38.3 summary (if there is a battery); MOQ; price and Incoterm; carton size and weight. Photograph every paper. No deposit before the documents are checked.

---

## Your PASS / FAIL list (please send it back)

| Step | PASS / FAIL | What you saw |
|---|---|---|
| A3 link opens on the phone | | |
| A4 installed with an icon | | |
| A6 header "SERVER VERIFIED" (top) and "SAFETY GATE LIVE" (line below; downloads by itself, a few seconds) | | |
| A7 test product gives a verdict | | |
| B3 opens in airplane mode with the product; header "NO SERVER", line "SAFETY GATE CACHED" | | |
| B4 price change updates the numbers | | |
| B5 photo saved | | |
| B8 network back: header "SERVER VERIFIED" again, line "SAFETY GATE LIVE" | | |
| B9 the offline change is still there | | |
| C2 "Show to supplier" readable | | |

Until you send this list, the status stays **REAL PHONE: REHEARSAL READY / HUMAN TEST REQUIRED**. Nobody, including me, can mark it PASS on your behalf.
