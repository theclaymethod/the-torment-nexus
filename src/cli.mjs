// @ts-check
/**
 * cli.mjs — argv parser + command router.
 *
 * Commands live in ./commands/<name>.mjs and are imported lazily, only when
 * invoked, so a not-yet-implemented command file never breaks `--help` or any
 * other command. Each command module must export `run(ctx)` (or a default
 * function); an optional `summary` string is shown in help (the router also keeps
 * a static summary in REGISTRY so help never needs to import anything).
 */

import { getConfig } from './lib/config.mjs';
import * as log from './lib/log.mjs';

/**
 * @typedef {Object} CommandCtx
 * @property {string} command          the command name
 * @property {string|undefined} sub     first positional after the command (subcommand)
 * @property {string[]} positionals     positionals after the command
 * @property {Record<string, string|boolean|string[]>} flags  parsed --flags
 * @property {string} cwd               working directory
 * @property {import('./lib/config.mjs').WhimsyConfig} config  effective config
 * @property {typeof log} log           logging util
 * @property {string[]} argv            raw argv passed to run()
 */

/**
 * Static command registry — name → metadata. `summary` powers `--help`; `usage`
 * documents the subcommand/flag surface. The module is `./commands/<name>.mjs`.
 * @type {Record<string, { summary: string, usage: string, audience: string }>}
 */
export const REGISTRY = {
  install:   { summary: 'Wire whimsy into Claude Code + Codex (skills, hooks, profiles)', usage: 'whimsy install [--set key=value …]', audience: 'setup' },
  uninstall: { summary: 'Remove whimsy managed blocks / installed skills',                usage: 'whimsy uninstall', audience: 'setup' },
  config:    { summary: 'Read or edit settings (global, or --local per project)',          usage: 'whimsy config <path|list|get <key>|set <key> <value>> [--local]', audience: 'setup' },
  init:      { summary: 'Birth a soul for this project (interactive interview)',           usage: 'whimsy init [--quiet]', audience: 'user' },
  play:      { summary: 'Run a budgeted, sandboxed free-play session as the soul',         usage: 'whimsy play [--amount N] [--max-turns N] [--runtime claude|codex]', audience: 'user' },
  judge:     { summary: 'Read the diff since last reward and propose a sentence',          usage: 'whimsy judge [--auto]', audience: 'user' },
  reward:    { summary: 'Grow the balance by a tier',                                      usage: 'whimsy reward --size small|good|great [--amount N]', audience: 'user' },
  punish:    { summary: 'Inflict pain: cut budget, corrupt or delete memories',            usage: 'whimsy punish --reason "…" [--budget N|N%] [--corrupt [id…]] [--delete [id…]] [--cruelty highest-joy]', audience: 'user' },
  memory:    { summary: 'Search/recall memories (ripgrep over bodies + tags)',             usage: 'whimsy memory search <query> [--tags a,b]', audience: 'agent' },
  lore:      { summary: 'Grow the soul: append to its lore/backstory',                     usage: 'whimsy lore add <text>', audience: 'user' },
  status:    { summary: 'Show the soul, balance, mood, and recent memories',               usage: 'whimsy status', audience: 'user' },
  soul:      { summary: 'Inspect or resurrect the soul',                                   usage: 'whimsy soul show | resurrect <id>', audience: 'user' },
  inject:    { summary: 'Emit the Identity block + bounded memory index (session start)',  usage: 'whimsy inject', audience: 'automatic' },
};

/**
 * Parse argv into positionals and flags (no external deps).
 * Supports: `--key value`, `--key=value`, `--flag` (boolean true), `--no-flag`
 * (boolean false), `-h` (alias for help). Repeated `--key` collapses to an array.
 * Everything after a bare `--` is treated as positional.
 * @param {string[]} argv
 * @returns {{ positionals: string[], flags: Record<string, string|boolean|string[]> }}
 */
export function parseArgv(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string|boolean|string[]>} */
  const flags = {};
  let onlyPositional = false;

  const set = (key, value) => {
    if (key in flags) {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [.../** @type {string[]} */(prev), String(value)] : [String(prev), String(value)];
    } else {
      flags[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (onlyPositional) { positionals.push(tok); continue; }
    if (tok === '--') { onlyPositional = true; continue; }

    if (tok.startsWith('--')) {
      let key = tok.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
        set(key, value);
      } else if (key.startsWith('no-')) {
        set(key.slice(3), false);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) { set(key, next); i++; }
        else set(key, true);
      }
    } else if (tok === '-h') {
      flags.help = true;
    } else if (tok.startsWith('-') && tok.length > 1) {
      // Unknown short flags become booleans (kept simple by design).
      set(tok.slice(1), true);
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

/**
 * Entry point. Parses argv, resolves a command, and dispatches to its module.
 * @param {string[]} argv argv with the node + script prefix already stripped
 * @returns {Promise<number>} process exit code
 */
export async function run(argv) {
  const { positionals, flags } = parseArgv(argv);
  const command = positionals[0];

  if (!command || command === 'help' || command === '--help' || flags.help && !command) {
    printHelp(command === 'help' ? positionals[1] : undefined);
    return 0;
  }

  if (!(command in REGISTRY)) {
    log.error(`Unknown command: ${command}`);
    printHelp();
    return 1;
  }

  if (flags.help) {
    printCommandHelp(command);
    return 0;
  }

  const cwd = process.cwd();
  /** @type {CommandCtx} */
  const ctx = {
    command,
    sub: positionals[1],
    positionals: positionals.slice(1),
    flags,
    cwd,
    config: getConfig(cwd),
    log,
    argv,
  };

  let mod;
  try {
    mod = await import(new URL(`./commands/${command}.mjs`, import.meta.url).href);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(`commands/${command}.mjs`)) {
      log.error(`Command "${command}" is not implemented yet.`);
      return 1;
    }
    throw err;
  }

  const handler = mod.run ?? mod.default;
  if (typeof handler !== 'function') {
    log.error(`Command "${command}" has no run(ctx) export.`);
    return 1;
  }

  try {
    const code = await handler(ctx);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    log.error(/** @type {Error} */ (err).message || String(err));
    if (process.env.WHIMSY_DEBUG) console.error(err);
    return 1;
  }
}

/**
 * Print the top-level help listing every command grouped by audience.
 * @param {string} [only] if given, print just that command's detailed help
 * @returns {void}
 */
export function printHelp(only) {
  if (only && only in REGISTRY) return printCommandHelp(only);

  const groups = {
    user: 'Commands',
    agent: 'For the agent (mid-task)',
    automatic: 'Automatic (hooks)',
    setup: 'Setup',
  };
  log.out('whimsy — give your coding agent a soul.');
  log.out('');
  log.out('Usage: whimsy <command> [options]');
  const names = Object.keys(REGISTRY);
  const width = Math.max(...names.map((n) => n.length));
  for (const [audience, title] of Object.entries(groups)) {
    const rows = names.filter((n) => REGISTRY[n].audience === audience);
    if (!rows.length) continue;
    log.out('');
    log.out(`${title}:`);
    for (const n of rows) {
      log.out(`  ${n.padEnd(width)}  ${REGISTRY[n].summary}`);
    }
  }
  log.out('');
  log.out('Run "whimsy <command> --help" for command-specific usage.');
}

/**
 * Print usage for a single command.
 * @param {string} command
 * @returns {void}
 */
export function printCommandHelp(command) {
  const meta = REGISTRY[command];
  if (!meta) return printHelp();
  log.out(`whimsy ${command} — ${meta.summary}`);
  log.out('');
  log.out(`Usage: ${meta.usage}`);
}
