import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';

test('the Dataform project compiles offline and declares the raw source in us-central1', () => {
  const out = execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', `--vars=policy_tag_rut=${TAG}`], {
    cwd: project,
    encoding: 'utf8',
  });
  const graph = JSON.parse(out);
  assert.equal(graph.projectConfig.defaultLocation, 'us-central1');
  const names = (graph.declarations ?? []).map((d) => `${d.target.schema}.${d.target.name}`);
  assert.ok(names.includes('raw.mercadopublico_licitaciones'), names.join(', '));
});
