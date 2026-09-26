// INTERNAL diagnostics for the false-premise guard. Never imported by the server, the routes or the UI; never shown to a user.
//
// The planner must always return `premises` (an empty list when the question takes nothing for granted). That makes an omission MEASURABLE: run a benchmark of
// questions whose expected premises are known, and read how many the provider declared and how many it forgot.
//
//   const bench = createPremiseBenchmark();
//   const ask = createOrchestrator({ provider, tools, onDiagnostic: bench.onDiagnostic });
//   const report = await bench.measure(CASES, (question) => ask({ question }));
//   // CASES: [{ question, expected: [{ kind: 'trend', metric: 'sales', direction: 'decrease' }, ...] }]   (expected: [] = a question with no premise)

const FIELDS = ['kind', 'metric', 'direction', 'level', 'scope'];
/** An expected premise is matched by a declared one when every field the expectation names is equal (one declared premise serves one expectation). */
const matches = (expected, declared) => FIELDS.every((f) => expected[f] === undefined || expected[f] === declared[f]);

export function createPremiseBenchmark() {
  let events = [];
  const onDiagnostic = (d) => { if (d.type === 'PREMISES_DECLARED' || d.type === 'PREMISES_MISSING') events.push(d); };

  return {
    onDiagnostic,
    async measure(cases, run) {
      const perCase = [];
      for (const c of cases) {
        events = [];
        try { await run(c.question); } catch { /* a failing question is measured as declaring nothing */ }
        const declared = events.filter((e) => e.type === 'PREMISES_DECLARED').flatMap((e) => e.premises);
        const omittedField = events.some((e) => e.type === 'PREMISES_MISSING');
        const free = [...declared]; const found = []; const missed = [];
        for (const exp of c.expected ?? []) { const i = free.findIndex((d) => matches(exp, d)); if (i >= 0) { found.push(exp); free.splice(i, 1); } else missed.push(exp); }
        perCase.push({ question: c.question, expected: c.expected ?? [], declared, found, missed, spurious: free, omittedField });
      }
      const sum = (f) => perCase.reduce((a, x) => a + f(x), 0);
      const expectedPremises = sum((x) => x.expected.length); const matched = sum((x) => x.found.length);
      return {
        questions: perCase.length,
        questionsWithExpectedPremise: perCase.filter((x) => x.expected.length).length,
        expectedPremises,
        declaredPremises: sum((x) => x.declared.length),
        matchedPremises: matched,
        missedPremises: sum((x) => x.missed.length),
        spuriousPremises: sum((x) => x.spurious.length),          // declared although the benchmark expected none of that kind
        omittedField: perCase.filter((x) => x.omittedField).length, // plans that did not return `premises` at all
        detectionRate: expectedPremises ? matched / expectedPremises : null,
        perCase,
      };
    },
  };
}
