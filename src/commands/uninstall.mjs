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

/** Runtimes to unwire, in display order. @type {Array<{ id: 'claude'|'codex', label: string }>} */
const RUNTIMES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

/**
 * Pull the Runtime object out of an adapter module however it was exported.
 * @param {Record<string, any>} mod imported adapter module
 * @param {string} id runtime id (also a possible named export)
 * @param {'install'|'uninstall'} method method that must be callable
 * @returns {Record<string, any>|null}
 */
function pickRuntime(mod, id, method) {
  const candidates = [mod?.default, mod?.[id], mod?.runtime, mod];
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof c[method] === 'function') return c;
  }
  return null;
}

/**
 * Dynamically import a runtime adapter, tolerating an absent module by returning
 * null rather than throwing.
 * @param {'claude'|'codex'} id
 * @returns {Promise<Record<string, any>|null>}
 */
async function loadAdapter(id) {
  try {
    return await import(`../lib/runtimes/${id}.mjs`);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
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

  for (const { id, label } of RUNTIMES) {
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
