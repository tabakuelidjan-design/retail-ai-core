// Number normalisation for spoken English transcripts (bench-local, deterministic; it is the "normalisation des nombres" stage of the chain, to be promoted to core/ only if the bench shows it is needed).
// It turns "fifty", "thirty eight point three", "seven dollars twenty", "$7 20", "P B X two hundred" into the digit forms the existing extractor reads. It never invents a number: an unreadable
// sequence is left as it was. Mandarin numerals are NOT handled here (no Mandarin audio could be measured in this first bench).
const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const isNum = (w) => w in UNITS || w in TENS || w === 'hundred' || w === 'thousand';
const wordsToNumber = (ws) => { let total = 0; let cur = 0; for (const w of ws) { if (w in UNITS) cur += UNITS[w]; else if (w in TENS) cur += TENS[w]; else if (w === 'hundred') cur = (cur || 1) * 100; else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; } } return total + cur; };

export function normalizeNumbers(input) {
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
  // an Incoterm glued to its port by the recogniser ("Fobshensen"): split the Incoterm off (the port itself is NOT guessed)
  r = r.replace(/\b(fob|exw|cif|ddp|cfr|fca)(?=[a-z]{3,}\b)/gi, (m, a) => `${a.toUpperCase()} `);
  return r;
}

/** Reference side for the transcription error rate: the same normalisation, then lower case without punctuation. */
export const words = (s) => normalizeNumbers(s).toLowerCase().replace(/[$]/g, ' usd ').replace(/[^a-z0-9.%\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
export function wer(ref, hyp) { const r = words(ref); const h = words(hyp); const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]); for (let j = 0; j <= h.length; j++) d[0][j] = j; for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)); return { wer: r.length ? d[r.length][h.length] / r.length : 0, edits: d[r.length][h.length], refWords: r.length }; }
