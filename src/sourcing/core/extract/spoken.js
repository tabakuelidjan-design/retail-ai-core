// Spoken-English number normalisation (provider-independent, deterministic). A machine transcription may carry numbers as words ("one hundred pieces", "X twenty five") or split prices ("seven dollars twenty"); the
// existing extractor reads digits. This turns the words into digits FOR EXTRACTION ONLY: the transcription text that is stored and shown is never rewritten. It never invents a number: an unreadable sequence is left as it was.
// Promoted from the benchmark (tools/voice-bench/normalize.mjs, which measured that this stage is necessary). English only; Mandarin numerals are NOT handled.
const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const isNum = (w) => w in UNITS || w in TENS || w === 'hundred' || w === 'thousand';
const wordsToNumber = (ws) => { let total = 0; let cur = 0; for (const w of ws) { if (w in UNITS) cur += UNITS[w]; else if (w in TENS) cur += TENS[w]; else if (w === 'hundred') cur = (cur || 1) * 100; else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; } } return total + cur; };

export function normalizeSpoken(input) {
  let s = String(input ?? '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  const t = s.split(' '); const out = []; let i = 0;
  const clean = (w) => w.toLowerCase().replace(/[.,;:!?]+$/g, '').replace(/^[(\[]/, '');
  const tail = (w) => (/[.,;:!?]+$/.exec(w) || [''])[0];
  while (i < t.length) {
    const w = clean(t[i]);
    if (isNum(w)) { // a run of number words, with "point" decimals: "thirty eight point three", "one oh five"
      let j = i; const run = []; while (j < t.length && (isNum(clean(t[j])) || clean(t[j]) === 'and' && j + 1 < t.length && isNum(clean(t[j + 1])) && run.length)) { if (clean(t[j]) !== 'and') run.push(clean(t[j])); j++; }
      let value = String(wordsToNumber(run)); let end = j;
      if (clean(t[end] ?? '') === 'point' && end + 1 < t.length && isNum(clean(t[end + 1])) && clean(t[end + 1]) in UNITS) { let k = end + 1; let dec = ''; while (k < t.length && clean(t[k]) in UNITS && UNITS[clean(t[k])] < 10) { dec += UNITS[clean(t[k])]; k++; } if (dec) { value += `.${dec}`; end = k; } }
      out.push(value + tail(t[end - 1] ?? '')); i = end; continue;
    }
    out.push(t[i]); i++;
  }
  let r = out.join(' ');
  r = r.replace(/\bpercent\b/gi, '%').replace(/(\d)\s+%/g, '$1%');
  // spelled letters: "P B X 200" / "U N 38.3" -> "PBX200" / "UN38.3" (two or more single letters, optionally followed by a number)
  r = r.replace(/\b((?:[A-Za-z]\s+){1,}[A-Za-z])(?:\s+(\d+(?:\.\d+)?))?(?=[\s.,;:!?]|$)/g, (m, letters, num) => { const L = letters.split(/\s+/); if (L.some((x) => x.length !== 1) || L.length < 2) return m; if (/^(?:a|i)\s/i.test(letters) && !num) return m; return letters.replace(/\s+/g, '').toUpperCase() + (num ?? ''); });
  // prices: "$7 20", "7 dollars 20", "seven dollars twenty" (already digits here), "6 dollars and 80"
  r = r.replace(/\$\s?(\d+)\s+(\d{2})\b/g, '$$$1.$2').replace(/(\d+)\s+dollars?\s+(?:and\s+)?(\d{1,2})\b(?!\s*(?:pieces|pcs|units|days|%))/gi, '$$$1.$2').replace(/(\d+)\s+dollars?\b/gi, '$$$1');
  // ASR punctuation noise inside lists: "black. White, Blue and pink," -> "black, White, Blue and pink," (sentence breaks between two colour words are list separators)
  const COL = '(?:black|white|blue|pink|red|green|grey|gray|silver|gold|yellow|orange|purple|brown)';
  r = r.replace(new RegExp('\\b(' + COL + ')\\.\\s+(?=' + COL + '\\b)', 'gi'), '$1, ');
  // a colour list said without commas ("black white and blue") -> "black, white and blue": a recogniser often leaves the commas out
  r = r.replace(new RegExp('\\b' + COL + '(?:\\s*,?\\s*(?:and\\s+)?' + COL + ')+\\b', 'gi'), (m) => { const w = m.match(new RegExp('\\b' + COL + '\\b', 'gi')); return w.length < 2 ? m : w.length === 2 ? w.join(' and ') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`; });
  // an Incoterm glued to its port by the recogniser ("Fobshensen"): split the Incoterm off (the port itself is NOT guessed)
  r = r.replace(/\b(fob|exw|cif|ddp|cfr|fca)(?=[a-z]{3,}\b)/gi, (m, a) => `${a.toUpperCase()} `);
  // a spoken model code after the word "model": "model number is X 25" -> "X25" (letters then digits, said as two words)
  r = r.replace(/\b(model(?:\s+(?:number|no\.?|is|name))*\s+)([A-Za-z]{1,3})\s+(\d{1,4}[A-Za-z]?)\b/gi, '$1$2$3');
  return r;
}

