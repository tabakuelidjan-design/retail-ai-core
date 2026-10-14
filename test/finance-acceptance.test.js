import test from 'node:test';
import { SCENARIOS } from './finance-acceptance-scenarios.js';
import { SCENARIOS_2 } from './finance-acceptance-scenarios-2.js';
import { SCENARIOS_3 } from './finance-acceptance-scenarios-3.js';
import { accWorld } from './finance-acceptance-world.js';

// Final acceptance, memory half. The SAME scenarios run on PostgreSQL 17 in test/pg/90-acceptance.pg.test.js and must give the same evidence.
for (const [name, scenario] of Object.entries({ ...SCENARIOS, ...SCENARIOS_2, ...SCENARIOS_3 })) test(name, async () => { await scenario(accWorld()); });
