# Nordla phone probe (temporary, isolated)

Purpose: find out, on the real phone and in Firefox, what audio recording can and cannot do before any voice feature is designed (Phase P0b of China Sourcing V1).
It is **not** part of China Sourcing: it imports nothing from `src/sourcing`, has its own server, its own origin (its own tunnel address), its own IndexedDB (`nordla-probe`), its own service worker cache and its own token. It changes no Nordla behaviour and no case schema. Delete the folder when the investigation is closed.

## Run (on the PC)

```
node tools/phone-probe/server.js --results <path-to-results.jsonl> --tunnel --minutes 120
```

It prints one link containing the probe token after `#`. Open it on the phone in Firefox. The server and the tunnel stop by themselves after `--minutes`, or on Ctrl+C. Without `--tunnel` it listens on this computer only.

## What crosses the tunnel

| Direction | What | Sensitive? |
|---|---|---|
| PC to phone | the three probe files (HTML, JS, service worker) | no |
| Phone to PC | small JSON reports: capability flags, recording format names, byte counts, timings, event names, the browser's user-agent string | no audio, no recording content, no Nordla/case data |
| Never | the audio itself (it stays in the phone browser's storage), the token (it travels in the URL fragment, which browsers never send to a server, and it is never written to the results file) | |

Cloudflare, as the tunnel operator, can technically see those JSON reports and page files in transit (TLS ends at Cloudflare). There is nothing confidential in them.

## Safety rules built in

- loopback only; Host header must be the tunnel's own name (otherwise 421);
- `/report` needs the token (otherwise 401), accepts at most 64 KB and 500 reports;
- strict CSP, no external requests, no analytics;
- self-expiry after `--minutes`;
- "Delete ALL test recordings" button removes every recording and test file from the phone.

## The phone steps (about 10 minutes)

The page lists them in order and ticks each one:

1. Open the link in Firefox. Tap **Run environment check**.
2. **Ask for microphone** and allow it.
3. Format: leave on *browser default*. **Start recording**, talk 30-60 s (count aloud, say a model number such as "PB X200"), **Stop**. Tap **Play**; tap *I heard my voice*.
4. Tap **Reload this page now**; check the recording is listed; **Report: recordings are here**.
5. Switch on **airplane mode**. Check the page still opens (reopen it from the browser if needed). Record 30 s; Stop; Play. **Report: recordings here (airplane mode)**.
6. Switch airplane mode **off**. Within a few seconds the waiting results should be sent (the counter "waiting" goes to 0).
7. Start a recording again and tap **Start re-render storm**; talk 20 s; Stop; Stop the storm.
8. Start a recording; switch to another app for 10 s, lock the screen for 10 s, come back; Stop. (This shows what Android does to the microphone in the background.)
9. **Write 5 MB test** and **Write 25 MB test**; **Ask browser to keep storage**.
10. Optional: repeat step 3 with the other formats in the list.
11. When finished: **Delete ALL test recordings**.

## Self-test

`node tools/phone-probe/selftest.mjs` runs the probe in a real Chromium engine on the PC with a simulated microphone (only the microphone is simulated). It proves the probe's own logic; it is not a phone result.
