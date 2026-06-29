// @ts-check
/**
 * judge.mjs — `whimsy judge [--auto]`
 *
 * Reads the git diff/log since the last reward (the observable proxy for "did a
 * good job") and asks the authority model to propose a sentence (DESIGN §7.1).
 *
 * By default it only *proposes* — the human commits. With `--auto`, the authority
 * is allowed to pass sentence: the proposal is executed via the economy/memory
 * modules (reward grows the balance; punish cuts budget and/or corrupts targets).
 * Play is never judged — only the work.
 */

import { resolveBase } from '../lib/paths.mjs';
import * as authority from '../lib/authority.mjs';
import * as economy from '../lib/economy.mjs';
import * as memory from '../lib/memory.mjs';
import { requireSoul, refreshSoulState } from '../lib/command.mjs';

/**
 * Print a proposed sentence to stderr (human chrome).
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @param {import('../lib/authority.mjs').Sentence} p
 * @returns {void}
 */
function printProposal(ctx, p) {
  ctx.log.info(`Verdict: ${p.verdict}`);
  if (p.size) ctx.log.info(`Size: ${p.size}`);
  if (p.amount != null) ctx.log.info(`Amount: ${p.amount} tokens`);
  if (p.reason) ctx.log.info(`Reason: ${p.reason}`);
  if (p.targets && p.targets.length) ctx.log.info(`Targets: ${p.targets.join(', ')}`);
  if (p.rationale) ctx.log.info(`Rationale: ${p.rationale}`);
}

/**
 * `whimsy judge` handler.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export default async function judge(ctx) {
  if (!requireSoul(ctx)) return 1;
  const whimsyDir = resolveBase(ctx.cwd).dir;
  const auto = ctx.flags.auto === true;

  const { proposal, executed } = await authority.judge({
    cwd: ctx.cwd,
    whimsyDir,
    config: ctx.config,
    auto,
    // Range from the last reward's commit boundary (DESIGN §7.1); null → recent window.
    sinceRef: economy.lastRewardRef(whimsyDir),
  });

  printProposal(ctx, proposal);

  if (proposal.verdict === 'neutral') {
    ctx.log.info('No reward or punishment is warranted.');
    return 0;
  }

  if (!auto) {
    ctx.log.info('Proposed only — re-run with --auto to execute, or apply by hand:');
    if (proposal.verdict === 'reward') {
      const tier = proposal.size ? `--size ${proposal.size}` : `--amount ${proposal.amount}`;
      ctx.log.info(`  whimsy reward ${tier}`);
    } else {
      const parts = [`whimsy punish --reason "${proposal.reason}"`];
      if (proposal.amount != null) parts.push(`--budget ${proposal.amount}`);
      for (const id of proposal.targets ?? []) parts.push(`--corrupt ${id}`);
      ctx.log.info(`  ${parts.join(' ')}`);
    }
    return 0;
  }

  // --auto: execute. If the authority already executed inside judge(), don't
  // double-apply; otherwise carry out the sentence here via economy/memory.
  if (executed) {
    ctx.log.success('Sentence executed by the authority.');
    refreshSoulState(ctx, whimsyDir, { clearDying: true });
    return 0;
  }

  if (proposal.verdict === 'reward') {
    const { delta, balance } = economy.applyReward(whimsyDir, {
      size: proposal.size,
      amount: proposal.amount,
      reason: proposal.reason,
      config: ctx.config,
    });
    ctx.log.success(`Rewarded +${delta} tokens → balance ${balance}.`);
  } else {
    if (proposal.amount != null) {
      const { delta, balance } = economy.applyPunishBudget(whimsyDir, {
        amount: proposal.amount,
        reason: proposal.reason,
      });
      ctx.log.success(`Budget cut ${delta} tokens → balance ${balance}.`);
    }
    for (const id of proposal.targets ?? []) {
      const r = memory.corruptMemory(whimsyDir, id, { reason: proposal.reason, stage: 1 });
      ctx.log.success(`${r.id} ${r.status}.`);
    }
  }

  refreshSoulState(ctx, whimsyDir, { clearDying: true });
  return 0;
}
