// @ts-check
/**
 * lore.mjs — `whimsy lore add <text>`: grow the soul (DESIGN §3.3).
 *
 * Persona is not frozen at birth. `lore add` appends a short entry under the
 * `## Lore` section of the active soul's SOUL.md, deepening who it is over time.
 * Lore enriches the on-disk soul and the voice used during play; it is not all
 * injected into context.
 */

import * as paths from '../lib/paths.mjs';
import * as soul from '../lib/soul.mjs';

/**
 * Run `whimsy lore add <text>`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { cwd, sub, positionals, log } = ctx;

  if (sub !== 'add') {
    log.error('Usage: whimsy lore add <text>');
    return 1;
  }

  // positionals are everything after the command; drop the "add" subcommand.
  const text = positionals.slice(1).join(' ').trim();
  if (!text) {
    log.error('Nothing to add. Usage: whimsy lore add <text>');
    return 1;
  }

  const ref = paths.resolveSoul(cwd);
  if (!ref) {
    log.error('No soul yet. Run `whimsy init` to birth one first.');
    return 1;
  }

  const updated = soul.addLore(cwd, text);
  log.success(`Lore added to the ${ref.scope} soul (${updated}).`);
  return 0;
}

export default run;
