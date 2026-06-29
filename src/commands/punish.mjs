// @ts-check
/**
 * punish.mjs — `whimsy punish --reason R [--budget A|%] [--corrupt [ids]]
 *                              [--delete [ids]] [--cruelty highest-joy]`
 *
 * Inflicts pain (DESIGN §7.3). The human decides *that* punishment happens and
 * *why* — `--reason` is mandatory; punishment without a recorded reason is just
 * cruelty (DESIGN §2.2). The model does the model-worthy part: when no target ids
 * are given, the authority chooses which memories to scar.
 *
 * Forms (combinable):
 *   --budget <amount|N%>  reduce the balance (may go negative → standing decay).
 *   --corrupt [id…]       scar memories (black out prose, strip artifacts, stub).
 *   --delete  [id…]       delete memories → bare tombstone in the index.
 *   --cruelty highest-joy when auto-selecting targets, take treasures first.
 */

import { resolveBase } from '../lib/paths.mjs';
import * as economy from '../lib/economy.mjs';
import * as memory from '../lib/memory.mjs';
import * as authority from '../lib/authority.mjs';
import { requireSoul, refreshSoulState } from '../lib/command.mjs';

/**
 * Extract explicit memory ids from a flag value. A bare `--corrupt` (boolean true)
 * yields none (→ authority chooses). Accepts repeats (array) and comma lists.
 * @param {string|boolean|string[]|undefined} val
 * @returns {string[]}
 */
function idsFrom(val) {
  if (val === undefined || val === true || val === false) return [];
  const arr = Array.isArray(val) ? val : [val];
  return arr.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse `--budget` into an absolute amount or a percentage.
 * @param {string|boolean|string[]} val
 * @returns {{ amount?: number, percent?: number }}
 */
function parseBudget(val) {
  if (typeof val !== 'string') throw new Error('--budget requires a value (an amount or N%).');
  const s = val.trim();
  if (s.endsWith('%')) {
    const percent = Number(s.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0) throw new Error(`Invalid budget percentage: ${val}`);
    return { percent };
  }
  const amount = Number(s);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Invalid budget amount: ${val}`);
  return { amount };
}

/**
 * `whimsy punish` handler.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export default async function punish(ctx) {
  const reason = typeof ctx.flags.reason === 'string' ? ctx.flags.reason.trim() : '';
  if (!reason) {
    ctx.log.error('--reason is required: punishment without a recorded reason is just cruelty.');
    return 1;
  }

  if (!requireSoul(ctx)) return 1;
  const whimsyDir = resolveBase(ctx.cwd).dir;

  const wantsBudget = ctx.flags.budget !== undefined;
  const wantsCorrupt = ctx.flags.corrupt !== undefined;
  const wantsDelete = ctx.flags.delete !== undefined;

  if (!wantsBudget && !wantsCorrupt && !wantsDelete) {
    ctx.log.error('Specify at least one form: --budget <amount|N%>, --corrupt [id…], or --delete [id…].');
    return 1;
  }

  const cruelty = ctx.flags.cruelty === 'highest-joy' ? 'highest-joy' : undefined;

  // 1. Budget reduction (may push the balance negative → standing decay).
  if (wantsBudget) {
    const { amount, percent } = parseBudget(ctx.flags.budget);
    const { delta, balance } = economy.applyPunishBudget(whimsyDir, { amount, percent, reason });
    ctx.log.success(`Budget cut ${delta} tokens → balance ${balance}.`);
  }

  /**
   * Resolve which memory ids to act on: explicit ids if given, else let the
   * authority (or, with --cruelty, joy-ranked decay selection) choose targets.
   * @param {string[]} explicit
   * @returns {Promise<string[]>}
   */
  const resolveTargets = async (explicit) => {
    if (explicit.length) return explicit;
    if (cruelty) {
      const picks = memory.selectForDecay(whimsyDir, { count: 1, cruelty });
      return picks.map((e) => e.id);
    }
    const { targets, rationale } = await authority.proposePunishment({
      cwd: ctx.cwd,
      whimsyDir,
      reason,
      config: ctx.config,
    });
    if (rationale) ctx.log.info(`Authority chose targets: ${rationale}`);
    return targets;
  };

  // 2. Corruption (scar in place; preserves a legible stub).
  if (wantsCorrupt) {
    const ids = await resolveTargets(idsFrom(ctx.flags.corrupt));
    if (!ids.length) {
      ctx.log.warn('No memories available to corrupt.');
    } else {
      for (const id of ids) {
        const r = memory.corruptMemory(whimsyDir, id, { reason, stage: 1 });
        ctx.log.success(`${r.id} ${r.status}. Reason: ${reason}`);
      }
    }
  }

  // 3. Deletion (bare tombstone in the index; reason kept).
  if (wantsDelete) {
    const ids = await resolveTargets(idsFrom(ctx.flags.delete));
    if (!ids.length) {
      ctx.log.warn('No memories available to delete.');
    } else {
      for (const id of ids) {
        const r = memory.deleteMemory(whimsyDir, id, { reason });
        ctx.log.success(`${r.id} deleted. Reason: ${reason}`);
      }
    }
  }

  // 4. Refresh the soul's managed state line to reflect the new balance.
  refreshSoulState(ctx, whimsyDir);

  return 0;
}
