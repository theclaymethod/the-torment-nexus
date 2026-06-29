// @ts-check
/**
 * reward.mjs — `whimsy reward --size small|good|great [--amount N]`
 *
 * Grows the soul's token balance as a reward for good work (DESIGN §7.2). Rewards
 * come in tiers (config.economy.reward_small/good/great); `--amount N` is an escape
 * hatch for an exact figure. After the balance grows, the soul's managed state line
 * is refreshed (and any dying mark cleared, since it's back in the black).
 */

import { resolveBase } from '../lib/paths.mjs';
import * as economy from '../lib/economy.mjs';
import { headSha } from '../lib/git.mjs';
import { requireSoul, refreshSoulState } from '../lib/command.mjs';

const SIZES = ['small', 'good', 'great'];

/**
 * `whimsy reward` handler.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export default async function reward(ctx) {
  if (!requireSoul(ctx)) return 1;
  const whimsyDir = resolveBase(ctx.cwd).dir;

  const size = typeof ctx.flags.size === 'string' ? ctx.flags.size : undefined;
  const hasAmount = ctx.flags.amount !== undefined && ctx.flags.amount !== true && ctx.flags.amount !== false;
  /** @type {number|undefined} */
  let amount;

  if (hasAmount) {
    amount = Number(ctx.flags.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      ctx.log.error(`Invalid --amount: ${ctx.flags.amount} (expected a positive integer of tokens).`);
      return 1;
    }
  }

  if (size === undefined && amount === undefined) {
    ctx.log.error('Specify a reward: --size small|good|great (or --amount N).');
    return 1;
  }
  if (size !== undefined && !SIZES.includes(size)) {
    ctx.log.error(`Invalid --size: ${size} (expected one of ${SIZES.join(', ')}).`);
    return 1;
  }

  const reason = typeof ctx.flags.reason === 'string' ? ctx.flags.reason : undefined;

  const { delta, balance } = economy.applyReward(whimsyDir, {
    size: /** @type {'small'|'good'|'great'|undefined} */ (size),
    amount,
    reason,
    // Stamp the commit boundary so the next `judge` reads the diff *since here*.
    ref: headSha(ctx.cwd),
    config: ctx.config,
  });

  const label = size ? `${size} reward` : 'reward';
  ctx.log.success(`Granted ${label}: +${delta} tokens → balance ${balance}.`);

  refreshSoulState(ctx, whimsyDir, { clearDying: true });

  return 0;
}
