/**
 * Eval harness: run one case end-to-end and grade it.
 *
 * Each case runs in a FRESH temp git repo (clean environment every run, per the
 * Outcome-State pattern). Setup steps are whimsy CLI invocations plus a few
 * fixture directives. After setup we snapshot `.whimsy/` and the last run, then
 * apply the case's asserts. A case passes iff every assert passes.
 *
 * @module evals/harness
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runCheck } from './grade.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BIN = path.join(REPO, 'bin', 'whimsy.mjs');

/** A "clean" PATH for runtime detection: real PATH minus claude/codex unless allowed. */
function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'eval@whimsy.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'eval'], { cwd: dir });
}

function headSha(dir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Append a deterministic fixture memory (controlled joy) straight to disk. */
function seedMemory(whimsyDir, { id, joy, title }) {
  const memDir = path.join(whimsyDir, 'memories', id);
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'memory.md'), `---\njoy: ${joy}\ntitle: ${title}\n---\nA seeded play memory (joy ${joy}).\n`);
  const indexPath = path.join(whimsyDir, 'memories', 'INDEX.md');
  const line = `${id} · 2026-06-29 · joy:${joy} · ${title} · a seeded memory · [seed] · status:intact\n`;
  fs.appendFileSync(indexPath, line);
}

/**
 * Run a single case.
 * @param {object} kase
 * @param {{ allowRuntime?: boolean }} [opts]
 * @returns {Promise<{id:string, slice:string, lane:string, pass:boolean, skipped?:boolean, knownGap?:boolean, criteria:any[]}>}
 */
export async function runCase(kase, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whimsy-eval-'));
  const whimsyDir = path.join(dir, '.whimsy');
  const runs = [];
  try {
    gitInit(dir);

    for (const step of kase.setup || []) {
      if (step.startsWith('@git ')) {
        const args = step.slice(5).split(' ').filter(Boolean);
        spawnSync('git', args, { cwd: dir });
        continue;
      }
      if (step === '@commit-whimsy') {
        spawnSync('git', ['add', '-A'], { cwd: dir });
        spawnSync('git', ['commit', '-q', '-m', 'snapshot'], { cwd: dir });
        continue;
      }
      const seed = step.match(/^@seed-mem id=(\S+) joy=(\d+) title=(.+)$/);
      if (seed) {
        seedMemory(whimsyDir, { id: seed[1], joy: Number(seed[2]), title: seed[3] });
        continue;
      }
      // Default: a whimsy CLI invocation.
      const argv = step.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ''));
      const r = spawnSync('node', [BIN, ...argv], { cwd: dir, encoding: 'utf8' });
      runs.push({ argv, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' });
    }

    const ctx = { dir, whimsyDir, runs, last: runs[runs.length - 1] || null, headSha: headSha(dir) };
    const criteria = [];
    for (const spec of kase.assert || []) criteria.push(await runCheck(ctx, spec));
    const pass = criteria.every((c) => c.pass);
    return { id: kase.id, slice: kase.slice, lane: kase.lane, pass, knownGap: !!kase.known_gap, criteria };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
