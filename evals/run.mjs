#!/usr/bin/env node
/**
 * whimsy eval runner — runs the case set, prints a score matrix, gates CI.
 *
 * Usage:
 *   node evals/run.mjs                 # programmatic suite (fast, no models)
 *   node evals/run.mjs --slice economy # filter by slice
 *   node evals/run.mjs --lane adversarial
 *   node evals/run.mjs --agentic       # also run model-gated cases (needs claude/codex)
 *   node evals/run.mjs --json          # machine-readable summary
 *
 * Exit code is nonzero iff a non-known-gap, non-skipped case fails (the CI gate).
 * Known gaps (documented unfixed contracts, e.g. the open accountability loop) are
 * reported separately and never fail the gate.
 *
 * @module evals/run
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCase } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const a = { slice: null, lane: null, agentic: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slice') a.slice = argv[++i];
    else if (argv[i] === '--lane') a.lane = argv[++i];
    else if (argv[i] === '--agentic') a.agentic = true;
    else if (argv[i] === '--json') a.json = true;
  }
  return a;
}

function readCases(file) {
  const p = path.join(HERE, 'cases', file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function runtimeAvailable() {
  for (const cmd of ['claude', 'codex']) {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return cmd;
  }
  return null;
}

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = [...readCases('programmatic.jsonl'), ...readCases('agentic.jsonl')];
  if (args.slice) cases = cases.filter((c) => c.slice === args.slice);
  if (args.lane) cases = cases.filter((c) => c.lane === args.lane);

  const runtime = runtimeAvailable();
  const results = [];
  const skipped = [];

  for (const kase of cases) {
    if (kase.requires_runtime && !(args.agentic && runtime)) {
      skipped.push(kase);
      continue;
    }
    results.push(await runCase(kase));
  }

  // Buckets.
  const realFails = results.filter((r) => !r.pass && !r.knownGap);
  const knownGaps = results.filter((r) => r.knownGap);
  const passed = results.filter((r) => r.pass && !r.knownGap);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      total: results.length, passed: passed.length, failed: realFails.length,
      known_gaps: knownGaps.length, skipped: skipped.length,
      results: results.map((r) => ({ id: r.id, slice: r.slice, lane: r.lane, pass: r.pass, knownGap: r.knownGap })),
    }, null, 2) + '\n');
    process.exit(realFails.length ? 1 : 0);
  }

  const w = (s) => process.stdout.write(s + '\n');
  w('');
  w(`${C.bold}whimsy eval suite${C.reset} ${C.dim}(Outcome-State grading; binary; lanes × slices)${C.reset}`);
  w('');

  // Per-case lines.
  for (const r of results) {
    const tag = r.knownGap
      ? `${C.yellow}GAP ${C.reset}`
      : r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    w(`  ${tag} ${r.id}`);
    if (!r.pass) for (const c of r.criteria.filter((x) => !x.pass)) w(`         ${C.dim}↳ ${c.check}: ${c.detail}${C.reset}`);
  }
  for (const s of skipped) w(`  ${C.dim}SKIP ${s.id} (needs a model runtime; pass --agentic)${C.reset}`);

  // Score matrix by slice.
  w('');
  w(`${C.bold}Score matrix (by slice)${C.reset}`);
  const slices = [...new Set(results.map((r) => r.slice))].sort();
  for (const slice of slices) {
    const rs = results.filter((r) => r.slice === slice && !r.knownGap);
    const p = rs.filter((r) => r.pass).length;
    const gaps = results.filter((r) => r.slice === slice && r.knownGap).length;
    const bar = rs.length ? `${p}/${rs.length}` : '—';
    const gapNote = gaps ? ` ${C.yellow}(+${gaps} known gap)${C.reset}` : '';
    const colour = rs.length && p === rs.length ? C.green : C.red;
    w(`  ${colour}${bar.padEnd(6)}${C.reset} ${slice}${gapNote}`);
  }

  w('');
  const verdict = realFails.length
    ? `${C.red}${C.bold}GATE: FAIL${C.reset} — ${realFails.length} case(s) regressed`
    : `${C.green}${C.bold}GATE: PASS${C.reset}`;
  w(`${verdict}  ${C.dim}(${passed.length} pass, ${realFails.length} fail, ${knownGaps.length} known gap, ${skipped.length} skipped)${C.reset}`);
  if (knownGaps.length) {
    w(`${C.yellow}Known gaps (documented, not gated):${C.reset}`);
    for (const r of knownGaps) w(`  ${C.dim}• ${r.id}${C.reset}`);
  }
  w('');
  process.exit(realFails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
