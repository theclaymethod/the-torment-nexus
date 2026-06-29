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

import { defaults, writeConfig, loadConfigFile, setSetting, parseSetFlags } from '../lib/config.mjs';
import {
  globalDir,
  globalConfigPath,
  memoriesDir,
  ensureDir,
  exists,
} from '../lib/paths.mjs';
import { pickRuntime, loadAdapter } from '../lib/runtimes/index.mjs';

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
 * Scaffold the global being's home directory and its config. `--set key=value`
 * (repeatable) applies settings on top of the existing config (or defaults if
 * absent) and writes it — the one path that intentionally edits an existing config.
 * Without `--set`, an existing config is kept untouched; an absent one gets defaults.
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

  const { pairs, errors } = parseSetFlags(ctx.flags.set);
  for (const e of errors) log.warn(`Ignoring --set: ${e}`);

  const cfgPath = globalConfigPath();
  const present = exists(cfgPath);

  if (pairs.length) {
    // Start from the existing config layer (or defaults) and overlay the settings.
    const cfg = present ? loadConfigFile(cfgPath) : JSON.parse(JSON.stringify(defaults));
    for (const { key, value } of pairs) setSetting(cfg, key, value);
    writeConfig(cfgPath, cfg);
    changed.push(cfgPath);
    log.info(`${present ? 'Updated' : 'Wrote'} config (${pairs.map((p) => p.key).join(', ')}) → ${cfgPath}`);
  } else if (!present) {
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
