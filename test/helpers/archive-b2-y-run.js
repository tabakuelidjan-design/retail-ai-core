// The archived B2 "Y" decisions as the RUN-SHAPED folder that scripts/creative-autonomy-clarify.mjs reads (--run <dir>): built in a temp folder from the two kept fixtures
// (decisions-y.json, frame-observation.json), so that no raw trace or brain-calls folder is versioned in the repository.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function materializeArchiveRun(fixtureDir, outDir) {
  const run = join(outDir, 'run'); const product = join(run, 'remax-fc02');
  mkdirSync(join(product, 'brain-calls'), { recursive: true });
  writeFileSync(join(product, 'trace.json'), readFileSync(join(fixtureDir, 'decisions-y.json')));
  const observation = JSON.parse(readFileSync(join(fixtureDir, 'frame-observation.json'), 'utf8'));
  writeFileSync(join(product, 'brain-calls', '01-FRAME.request.json'), JSON.stringify({ system: 'x', user: JSON.stringify({ observation }) }));
  return run;
}
