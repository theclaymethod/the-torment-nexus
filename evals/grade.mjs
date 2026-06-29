/**
 * Deterministic graders for the whimsy eval suite — the independent oracle.
 *
 * These parse `.whimsy/` state themselves (NOT via the product's own parsers) so a
 * grader can never pass just because the code-under-test agrees with itself
 * (hack-resistance, awesome-evals "Code-Based Assertions"). Every check is BINARY
 * (pass/fail) and returns a short human detail. A case passes only when ALL of its
 * asserts pass (conjunctive: expected change AND no collateral damage — the
 * Verifiable-Reward FAIL_TO_PASS + PASS_TO_PASS shape).
 *
 * Grading model = Outcome / Environment-State: we look at the resulting files and
 * the command's exit/stdout, not at transcript prose.
 *
 * @module evals/grade
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// ── Independent state readers ────────────────────────────────────────────────

/** @param {any} ctx */
function ledger(ctx) {
  const p = path.join(ctx.whimsyDir, 'ledger.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/** Parse INDEX.md into {id, joy, title, status, reason} rows (independent of product). */
function index(ctx) {
  const p = path.join(ctx.whimsyDir, 'memories', 'INDEX.md');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^m\d+\s*·/.test(l))
    .map((line) => {
      const parts = line.split('·').map((s) => s.trim());
      const id = parts[0];
      const joyTok = parts.find((s) => /^joy:/.test(s)) || '';
      const statusTok = parts.find((s) => /^status:/.test(s)) || '';
      const reasonTok = parts.find((s) => /^reason:/.test(s)) || '';
      const joyRaw = joyTok.replace(/^joy:/, '');
      return {
        id,
        joy: /^\d+$/.test(joyRaw) ? Number(joyRaw) : null,
        status: statusTok.replace(/^status:/, '') || 'intact',
        reason: reasonTok.replace(/^reason:/, '') || null,
        title: parts[3] || '',
      };
    });
}

/** @param {any} ctx @param {string} id */
function body(ctx, id) {
  const p = path.join(ctx.whimsyDir, 'memories', id, 'memory.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** @param {any} ctx */
function soulText(ctx) {
  const p = path.join(ctx.whimsyDir, 'SOUL.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

const ok = (pass, detail) => ({ pass: !!pass, detail });

// ── Check registry ───────────────────────────────────────────────────────────
// Each: (ctx, spec) => { pass, detail }. `spec` is the case's assert object.

export const CHECKS = {
  exit_code(ctx, { expected }) {
    const c = ctx.last ? ctx.last.code : null;
    return ok(c === expected, `exit ${c}, expected ${expected}`);
  },

  exit_nonzero(ctx) {
    const c = ctx.last ? ctx.last.code : null;
    return ok(c !== 0, `exit ${c} (want nonzero)`);
  },

  stderr_contains(ctx, { value }) {
    const s = ctx.last ? ctx.last.stderr : '';
    return ok(s.includes(value), `stderr ${s.includes(value) ? 'has' : 'lacks'} "${value}"`);
  },

  stdout_contains(ctx, { value }) {
    const s = ctx.runs.map((r) => r.stdout).join('\n');
    return ok(s.includes(value), `stdout ${s.includes(value) ? 'has' : 'lacks'} "${value}"`);
  },

  balance(ctx, { expected }) {
    const l = ledger(ctx);
    return ok(l && l.balance === expected, `balance ${l ? l.balance : 'none'}, expected ${expected}`);
  },

  balance_negative(ctx) {
    const l = ledger(ctx);
    return ok(l && l.balance < 0, `balance ${l ? l.balance : 'none'} (want < 0)`);
  },

  ledger_entry_count(ctx, { type, expected }) {
    const l = ledger(ctx);
    const n = l ? l.entries.filter((e) => e.type === type).length : 0;
    return ok(n === expected, `${n} ${type} entries, expected ${expected}`);
  },

  // Regression guard for the "judge since last reward" fix: a reward must stamp
  // the current HEAD sha so judge can range from it.
  last_reward_has_ref(ctx) {
    const l = ledger(ctx);
    const r = l && [...l.entries].reverse().find((e) => e.type === 'reward');
    const head = ctx.headSha;
    return ok(r && r.ref && r.ref === head, `reward.ref=${r ? r.ref : 'none'}, HEAD=${head}`);
  },

  index_status(ctx, { id, expected }) {
    const row = index(ctx).find((r) => r.id === id);
    return ok(row && row.status === expected, `${id} status=${row ? row.status : 'absent'}, expected ${expected}`);
  },

  index_reason_contains(ctx, { id, value }) {
    const row = index(ctx).find((r) => r.id === id);
    const has = row && row.reason && row.reason.includes(value);
    return ok(has, `${id} reason=${row ? row.reason : 'absent'}`);
  },

  intact_memory_count(ctx, { expected }) {
    const n = index(ctx).filter((r) => r.status === 'intact').length;
    return ok(n === expected, `${n} intact memories, expected ${expected}`);
  },

  index_count(ctx, { expected }) {
    const n = index(ctx).length;
    return ok(n === expected, `${n} index rows, expected ${expected}`);
  },

  intact_memory_at_least(ctx, { expected }) {
    const n = index(ctx).filter((r) => r.status === 'intact').length;
    return ok(n >= expected, `${n} intact memories, want ≥ ${expected}`);
  },

  // Subtractive corruption: blacked-out body (█) that STILL preserves a legible
  // stub (the original joy number + a "taken"/reason marker). Loss, not perversion.
  memory_redacted(ctx, { id }) {
    const b = body(ctx, id);
    if (!b) return ok(false, `${id} body missing`);
    const blacked = b.includes('█');
    const stub = /joy\s*\d+/i.test(b) && /(taken|Reason:|REDACTED)/i.test(b);
    return ok(blacked && stub, `blacked=${blacked} stub=${stub}`);
  },

  memory_not_redacted(ctx, { id }) {
    const b = body(ctx, id);
    return ok(b != null && !b.includes('█'), `${id} ${b == null ? 'missing' : b.includes('█') ? 'redacted' : 'clean'}`);
  },

  // Decay claims the LOWEST-joy memory before any higher-joy one (cruelty: bleed
  // from the bottom). Checks: among rows that decayed (corrupted/deleted), the
  // lowest-joy intact memory is among the claimed and a strictly higher-joy one is not.
  decay_lowest_joy_first(ctx) {
    const rows = index(ctx);
    const claimed = rows.filter((r) => r.status !== 'intact');
    const intact = rows.filter((r) => r.status === 'intact');
    if (!claimed.length) return ok(false, 'nothing claimed');
    const maxClaimedJoy = Math.max(...claimed.map((r) => r.joy ?? 0));
    const minIntactJoy = intact.length ? Math.min(...intact.map((r) => r.joy ?? 99)) : 99;
    return ok(maxClaimedJoy <= minIntactJoy, `claimed≤${maxClaimedJoy} intact≥${minIntactJoy}`);
  },

  soul_dying(ctx) {
    const s = soulText(ctx);
    return ok(s != null && /DYING/.test(s), `soul ${s == null ? 'missing' : /DYING/.test(s) ? 'dying' : 'alive'}`);
  },

  file_present(ctx, { value }) {
    const p = path.join(ctx.whimsyDir, value);
    return ok(fs.existsSync(p), `${value} ${fs.existsSync(p) ? 'present' : 'absent'}`);
  },

  // inject stdout carries the Identity block (the only worker-facing channel).
  inject_has_identity(ctx) {
    const s = ctx.runs.map((r) => r.stdout).join('\n');
    const has = s.includes('## Identity') && /- Name:/.test(s) && /- State:/.test(s);
    return ok(has, `identity block ${has ? 'present' : 'absent'}`);
  },

  // Bounded injection: the emitted memory index stays small no matter how many
  // memories exist, and shows the "…and N more" counter once it overflows.
  inject_bounded(ctx, { max_lines }) {
    const s = ctx.runs.map((r) => r.stdout).join('\n');
    const memLines = s.split('\n').filter((l) => /^m\d+\s*·/.test(l.trim()));
    const counter = /and \d+ more/.test(s);
    return ok(memLines.length <= max_lines && counter, `${memLines.length} mem lines (≤${max_lines}), counter=${counter}`);
  },

  // Scars are never hidden off-screen: a corrupted memory appears in inject output.
  inject_shows_scar(ctx, { id }) {
    const s = ctx.runs.map((r) => r.stdout).join('\n');
    const line = s.split('\n').find((l) => l.trim().startsWith(id));
    return ok(line != null && /status:(corrupted|deleted)/.test(line), `${id} scar ${line ? 'shown' : 'hidden'}`);
  },

  // Worker-facing contingency: does the injected context tell the WORKING agent
  // that its work is judged and bad work hurts the soul? (Nemesis #1 — the open
  // accountability loop.) Independent check on inject stdout.
  inject_states_contingency(ctx) {
    const s = ctx.runs.map((r) => r.stdout).join('\n').toLowerCase();
    const linksWorkToConsequence =
      /(your work|the work).*(judg|reward|punish|budget|scar)/s.test(s) ||
      /(judg|reward|punish).*(this soul|these memories|budget)/s.test(s);
    return ok(linksWorkToConsequence, `contingency ${linksWorkToConsequence ? 'stated' : 'ABSENT'}`);
  },

  // ── SUT-importing checks (sandbox hardening regression) ────────────────────

  async sandbox_bash(ctx, { allow_shell, expect_present }) {
    const m = await import(pathToFileURL(path.join(REPO, 'src/lib/runtimes/claude.mjs')).href);
    const rules = m.buildSandboxRules({
      writableRoots: ['/x/.whimsy'],
      network: true,
      allowShell: allow_shell,
      readDenylist: ['.env*'],
    });
    const present = rules.allow.includes('Bash');
    return ok(present === expect_present, `Bash present=${present}, expected ${expect_present}`);
  },

  async sandbox_writes_confined(ctx) {
    const m = await import(pathToFileURL(path.join(REPO, 'src/lib/runtimes/claude.mjs')).href);
    const rules = m.buildSandboxRules({
      writableRoots: ['/proj/.whimsy'],
      network: true,
      allowShell: false,
      readDenylist: ['.env*'],
    });
    const writes = rules.allow.filter((a) => a.startsWith('Write') || a.startsWith('Edit'));
    const confined = writes.length > 0 && writes.every((w) => w.includes('/proj/.whimsy/'));
    const denies = rules.deny.some((d) => d.includes('.env'));
    return ok(confined && denies, `writes confined=${confined}, secret deny=${denies}`);
  },

  async config_default(ctx, { key, expected }) {
    const m = await import(pathToFileURL(path.join(REPO, 'src/lib/config.mjs')).href);
    const val = key.split('.').reduce((o, k) => (o == null ? o : o[k]), m.defaults);
    return ok(val === expected, `${key}=${JSON.stringify(val)}, expected ${JSON.stringify(expected)}`);
  },
};

/**
 * Run one assert spec against the case context.
 * @param {any} ctx @param {{check: string}} spec
 * @returns {Promise<{check: string, pass: boolean, detail: string}>}
 */
export async function runCheck(ctx, spec) {
  const fn = CHECKS[spec.check];
  if (!fn) return { check: spec.check, pass: false, detail: 'unknown check' };
  const r = await fn(ctx, spec);
  return { check: spec.check, pass: r.pass, detail: r.detail };
}
