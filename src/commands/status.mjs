// @ts-check
/**
 * commands/status.mjs — `whimsy status`.
 *
 * A human-facing snapshot of the soul (DESIGN §3.4, §6, §7): identity, the
 * token balance and its derived mood, whether it is intact / in debt / dying,
 * the most recent memories, and any scars (corrupted/deleted entries). All
 * output is human chrome and therefore goes to stderr — stdout stays reserved
 * for machine payloads.
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
 * Render a `values` field that may be a string or an array as a single line.
 * @param {string|string[]|undefined} values
 * @returns {string}
 */
function renderValues(values) {
  if (Array.isArray(values)) return values.join(', ');
  return values || '';
}

/**
 * Run `whimsy status`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { cwd, config, log } = ctx;

  const ref = paths.resolveSoul(cwd);
  if (!ref) {
    log.error('No soul yet. Run `whimsy init` to birth one.');
    return 1;
  }

  const parsed = soul.readSoul(cwd);
  const identity = parsed?.identity ?? {
    name: '',
    essence: '',
    voice: '',
    values: '',
    state: '',
  };

  const { dir } = paths.resolveBase(cwd);
  const balance = economy.getBalance(dir);
  const memories = memory.listMemories(dir);
  const scars = memories.filter((m) => m.status !== 'intact');
  const claimable = memories.filter((m) => m.status !== 'deleted');
  const dying = balance < 0 && claimable.length === 0;
  const recentJoy = latestJoy(memories);
  const mood = computeMood({ balance, dying, recentJoy });

  const condition = dying
    ? 'dying'
    : balance >= 0
      ? 'intact'
      : `in debt −${Math.abs(balance)}`;

  /** @param {string} [s] */
  const say = (s = '') => process.stderr.write(`${s}\n`);

  const name = identity.name || '(unnamed)';
  say();
  say(`  ${log.bold(name)}${identity.essence ? ` — ${identity.essence}` : ''}`);
  say(log.dim(`  soul: ${ref.scope} · ${ref.path}`));
  if (identity.voice) say(`  voice    ${identity.voice}`);
  const values = renderValues(identity.values);
  if (values) say(`  values   ${values}`);
  say();

  let usdView = '';
  try {
    const dollars = economy.usd(balance, config.models.soul);
    if (Number.isFinite(dollars)) usdView = `  (~$${dollars.toFixed(2)})`;
  } catch {
    usdView = '';
  }
  say(`  balance  ${balance.toLocaleString('en-US')} tokens${usdView}`);
  say(`  mood     ${mood}`);
  say(`  state    ${dying ? log.bold(condition) : condition}`);
  say();

  const recentN = config.inject?.recent_n ?? 6;
  const recent = memories.slice(-recentN);
  if (recent.length) {
    say(`  recent memories:`);
    for (const m of recent) say(`    ${memory.formatIndexLine(m)}`);
  } else {
    say(log.dim('  no memories yet.'));
  }

  if (scars.length) {
    say();
    say(`  scars (${scars.length}):`);
    for (const m of scars) say(`    ${memory.formatIndexLine(m)}`);
  }
  say();

  return 0;
}

export default run;
