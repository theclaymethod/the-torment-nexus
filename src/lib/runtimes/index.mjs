/**
 * Runtime adapter resolution shared by the setup commands. Each adapter
 * (claude.mjs, codex.mjs) may export its Runtime object as a default, a named
 * export, or at module level; these helpers tolerate that and a not-yet-present
 * adapter module, so callers don't each re-implement the probing.
 *
 * @module lib/runtimes
 */

/**
 * Pull a Runtime-like object out of an adapter module however it exports it,
 * requiring `method` to be callable on it.
 * @param {Record<string, any>} mod the imported adapter module
 * @param {string} id runtime id (also a possible named export)
 * @param {string} method method that must be present + callable
 * @returns {Record<string, any>|null}
 */
export function pickRuntime(mod, id, method) {
  const candidates = [mod?.default, mod?.[id], mod?.runtime, mod];
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof c[method] === 'function') return c;
  }
  return null;
}

/**
 * Dynamically import a runtime adapter, tolerating a not-yet-present module
 * (returns null rather than throwing on ERR_MODULE_NOT_FOUND).
 * @param {'claude'|'codex'} id
 * @returns {Promise<Record<string, any>|null>}
 */
export async function loadAdapter(id) {
  try {
    return await import(`./${id}.mjs`);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}
