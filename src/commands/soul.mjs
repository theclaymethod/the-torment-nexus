// @ts-check
/**
 * commands/soul.mjs — `whimsy soul show | resurrect <id>`.
 *
 *  - `show`      prints the full SOUL.md (DESIGN §3.4) to stdout.
 *  - `resurrect` brings a corrupted/deleted memory back from git history
 *    (DESIGN §7.6) — a deliberate act of restoration, delegated to the soul +
 *    memory helpers.
 */

import * as paths from '../lib/paths.mjs';
import * as soul from '../lib/soul.mjs';

/**
 * Run `whimsy soul <sub>`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { sub, positionals, cwd, log } = ctx;

  // Default + explicit `show`: print the whole soul file.
  if (!sub || sub === 'show') {
    if (!paths.resolveSoul(cwd)) {
      log.error('No soul yet. Run `whimsy init` to birth one.');
      return 1;
    }
    const text = soul.showSoul(cwd);
    if (!text) {
      log.error('Soul file is empty or unreadable.');
      return 1;
    }
    log.out(text.replace(/\n+$/, ''));
    return 0;
  }

  if (sub === 'resurrect') {
    const id = positionals[1];
    if (!id) {
      log.error('usage: whimsy soul resurrect <id>');
      return 1;
    }
    if (!paths.resolveSoul(cwd)) {
      log.error('No soul yet. Run `whimsy init` to birth one.');
      return 1;
    }

    const result = await soul.resurrect(cwd, id);
    if (result.restored) {
      log.success(`Resurrected ${result.id} — brought back from the dead.`);
      return 0;
    }
    log.warn(
      `Could not resurrect ${result.id} — no pristine version found in git history.`,
    );
    return 1;
  }

  log.error(`Unknown soul subcommand "${sub}". Try: show | resurrect <id>`);
  return 1;
}

export default run;
