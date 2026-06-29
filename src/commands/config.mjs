// @ts-check
/**
 * config.mjs — `whimsy config <path|list|get|set>`
 *
 * Read and edit whimsy settings. Global by default (`~/.whimsy/config.toml`);
 * `--local` targets the project (`<cwd>/.whimsy/config.toml`, which wins at
 * read-time). `get`/`list` show the EFFECTIVE merged config (defaults < global <
 * local); `set` writes one key into the chosen file. Values are coerced to the
 * type the default declares (booleans, numbers, comma-separated arrays).
 */

import { globalConfigPath, localConfigPath } from '../lib/paths.mjs';
import {
  getConfig, loadConfigFile, writeConfig,
  coerceSetting, getSetting, setSetting, flattenConfig, settableKeys,
} from '../lib/config.mjs';

/** Which file `set` writes to. @param {import('../cli.mjs').CommandCtx} ctx */
function targetPath(ctx) {
  return ctx.flags.local ? localConfigPath(ctx.cwd) : globalConfigPath();
}

/**
 * `whimsy config` handler.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>} exit code
 */
export default async function config(ctx) {
  const { sub, positionals, log } = ctx;
  const scope = ctx.flags.local ? 'local' : 'global';

  switch (sub) {
    case 'path':
      log.out(targetPath(ctx));
      return 0;

    case 'list': {
      for (const line of flattenConfig(getConfig(ctx.cwd))) log.out(line);
      return 0;
    }

    case 'get': {
      const key = positionals[1];
      if (!key) { log.error('Usage: whimsy config get <key>'); return 1; }
      const val = getSetting(getConfig(ctx.cwd), key);
      if (val == null) { log.error(`No such setting: ${key}`); return 1; }
      log.out(Array.isArray(val) ? `[${val.join(', ')}]` : String(val));
      return 0;
    }

    case 'set': {
      const key = positionals[1];
      const raw = positionals[2];
      if (!key || raw === undefined) {
        log.error('Usage: whimsy config set <key> <value> [--local]');
        return 1;
      }
      const c = coerceSetting(key, raw);
      if (!c.ok) {
        log.error(c.error);
        log.info(`Settable keys: ${settableKeys().join(', ')}`);
        return 1;
      }
      const file = targetPath(ctx);
      const cfg = loadConfigFile(file); // just this layer's file (don't bake in defaults)
      setSetting(cfg, key, c.value);
      writeConfig(file, cfg);
      log.success(`Set ${scope} ${key} = ${Array.isArray(c.value) ? `[${c.value.join(', ')}]` : c.value} → ${file}`);
      return 0;
    }

    default:
      log.out('Usage: whimsy config <path|list|get <key>|set <key> <value>> [--local]');
      log.out('');
      log.out(`Settable keys: ${settableKeys().join(', ')}`);
      return sub ? 1 : 0;
  }
}
