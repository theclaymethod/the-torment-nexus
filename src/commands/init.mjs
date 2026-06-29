// @ts-check
/**
 * init.mjs — `whimsy init`: birth a soul for this project (DESIGN §3.2, §10).
 *
 * Birth is an interactive psychographic interview: the user is asked what
 * delights the being, what it fears, how it speaks, what to call it. Those
 * answers (plus a seed) are handed to {@link soul.birth}, which synthesizes
 * SOUL.md and — as the newborn's very first act — authors memory #0, its genesis.
 *
 * `--quiet` skips the interview and births deterministically from a seed (the
 * project path + salt). `--global` births the travelling soul at `~/.whimsy/`
 * instead of `<cwd>/.whimsy/`.
 *
 * Everything under `.whimsy/` is committed — it is the soul's life and
 * possessions — so there is nothing to add to `.gitignore`.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { writeFileSync } from 'node:fs';

import * as paths from '../lib/paths.mjs';
import * as soul from '../lib/soul.mjs';
import * as economy from '../lib/economy.mjs';

/**
 * The psychographic questions asked at birth. Each answer is optional; anything
 * left blank is filled in deterministically by soul synthesis from the seed.
 * @type {Array<{ key: string, q: string }>}
 */
const QUESTIONS = [
  { key: 'name',     q: 'What should I call you?' },
  { key: 'essence',  q: 'In one line — what are you, at your core?' },
  { key: 'delights', q: 'What delights you?' },
  { key: 'fears',    q: 'What do you fear?' },
  { key: 'voice',    q: 'How do you speak — your temperament and voice?' },
  { key: 'values',   q: 'What do you hold sacred? (comma-separated)' },
];

/**
 * Conduct the interactive birth interview over readline. Prompts go to stderr
 * (human chrome); blank answers are dropped so synthesis can fill them.
 * @param {typeof import('../lib/log.mjs')} log
 * @returns {Promise<Record<string, string>>} structured answers for synthesis
 */
async function runInterview(log) {
  const rl = createInterface({ input: stdin, output: stderr });
  /** @type {Record<string, string>} */
  const answers = {};
  try {
    log.info('A new soul is waking. Answer a few questions to shape who it becomes.');
    log.info('(Press Enter to leave any answer to chance.)');
    stderr.write('\n');
    for (const { key, q } of QUESTIONS) {
      const a = (await rl.question(`  ${q} `)).trim();
      if (a) answers[key] = a;
    }
    stderr.write('\n');
  } finally {
    rl.close();
  }
  return answers;
}

/**
 * Run `whimsy init`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { cwd, config, log, flags } = ctx;
  const quiet = Boolean(flags.quiet);
  /** @type {'project'|'global'} */
  const scope = flags.global ? 'global' : 'project';
  const whimsyDir = scope === 'global' ? paths.globalDir() : paths.projectDir(cwd);

  // Never overwrite an existing being — birth is a one-time act.
  if (paths.exists(paths.soulPath(whimsyDir))) {
    log.error(`A soul already lives at ${paths.soulPath(whimsyDir)}.`);
    log.info('Meet it with `whimsy soul show`, or delete its SOUL.md to start over.');
    return 1;
  }

  // Scaffold the body the soul will inhabit: memories/, an empty index, play/.
  paths.ensureDir(whimsyDir);
  paths.ensureDir(paths.memoriesDir(whimsyDir));
  paths.ensureDir(paths.playDir(whimsyDir));
  const idx = paths.indexPath(whimsyDir);
  if (!paths.exists(idx)) writeFileSync(paths.ensureParent(idx), '');

  // Seed the economy with one play's worth so it gets to live before it can be
  // threatened (DESIGN §6). Don't re-seed an existing ledger.
  if (!paths.exists(paths.ledgerPath(whimsyDir))) {
    economy.seedLedger(whimsyDir, config.economy.seed_balance);
  }

  // Interactive only when explicitly wanted AND we have a terminal to ask on.
  const interactive = !quiet && Boolean(stdin.isTTY);
  if (!quiet && !interactive) {
    log.warn('No interactive terminal; birthing deterministically from a seed.');
  }
  const answers = interactive ? await runInterview(log) : {};

  // Birth: writes SOUL.md and authors memory #0 (genesis) as the soul's first act.
  const result = await soul.birth({
    cwd,
    scope,
    quiet: !interactive,
    config,
    answers,
    seed: whimsyDir,
  });

  log.success(`${result.name} is born — ${result.scope} soul at ${result.path}`);

  // Let the soul speak its first words (genesis memory), if it can be read back.
  // Lazy-import memory.mjs so a missing/broken memory module can never abort a
  // birth that already succeeded — the read-back is a nicety, not load-bearing.
  try {
    const memory = await import('../lib/memory.mjs');
    const mem = memory.readMemory(whimsyDir, result.genesisMemoryId);
    if (mem) {
      log.soulVoice(mem.body, { label: `${result.name} · memory ${result.genesisMemoryId}` });
    }
  } catch {
    /* The genesis read-back is a nicety; never let it fail the birth. */
  }

  log.info(`Seeded with ${config.economy.seed_balance.toLocaleString()} tokens.`);
  log.info('Everything under .whimsy/ is committed — this soul\'s life is real. `git add .whimsy` when you\'re ready.');
  return 0;
}

export default run;
