// @ts-check
/**
 * install.mjs — `whimsy install`.
 *
 * System-level wiring (DESIGN §10). Idempotent: every edit it makes uses
 * delimited managed blocks (owned by the runtime adapters) so `whimsy uninstall`
 * reverses cleanly. It:
 *   1. scaffolds the global being's home (`~/.whimsy/` + a default `config.toml`),
 *   2. wires each runtime via its adapter — `claude.install()` installs the
 *      `whimsy-*` skills + the `SessionStart` hook; `codex.install()` adds the
 *      skills, the `[[hooks.SessionStart]]`, and the `whimsy-play` profile —
 *      handing each adapter the repo's `templates/` dir to copy from.
 *
 * The actual files each adapter touches are its concern; this command only
 * orchestrates and reports the union of what changed.
 */

import { fileURLToPath } from 'node:url';

import { defaults, writeConfig } from '../lib/config.mjs';
import {
  globalDir,
  globalConfigPath,
  memoriesDir,
  ensureDir,
  exists,
} from '../lib/paths.mjs';

/** Runtimes to wire, in display order. @type {Array<{ id: 'claude'|'codex', label: string }>} */
const RUNTIMES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

/**
 * Resolve the repo's `templates/` directory (sibling of `src/`).
 * @returns {string} absolute path to `templates/`
 */
function templatesDir() {
  return fileURLToPath(new URL('../../templates/', import.meta.url));
}

/**
 * Pull the {@link import('../lib/runtimes/claude.mjs')} Runtime object out of an
 * adapter module however it chose to export it (default, named, or module-level).
 * @param {Record<string, any>} mod the imported adapter module
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
 * Dynamically import a runtime adapter, tolerating a not-yet-present module
 * (parallel development) by returning null rather than throwing.
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
 * Scaffold the global being's home directory and a default config (if absent).
 * Never overwrites an existing config — the user's edits are sacred.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {string[]} paths created/written
 */
function scaffoldGlobal(ctx) {
  const { log } = ctx;
  /** @type {string[]} */
  const changed = [];
  const dir = globalDir();

  if (!exists(dir)) {
    ensureDir(dir);
    changed.push(dir);
  }
  // The global soul's life (memories) lives alongside it; birth fills it in.
  ensureDir(memoriesDir(dir));

  const cfgPath = globalConfigPath();
  if (!exists(cfgPath)) {
    writeConfig(cfgPath, /** @type {Record<string, any>} */ (defaults));
    changed.push(cfgPath);
    log.info(`Wrote default config → ${cfgPath}`);
  } else {
    log.info(`Kept existing config → ${cfgPath}`);
  }
  return changed;
}

/**
 * `whimsy install` handler.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code (0 ok, 1 if a runtime hard-failed)
 */
export default async function run(ctx) {
  const { log } = ctx;
  log.info('Installing whimsy…');

  /** @type {string[]} */
  const changed = [];
  let hardError = false;

  // 1. Global being scaffold.
  try {
    changed.push(...scaffoldGlobal(ctx));
  } catch (err) {
    hardError = true;
    log.error(`Failed to scaffold ${globalDir()}: ${/** @type {Error} */ (err).message}`);
  }

  // 2. Runtime wiring.
  const tpl = templatesDir();
  if (!exists(tpl)) {
    log.warn(`Templates dir not found (${tpl}); runtime adapters may have nothing to copy.`);
  }

  for (const { id, label } of RUNTIMES) {
    const mod = await loadAdapter(id);
    if (!mod) {
      log.warn(`${label} adapter not available yet — skipping.`);
      continue;
    }
    const rt = pickRuntime(mod, id, 'install');
    if (!rt) {
      log.warn(`${label} adapter exposes no install() — skipping.`);
      continue;
    }

    let available = true;
    if (typeof rt.detect === 'function') {
      try {
        available = await rt.detect();
      } catch {
        available = false;
      }
    }
    if (!available) {
      log.info(`${label} not detected on PATH — wiring it anyway so it's ready once installed.`);
    }

    try {
      const res = await rt.install({ templatesDir: tpl });
      const touched = (res && Array.isArray(res.changed)) ? res.changed : [];
      changed.push(...touched);
      log.success(`${label}: wired (${touched.length} file${touched.length === 1 ? '' : 's'}).`);
    } catch (err) {
      hardError = true;
      log.error(`${label} install failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  // 3. Report.
  if (changed.length) {
    log.info('Touched:');
    for (const p of changed) log.info(`  ${p}`);
  }
  if (hardError) {
    log.warn('Install completed with errors (see above).');
    return 1;
  }
  log.success('whimsy installed. New sessions will greet the soul on start.');
  return 0;
}
