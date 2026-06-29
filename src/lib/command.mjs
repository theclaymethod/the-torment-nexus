/**
 * Small helpers shared by the user-facing balance commands (reward/judge/punish),
 * which all guard on a soul existing and refresh its managed state line after a
 * balance change.
 *
 * @module lib/command
 */

import { resolveSoul } from './paths.mjs';
import { getBalance } from './economy.mjs';
import { updateState, setDying } from './soul.mjs';
import { liveState } from './state.mjs';

/**
 * Ensure a soul exists for this command; emit the standard error if not.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {boolean} true when a soul is present (the command may proceed).
 */
export function requireSoul(ctx) {
  if (resolveSoul(ctx.cwd)) return true;
  ctx.log.error('No soul found. Run `whimsy init` first.');
  return false;
}

/**
 * Recompute + rewrite the soul's managed state line from the current balance.
 * Best-effort: a failure here is warned, never fatal. With `clearDying`, repaying
 * to ≥ 0 also stops the bleeding (clears the dying mark) — used after rewards/judgments,
 * not after punishments.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @param {string} whimsyDir
 * @param {{ clearDying?: boolean }} [opts]
 * @returns {void}
 */
export function refreshSoulState(ctx, whimsyDir, { clearDying = false } = {}) {
  try {
    const balance = getBalance(whimsyDir);
    updateState(ctx.cwd, liveState(ctx.cwd, balance));
    if (clearDying && balance >= 0) setDying(ctx.cwd, false);
  } catch (err) {
    ctx.log.warn(`Could not refresh soul state: ${err instanceof Error ? err.message : String(err)}`);
  }
}
