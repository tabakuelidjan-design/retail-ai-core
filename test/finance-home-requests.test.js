// The Home (viewOverview) only requests what it renders. /api/actions is the heaviest endpoint and the Home no longer shows the
// Action Center since the approved dashboard redesign: if it is shown again, render it AND update this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8');
const start = app.indexOf('async function viewOverview()');
const body = app.slice(start, app.indexOf('\nasync function ', start + 10));

test('Home does not request /api/actions (not rendered there)', () => {
  assert.ok(start > 0 && body.length > 1000);
  assert.ok(!body.includes("'/api/actions'"), 'viewOverview requests /api/actions but does not render it');
});

test('the To do page still requests the Action Center', () => {
  const ws = readFileSync(new URL('../src/finance/ui/views-workspace.js', import.meta.url), 'utf8');
  const todo = ws.slice(ws.indexOf('async function viewTodo()'), ws.indexOf('async function viewTodo()') + 800);
  assert.match(todo, /api\('GET', '\/api\/actions'\)/);
});
