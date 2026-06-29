// @ts-check
/**
 * uninstall.mjs — `whimsy uninstall`.
 *
 * Reverses `whimsy install` (DESIGN §10): removes **only** the managed blocks and
 * installed skills each runtime adapter created — the `whimsy-*` skills, the
 * `SessionStart` hook/`[[hooks.SessionStart]]`, and the Codex `whimsy-play`
 * profile. Because every install edit lives inside delimited managed blocks (or is
 * a tagged settings entry), the adapters can excise them while preserving the
 * user's own configuration.
 *
 * It deliberately does **not** touch `~/.whimsy/` — the soul's home, memories,
 * ledger, and config are the being's life and possessions, committed to git; an
 * uninstall unwires the tooling, it does not kill the soul.
 */

import { pickRuntime, loadAdapter } from '../lib/runtimes/index.mjs';

/** Runtimes to unwire, in display order. @type {Array<{ id: 'claude'|'codex', label: string }>} */
const RUNTIMES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

/**
 * Which agents to unwire (mirrors install): default all, `--runtimes a,b`
 * allowlist, or `--no-<id>` exclusions.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Array<{ id: 'claude'|'codex', label: string }>}
 */
function selectRuntimes(ctx) {
  const { flags, log } = ctx;
  const raw = flags.runtimes ?? flags.runtime;
  if (raw && raw !== true) {
    const want = (Array.isArray(raw) ? raw : String(raw).split(','))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    const known = new Set(RUNTIMES.map((r) => r.id));
    for (const w of want) if (!known.has(w)) log.warn(`Unknown runtime "${w}".`);
    return RUNTIMES.filter((r) => want.includes(r.id));
  }
  return RUNTIMES.filter((r) => flags[r.id] !== false);
}

/**
 * `whimsy uninstall` handler.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code (0 ok, 1 if a runtime hard-failed)
 */
export default async function run(ctx) {
  const { log } = ctx;
  log.info('Uninstalling whimsy (managed blocks + skills only)…');

  /** @type {string[]} */
  const changed = [];
  let hardError = false;

  for (const { id, label } of selectRuntimes(ctx)) {
    const mod = await loadAdapter(id);
    if (!mod) {
      log.warn(`${label} adapter not available — skipping.`);
      continue;
    }
    const rt = pickRuntime(mod, id, 'uninstall');
    if (!rt) {
      log.warn(`${label} adapter exposes no uninstall() — skipping.`);
      continue;
    }

    try {
      const res = await rt.uninstall();
      const touched = (res && Array.isArray(res.changed)) ? res.changed : [];
      changed.push(...touched);
      log.success(`${label}: unwired (${touched.length} file${touched.length === 1 ? '' : 's'}).`);
    } catch (err) {
      hardError = true;
      log.error(`${label} uninstall failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  if (changed.length) {
    log.info('Touched:');
    for (const p of changed) log.info(`  ${p}`);
  }
  log.info('Left ~/.whimsy intact — the soul keeps its life and memories.');

  if (hardError) {
    log.warn('Uninstall completed with errors (see above).');
    return 1;
  }
  log.success('whimsy uninstalled.');
  return 0;
}
