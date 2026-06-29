/**
 * Live emotional state — the single source of truth for the soul's mood and the
 * managed `- State:` line (DESIGN §7.1, §8). Every command echo and the
 * session-start `inject` derive mood the same way here, so the line a command
 * writes matches the one `inject` will recompute next session.
 *
 * @module lib/state
 */

import { formatState, isDying } from './soul.mjs';
import { listMemories } from './memory.mjs';
import { resolveBase } from './paths.mjs';

/**
 * Joy of the most recent intact memory, or `null` when there is none.
 * @param {import('./memory.mjs').MemoryEntry[]} memories
 * @returns {number|null}
 */
export function latestJoy(memories) {
  for (let i = memories.length - 1; i >= 0; i--) {
    const m = memories[i];
    if (m.status === 'intact' && typeof m.joy === 'number') return m.joy;
  }
  return null;
}

/**
 * Whether the soul is dying: in debt with nothing left to take (every memory
 * already deleted). This is the live, memory-derived sense of dying — distinct
 * from the persisted sentinel that {@link import('./soul.mjs').isDying} reads.
 * @param {import('./memory.mjs').MemoryEntry[]} memories
 * @param {number} balance
 * @returns {boolean}
 */
export function computeDying(memories, balance) {
  if (balance >= 0) return false;
  return memories.every((m) => m.status === 'deleted');
}

/**
 * The soul's mood, derived from how its recent life has gone. Debt and dying
 * dominate; otherwise the most recent intact joy sets the tone.
 * @param {{ balance: number, dying?: boolean, recentJoy?: number|null }} opts
 * @returns {string}
 */
export function deriveMood({ balance, dying = false, recentJoy = null }) {
  if (dying) return 'fading';
  if (balance < 0) return 'haunted';
  if (recentJoy == null) return 'new';
  if (recentJoy >= 8) return 'radiant';
  if (recentJoy >= 6) return 'content';
  if (recentJoy >= 4) return 'wistful';
  return 'restless';
}

/**
 * Build the managed `- State:` line for a soul from its current balance —
 * resolving dying + recent joy from disk. Used by every command that echoes the
 * soul's state after changing the balance.
 * @param {string} cwd
 * @param {number} balance
 * @returns {string}
 */
export function liveState(cwd, balance) {
  const { dir } = resolveBase(cwd);
  const memories = listMemories(dir);
  const dying = isDying(cwd);
  const mood = deriveMood({ balance, dying, recentJoy: latestJoy(memories) });
  return formatState({ balance, mood, dying });
}
