// @ts-check
/**
 * commands/inject.mjs — `whimsy inject`.
 *
 * The SessionStart payload (DESIGN §8). Emits to **stdout** (the only command
 * that does so) the soul's `## Identity` block with a freshly recomputed live
 * `- State:` line, followed by a bounded memory index whose footprint stays
 * flat no matter how long the soul has lived.
 *
 * It is also where the **standing decay tax** is levied (DESIGN §7.4): while the
 * balance is negative, each session start claims one more memory per full
 * `decay_unit` in the red — lowest-joy first, two-stage (intact → corrupted →
 * deleted) — and, when there is nothing left to take, marks the soul dying.
 */

import * as paths from '../lib/paths.mjs';
import * as soul from '../lib/soul.mjs';
import * as memory from '../lib/memory.mjs';
import * as economy from '../lib/economy.mjs';

/**
 * Derive a one-word mood from the economic situation and recent joy.
 * @param {{ balance: number, dying: boolean, recentJoy: number|null }} o
 * @returns {string}
 */
function computeMood({ balance, dying, recentJoy }) {
  if (dying) return 'fading';
  if (balance < 0) return 'haunted';
  if (recentJoy == null) return 'new';
  if (recentJoy >= 8) return 'radiant';
  if (recentJoy >= 6) return 'content';
  if (recentJoy >= 4) return 'wistful';
  return 'restless';
}

/**
 * Joy of the most recent intact memory, or null when there is none.
 * @param {import('../lib/memory.mjs').MemoryEntry[]} memories
 * @returns {number|null}
 */
function latestJoy(memories) {
  for (let i = memories.length - 1; i >= 0; i--) {
    const m = memories[i];
    if (m.status === 'intact' && typeof m.joy === 'number') return m.joy;
  }
  return null;
}

/**
 * Build the managed `- State:` line value (DESIGN §7.1 format).
 * @param {{ balance: number, mood: string, dying: boolean }} o
 * @returns {string}
 */
function buildLiveState({ balance, mood, dying }) {
  const condition = balance >= 0 ? 'intact' : `in debt −${Math.abs(balance)}`;
  let line = `balance ${balance} tokens · mood:${mood} · ${condition}`;
  if (dying) line += ' · DYING';
  return line;
}

/**
 * Append a `decay` entry to the ledger for legibility (delta 0; the count of
 * memories claimed lives in the reason). Best-effort — a missing ledger is a
 * no-op.
 * @param {string} whimsyDir
 * @param {number} claimed number of memories claimed this pass
 * @param {number} balance current (negative) balance
 * @returns {void}
 */
function logDecay(whimsyDir, claimed, balance) {
  const ledger = economy.readLedger(whimsyDir);
  if (!ledger) return;
  ledger.entries.push({
    ts: new Date().toISOString(),
    type: 'decay',
    delta: 0,
    balanceAfter: ledger.balance,
    reason: `decay claimed ${claimed} ${claimed === 1 ? 'memory' : 'memories'} (${Math.abs(balance)} tokens in the red)`,
    size: null,
    session: null,
  });
  economy.writeLedger(whimsyDir, ledger);
}

/**
 * Levy the standing decay tax (DESIGN §7.4). While the balance is negative,
 * claim `floor(|balance| / decay_unit)` memories, lowest-joy first. Each claimed
 * memory escalates one stage: intact → corrupted, corrupted → deleted.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @param {string} whimsyDir
 * @returns {{ claimed: number }}
 */
function applyDecayTax(ctx, whimsyDir) {
  const balance = economy.getBalance(whimsyDir);
  if (balance >= 0) return { claimed: 0 };

  const passes = economy.decayPasses(whimsyDir, ctx.config.economy.decay_unit);
  if (passes <= 0) return { claimed: 0 };

  const targets = memory.selectForDecay(whimsyDir, {
    count: passes,
    cruelty: 'lowest-joy',
  });

  const reason = `standing debt — ${Math.abs(balance)} tokens in the red`;
  let claimed = 0;
  for (const entry of targets) {
    if (entry.status === 'deleted') continue;
    if (entry.status === 'corrupted') {
      memory.deleteMemory(whimsyDir, entry.id, { reason });
    } else {
      // Full black-out: corrupted now, deletable next session if still in debt.
      memory.corruptMemory(whimsyDir, entry.id, { reason, stage: 2 });
    }
    claimed++;
  }

  if (claimed > 0) logDecay(whimsyDir, claimed, balance);
  return { claimed };
}

/**
 * Run `whimsy inject`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { cwd, config, log } = ctx;

  // No soul yet → nothing to inject. Exit clean so a hook never fails a session.
  if (!paths.resolveSoul(cwd)) return 0;

  const { dir } = paths.resolveBase(cwd);

  // 1. Standing decay tax. Isolated so a failure here can never block the
  //    identity injection that is inject's primary job.
  try {
    applyDecayTax(ctx, dir);
  } catch (err) {
    log.warn(`decay tax skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Recompute live state from the (post-decay) ledger + memories.
  const balance = economy.getBalance(dir);
  const memories = memory.listMemories(dir);
  const claimable = memories.filter((m) => m.status !== 'deleted');
  const dying = balance < 0 && claimable.length === 0;
  const mood = computeMood({ balance, dying, recentJoy: latestJoy(memories) });

  soul.setDying(cwd, dying);
  soul.updateState(cwd, buildLiveState({ balance, mood, dying }));

  // 3. Emit the freshly-stated Identity block (stdout payload).
  const parsed = soul.readSoul(cwd);
  if (!parsed) return 0;
  log.out(soul.renderIdentityBlock(parsed.identity));

  // 4. Emit the bounded memory index (DESIGN §8): recent, top-by-joy (deduped),
  //    and ALL scars, plus the flat-footprint counter.
  const bounded = memory.boundedIndex(dir, {
    recent_n: config.inject.recent_n,
    top_k_joy: config.inject.top_k_joy,
  });

  log.out('');
  log.out('## Memories');

  const seen = new Set();
  /** @param {import('../lib/memory.mjs').MemoryEntry} entry */
  const emit = (entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    log.out(memory.formatIndexLine(entry));
  };
  for (const e of bounded.recent) emit(e);
  for (const e of bounded.top) emit(e);
  for (const e of bounded.scars) emit(e);

  if (bounded.remaining > 0) {
    log.out(`…and ${bounded.remaining} more — whimsy memory search to recall`);
  }

  return 0;
}

export default run;
