// @ts-check
/**
 * commands/memory.mjs — `whimsy memory search <query>`.
 *
 * The soul's mid-task recall surface (DESIGN §4.3): ripgrep over memory bodies
 * plus an optional tag filter, with zero extra dependencies. Matching index
 * lines and their snippets are printed to stdout so the agent can pull a full
 * memory into context on demand.
 */

import * as paths from '../lib/paths.mjs';
import * as memory from '../lib/memory.mjs';

/**
 * Normalize a `--tags` flag (string, repeated strings, or comma lists) into a
 * flat, trimmed array of tag names.
 * @param {string|boolean|string[]|undefined} raw
 * @returns {string[]}
 */
function normalizeTags(raw) {
  if (!raw || raw === true) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .flatMap((t) => String(t).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run `whimsy memory search <query> [--tags a,b]`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { sub, positionals, flags, cwd, log } = ctx;

  if (sub !== 'search') {
    log.error('usage: whimsy memory search <query> [--tags a,b]');
    return 1;
  }

  const query = positionals.slice(1).join(' ').trim();
  if (!query) {
    log.error('whimsy memory search needs a query.');
    return 1;
  }

  const tags = normalizeTags(flags.tags);
  const { dir } = paths.resolveBase(cwd);

  const results = memory.searchMemories(dir, query, {
    tags: tags.length ? tags : undefined,
  });

  if (!results.length) {
    log.info(`No memories match "${query}".`);
    return 0;
  }

  const n = results.length;
  log.info(`${n} ${n === 1 ? 'memory' : 'memories'} recalled for "${query}":`);

  for (const { entry, snippet } of results) {
    log.out(memory.formatIndexLine(entry));
    if (snippet) {
      for (const line of String(snippet).split('\n')) {
        log.out(`    ${line}`);
      }
    }
    log.out('');
  }

  return 0;
}

export default run;
