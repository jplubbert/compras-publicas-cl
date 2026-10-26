#!/usr/bin/env node
// README guard (REQ-015): the portfolio README has its sections in order, every repo path and npm script it cites
// exists, and it does not name Data Catalog as a current tool (R-07: it was shut down on 2026-06-01).
//
//   node scripts/ci/check-readme.mjs [--root DIR] [--file README.md]
//
// Prints one line per finding and exits 1, or "check:readme: ok (<n> secciones)" and exits 0. Exit 2 on an unknown
// argument or a missing README.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Required sections, in this order (REQ-015); each is matched against the level-2 headings, case-insensitive.
export const SECTIONS = [
  { id: 'arquitectura', pattern: /arquitectura/i },
  { id: 'qué demuestra', pattern: /qu[eé] demuestra/i },
  { id: 'cómo reproducir', pattern: /c[oó]mo reproducir/i },
  { id: 'costos y finops', pattern: /costos/i },
  { id: 'benchmark', pattern: /benchmark/i },
  { id: 'calidad', pattern: /calidad/i },
  { id: 'gobierno', pattern: /gobierno/i },
  { id: 'gitlab ci', pattern: /gitlab/i },
  { id: 'cómo se construyó', pattern: /c[oó]mo se construy[oó]/i },
  { id: 'qué se rompió', pattern: /qu[eé] se rompi[oó]/i },
  { id: 'fuentes', pattern: /fuentes/i },
];
// Top-level directories of this repo: a code span or link target starting with one of them is a path to check.
const ROOTS = ['infra', 'ingest', 'finops', 'dataform', 'orchestration', 'benchmarks', 'scripts', 'spec', 'docs', 'tests', '.github', 'openspec'];
const CITATIONS = ['ChileCompra', 'Banco Central'];

function headings(text) {
  return [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

function cited(text) {
  const found = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) found.add(m[1]);
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) found.add(m[1]);
  return [...found];
}

export function checkReadme(text, { root, scripts }) {
  const findings = [];
  const found = headings(text);
  const positions = SECTIONS.map((section) => found.findIndex((h) => section.pattern.test(h)));
  // The sections that keep the required order are the longest increasing run of positions; the rest are out of order.
  const present = positions.map((p, i) => [p, i]).filter(([p]) => p >= 0);
  const best = present.map(() => 1);
  const prev = present.map(() => -1);
  for (let i = 0; i < present.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (present[j][0] < present[i][0] && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prev[i] = j;
      }
    }
  }
  const inOrder = new Set();
  for (let i = best.indexOf(Math.max(...best, 0)); i >= 0; i = prev[i]) inOrder.add(present[i][1]);
  SECTIONS.forEach((section, i) => {
    if (positions[i] < 0) findings.push(`falta la sección «${section.id}»`);
    else if (!inOrder.has(i)) findings.push(`la sección «${section.id}» está fuera de orden`);
  });
  if (!/```mermaid/.test(text)) findings.push('falta el diagrama de arquitectura (bloque ```mermaid)');
  for (const name of CITATIONS) if (!text.includes(name)) findings.push(`falta la cita a ${name}`);

  for (const item of cited(text)) {
    const npm = /^npm run ([\w:-]+)/.exec(item);
    if (npm) {
      if (!scripts.has(npm[1])) findings.push(`el script npm «${npm[1]}» no existe en package.json`);
      continue;
    }
    const path = item.replace(/^\.\//, '').split(/[\s#]/)[0];
    if (!ROOTS.some((r) => path === r || path.startsWith(`${r}/`))) continue;
    if (!existsSync(join(root, path))) findings.push(`la ruta ${path} no existe`);
  }

  for (const line of text.split('\n')) {
    if (/data catalog/i.test(line) && !/\bex\b|se apag[oó]|apagad[oa]/i.test(line)) {
      findings.push(`nombra Data Catalog como herramienta actual (R-07): «${line.trim().slice(0, 80)}»`);
    }
  }
  return { findings, sections: SECTIONS.length };
}

function fail(code, message) {
  console.error(`check:readme: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { root: join(dirname(fileURLToPath(import.meta.url)), '..', '..'), file: 'README.md' };
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === '--root' || argv[i] === '--file') && argv[i + 1]) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      fail(2, `unknown argument ${argv[i]}; usage: check-readme.mjs [--root DIR] [--file README.md]`);
    }
  }
  args.root = resolve(args.root);
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const file = join(args.root, args.file);
  if (!existsSync(file)) fail(2, `${args.file} not found in ${args.root}`);
  const pkg = join(args.root, 'package.json');
  const scripts = new Set(existsSync(pkg) ? Object.keys(JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {}) : []);
  const { findings, sections } = checkReadme(readFileSync(file, 'utf8'), { root: args.root, scripts });
  for (const f of findings) console.log(`check:readme: ${f}`);
  if (findings.length) process.exit(1);
  console.log(`check:readme: ok (${sections} secciones)`);
}
