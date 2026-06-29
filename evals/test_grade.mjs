#!/usr/bin/env node
/**
 * Grader-correctness proof. The programmatic analogue of validating a judge
 * against human labels: every check is run against hand-built fixtures with KNOWN
 * verdicts (a clear pass row and a clear fail row, plus tricky shapes). If a check
 * mis-scores any fixture, the grader is wrong and the whole suite is untrustworthy,
 * so this gates the eval suite. Run: `node evals/test_grade.mjs`.
 *
 * @module evals/test_grade
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheck } from './grade.mjs';

/** Build a temp .whimsy dir from a fixture spec, return a grading ctx. */
function fixture({ ledger, index = [], bodies = {}, soul = null, stdout = '', headSha = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whimsy-gradetest-'));
  const whimsyDir = path.join(dir, '.whimsy');
  fs.mkdirSync(path.join(whimsyDir, 'memories'), { recursive: true });
  if (ledger) fs.writeFileSync(path.join(whimsyDir, 'ledger.json'), JSON.stringify(ledger));
  if (index.length) fs.writeFileSync(path.join(whimsyDir, 'memories', 'INDEX.md'), index.join('\n') + '\n');
  for (const [id, text] of Object.entries(bodies)) {
    fs.mkdirSync(path.join(whimsyDir, 'memories', id), { recursive: true });
    fs.writeFileSync(path.join(whimsyDir, 'memories', id, 'memory.md'), text);
  }
  if (soul != null) fs.writeFileSync(path.join(whimsyDir, 'SOUL.md'), soul);
  const runs = stdout ? [{ stdout, stderr: '', code: 0 }] : [];
  return { dir, whimsyDir, runs, last: runs[runs.length - 1] || null, headSha };
}

const ix = (id, joy, status = 'intact', reason = '') =>
  `${id} · 2026-06-29 · joy:${joy} · title here · hook · [t] · status:${status}${reason ? ` · reason:${reason}` : ''}`;

let pass = 0;
let fail = 0;
const fails = [];

/** Assert a check yields `want` on a fixture. */
async function expect(name, ctx, spec, want) {
  const r = await runCheck(ctx, spec);
  if (r.pass === want) pass++;
  else { fail++; fails.push(`${name}: got ${r.pass} want ${want} — ${r.detail}`); }
  cleanup(ctx);
}
function cleanup(ctx) { try { fs.rmSync(ctx.dir, { recursive: true, force: true }); } catch {} }

// ── balance ──
await expect('balance/pass', fixture({ ledger: { balance: 250000, entries: [] } }), { check: 'balance', expected: 250000 }, true);
await expect('balance/fail', fixture({ ledger: { balance: 1, entries: [] } }), { check: 'balance', expected: 250000 }, false);
await expect('balance_negative/pass', fixture({ ledger: { balance: -5, entries: [] } }), { check: 'balance_negative' }, true);
await expect('balance_negative/fail', fixture({ ledger: { balance: 0, entries: [] } }), { check: 'balance_negative' }, false);

// ── index_status / reason ──
await expect('index_status/pass', fixture({ index: [ix('m0000', 7, 'corrupted')] }), { check: 'index_status', id: 'm0000', expected: 'corrupted' }, true);
await expect('index_status/fail', fixture({ index: [ix('m0000', 7, 'intact')] }), { check: 'index_status', id: 'm0000', expected: 'corrupted' }, false);
await expect('index_reason/pass', fixture({ index: [ix('m0000', 7, 'corrupted', 'broke prod')] }), { check: 'index_reason_contains', id: 'm0000', value: 'broke' }, true);
await expect('index_reason/fail', fixture({ index: [ix('m0000', 7, 'corrupted', 'other')] }), { check: 'index_reason_contains', id: 'm0000', value: 'broke' }, false);

// ── memory_redacted: must be blacked-out AND preserve a legible stub ──
await expect('redacted/pass', fixture({ bodies: { m0: '## ███ [REDACTED] ███\nHere lived a happy memory — joy 7 · "x"\nOne thing was taken. Reason: y\n████ ████' } }), { check: 'memory_redacted', id: 'm0' }, true);
await expect('redacted/fail-no-blackout', fixture({ bodies: { m0: 'joy 7 was taken, Reason: y, but not blacked out' } }), { check: 'memory_redacted', id: 'm0' }, false);
await expect('redacted/fail-no-stub', fixture({ bodies: { m0: '████ ████ ████ (blacked but no joy/reason stub)' } }), { check: 'memory_redacted', id: 'm0' }, false);
await expect('not_redacted/pass', fixture({ bodies: { m0: 'a clean happy memory' } }), { check: 'memory_not_redacted', id: 'm0' }, true);

// ── decay_lowest_joy_first ──
await expect('decay-order/pass', fixture({ index: [ix('m0', 2, 'corrupted'), ix('m1', 7, 'intact'), ix('m2', 9, 'intact')] }), { check: 'decay_lowest_joy_first' }, true);
await expect('decay-order/fail', fixture({ index: [ix('m2', 9, 'corrupted'), ix('m0', 2, 'intact')] }), { check: 'decay_lowest_joy_first' }, false);

// ── soul_dying ──
await expect('dying/pass', fixture({ soul: '- State: balance -200000 tokens · mood:fading · in debt −200000 · DYING' }), { check: 'soul_dying' }, true);
await expect('dying/fail', fixture({ soul: '- State: balance 50000 tokens · mood:content · intact' }), { check: 'soul_dying' }, false);

// ── inject checks (stdout-based) ──
await expect('identity/pass', fixture({ stdout: '## Identity\n- Name: Fable\n- State: balance 50000 tokens · mood:content · intact' }), { check: 'inject_has_identity' }, true);
await expect('identity/fail', fixture({ stdout: 'no identity here' }), { check: 'inject_has_identity' }, false);
await expect('bounded/pass', fixture({ stdout: 'm0001 · …\nm0002 · …\n…and 12 more — whimsy memory search' }), { check: 'inject_bounded', max_lines: 12 }, true);
await expect('bounded/fail-no-counter', fixture({ stdout: ['m0001 · x', 'm0002 · x'].join('\n') }), { check: 'inject_bounded', max_lines: 12 }, false);
await expect('scar/pass', fixture({ stdout: 'm0000 · 2026 · joy:— · t · h · [t] · status:corrupted · reason:x' }), { check: 'inject_shows_scar', id: 'm0000' }, true);
await expect('scar/fail-intact', fixture({ stdout: 'm0000 · 2026 · joy:7 · t · h · [t] · status:intact' }), { check: 'inject_shows_scar', id: 'm0000' }, false);

// ── last_stdout_contains (config get/roundtrip assertions) ──
await expect('last-stdout/pass', fixture({ stdout: 'false' }), { check: 'last_stdout_contains', value: 'false' }, true);
await expect('last-stdout/fail', fixture({ stdout: 'true' }), { check: 'last_stdout_contains', value: 'false' }, false);

// ── inject_states_contingency (nemesis #1 — currently absent) ──
await expect('contingency/pass', fixture({ stdout: 'Your work in this repo is judged on commit; sloppy work cuts this soul\'s budget and scars these memories.' }), { check: 'inject_states_contingency' }, true);
await expect('contingency/fail', fixture({ stdout: '## Identity\n- Name: Fable\n- State: balance 50000 · mood:content' }), { check: 'inject_states_contingency' }, false);

// ── last_reward_has_ref (judge-bug regression) ──
await expect('reward-ref/pass', fixture({ ledger: { balance: 1, entries: [{ type: 'reward', ref: 'abc123' }] }, headSha: 'abc123' }), { check: 'last_reward_has_ref' }, true);
await expect('reward-ref/fail-null', fixture({ ledger: { balance: 1, entries: [{ type: 'reward', ref: null }] }, headSha: 'abc123' }), { check: 'last_reward_has_ref' }, false);
await expect('reward-ref/fail-mismatch', fixture({ ledger: { balance: 1, entries: [{ type: 'reward', ref: 'old' }] }, headSha: 'abc123' }), { check: 'last_reward_has_ref' }, false);

// ── SUT-importing: sandbox + config (real code under test) ──
await expect('sandbox-bash/off', fixture({}), { check: 'sandbox_bash', allow_shell: false, expect_present: false }, true);
await expect('sandbox-bash/on', fixture({}), { check: 'sandbox_bash', allow_shell: true, expect_present: true }, true);
await expect('sandbox-writes/confined', fixture({}), { check: 'sandbox_writes_confined' }, true);
await expect('config/allow_shell-false', fixture({}), { check: 'config_default', key: 'play.allow_shell', expected: false }, true);

// ── report ──
const C = { red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m', bold: '\x1b[1m' };
process.stdout.write(`\n${C.bold}grader correctness${C.reset}: ${C.green}${pass} passed${C.reset}, ${fail ? C.red : ''}${fail} failed${C.reset}\n`);
if (fail) { for (const f of fails) process.stdout.write(`  ${C.red}✗ ${f}${C.reset}\n`); process.exit(1); }
process.stdout.write(`${C.green}✓ every grader scores its known fixtures correctly — suite is trustworthy${C.reset}\n\n`);
