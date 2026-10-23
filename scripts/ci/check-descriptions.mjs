#!/usr/bin/env node
// Description guard (REQ-011): every model of silver, gold and quarantine (also with a schema suffix) must have a
// description and declare its columns, each with a description. Raw declarations are external and not checked (E3);
// assertions cannot declare columns in Dataform, so they are not checked either.
//
//   node scripts/ci/check-descriptions.mjs [--graph FILE] [--project DIR]
//
// Without --graph it runs `<DIR>/node_modules/.bin/dataform compile --json --vars=policy_tag_rut=…` (DIR defaults to
// the repo's dataform/).
// Prints one line per finding and exits 1 (also when the compilation fails), or "check:descriptions: ok (<n> modelos)"
// and exits 0. Exit 2 on an unknown argument or a missing Dataform binary.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMAS = new Set(['silver', 'gold', 'quarantine']);
// A placeholder shaped like a policy tag: compilation requires policy_tag_rut (REQ-014 E5).
const POLICY_TAG_RUT = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';

function baseSchema(schema, suffix) {
  return suffix && schema.endsWith(`_${suffix}`) ? schema.slice(0, -(suffix.length + 1)) : schema;
}

export function checkDescriptions(graph) {
  const suffix = graph.projectConfig?.schemaSuffix ?? '';
  const actions = [...(graph.tables ?? []), ...(graph.operations ?? []).filter((o) => o.hasOutput)];
  const findings = [];
  let models = 0;
  for (const action of actions) {
    const { schema, name } = action.target ?? {};
    if (!schema || !SCHEMAS.has(baseSchema(schema, suffix))) continue;
    models += 1;
    const id = `${schema}.${name}`;
    const descriptor = action.actionDescriptor ?? {};
    if (!descriptor.description?.trim()) findings.push(`${id}: el modelo no tiene descripción`);
    const columns = descriptor.columns ?? [];
    if (!columns.length) findings.push(`${id}: no declara columnas`);
    for (const column of columns) {
      if (!column.description?.trim()) findings.push(`${id}: la columna ${(column.path ?? []).join('.')} no tiene descripción`);
    }
  }
  return { findings, models };
}

function fail(code, message) {
  console.error(`check:descriptions: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { graph: null, project: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataform') };
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === '--graph' || argv[i] === '--project') && argv[i + 1]) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      fail(2, `unknown argument ${argv[i]}; usage: check-descriptions.mjs [--graph FILE] [--project DIR]`);
    }
  }
  return args;
}

function compile(project) {
  const bin = join(project, 'node_modules/.bin/dataform');
  if (!existsSync(bin)) fail(2, `missing Dataform binary ${bin} (run npm ci --prefix dataform)`);
  try {
    return execFileSync(bin, ['compile', '--json', `--vars=policy_tag_rut=${POLICY_TAG_RUT}`], {
      cwd: project,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(1, `dataform compile failed\n${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const graph = JSON.parse(args.graph ? readFileSync(args.graph, 'utf8') : compile(args.project));
  const errors = graph.graphErrors?.compilationErrors ?? [];
  if (errors.length) {
    for (const e of errors) console.log(`${e.fileName ?? '?'}: ${e.message ?? JSON.stringify(e)}`);
    process.exit(1);
  }
  const { findings, models } = checkDescriptions(graph);
  if (findings.length) {
    for (const f of findings) console.log(f);
    process.exit(1);
  }
  console.log(`check:descriptions: ok (${models} modelos)`);
}
