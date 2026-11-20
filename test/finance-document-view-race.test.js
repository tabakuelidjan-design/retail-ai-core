// Regression test for the document view race ("Annulée" shown while the API answered READY_FOR_APPROVAL).
// Two document views are started in order; the OLDER answer arrives LAST. Only the newest view may render.
// The guard is extracted from the real browser source (no copy), and the source is checked for the wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSrc = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8');

function loadGuard() {
  const m = appSrc.match(/^const createLatestGuard = [^\n]*;$/m);
  assert.ok(m, 'createLatestGuard is defined in the UI source');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn createLatestGuard;`)();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('race: the older document view answers last and must not render over the newer one', async () => {
  const createLatestGuard = loadGuard();
  const guard = createLatestGuard();
  const rendered = [];
  const view = async (label, delayMs) => {
    const token = guard.begin();
    await sleep(delayMs); // the API answer for this document arrives after this many ms
    if (guard.isCurrent(token)) rendered.push(label);
  };
  // 0b0 (cancelled) is requested first but answers last; 1f5c (ready) is the current view
  await Promise.all([view('cancelled 0b0aeb60', 40), view('ready 1f5c4326', 5)]);
  assert.deepEqual(rendered, ['ready 1f5c4326'], 'only the newest document view renders');
});

test('a view that is still current keeps rendering (no false negative)', async () => {
  const createLatestGuard = loadGuard();
  const guard = createLatestGuard();
  const token = guard.begin();
  await sleep(1);
  assert.equal(guard.isCurrent(token), true);
  const next = guard.begin();
  assert.equal(guard.isCurrent(token), false);
  assert.equal(guard.isCurrent(next), true);
});

test('wiring: viewDoc takes a token before its first answer and checks it before rendering', () => {
  const start = appSrc.indexOf('async function viewDoc(id) {');
  assert.ok(start >= 0, 'viewDoc exists');
  const body = appSrc.slice(start, appSrc.indexOf('\n}\n', start) + 2);
  const tokenAt = body.indexOf('docView.begin()');
  const answerAt = body.indexOf("api('GET', `/api/documents/${id}`)");
  assert.ok(tokenAt >= 0 && answerAt > tokenAt, 'the token is taken before the first answer is awaited');
  const checkAt = body.indexOf('docView.isCurrent(token)', answerAt);
  const renderAt = body.indexOf('box.appendChild(dochero)');
  assert.ok(checkAt > answerAt && renderAt > checkAt, 'the token is checked after the answer and before the first render');
  assert.ok(/then\(\(c\) => \{\s*if \(!docView\.isCurrent\(token\)\) return;/.test(body), 'the late compliance answer is also checked');
});
