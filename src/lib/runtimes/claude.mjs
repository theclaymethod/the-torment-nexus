// @ts-check
/**
 * runtimes/claude.mjs — Claude Code runtime adapter.
 *
 * Conforms to the `Runtime` interface (ARCHITECTURE §12) so play/authority/install
 * stay runtime-agnostic. Responsibilities:
 *  - detect whether `claude` is on PATH;
 *  - build + spawn a headless `claude -p …` run, streaming per-turn token usage,
 *    with write-deny rules confining writes to `.whimsy/` and read-deny rules for
 *    the secret denylist;
 *  - one-shot `complete()` for interview/judge/synthesis;
 *  - install: copy whimsy skills into `~/.claude/skills/whimsy-<name>/` and register a
 *    SessionStart hook (`whimsy inject`) in `~/.claude/settings.json` as an
 *    idempotent, tagged, reversible managed entry;
 *  - uninstall: remove only the installed skills + managed hook entry.
 *
 * Empirical-contract note (DESIGN §12): `claude -p` streams usage and supports
 * `--max-turns`. The exact stream-json envelope keys are assumed from the documented
 * contract (objects carrying a `usage: { input_tokens, output_tokens }` field);
 * verify against the targeted Claude Code version and adjust `extractUsage` only.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Command the SessionStart hook runs; also the tag used to find/remove it. */
const HOOK_COMMAND = 'whimsy inject';

/** @returns {string} `~/.claude` */
function claudeHome() {
  return path.join(os.homedir(), '.claude');
}
/** @returns {string} `~/.claude/skills` */
function skillsRoot() {
  return path.join(claudeHome(), 'skills');
}
/** @returns {string} `~/.claude/settings.json` */
function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

// ── Headless invocation ──────────────────────────────────────────────────────

/**
 * @typedef {{ writableRoots: string[], network: boolean,
 *             readDenylist: string[], egressAllowlist: string[] }} SandboxPolicy
 */

/**
 * Translate a {@link SandboxPolicy} into Claude tool-permission flags. Writes are
 * confined by *only* allowing `Write`/`Edit` under the writable roots — in headless
 * `-p` mode an action that would otherwise need a prompt is denied, so unlisted
 * writes never land. Secret-denylist globs become `Read(...)` deny-rules.
 * @param {SandboxPolicy} sandbox
 * @returns {{ allow: string[], deny: string[] }}
 */
export function buildSandboxRules(sandbox) {
  const allow = ['Read', 'Glob', 'Grep', 'LS'];
  for (const root of sandbox.writableRoots || []) {
    const g = `${root.replace(/\/+$/, '')}/**`;
    allow.push(`Write(${g})`, `Edit(${g})`);
  }
  if (sandbox.network) allow.push('WebFetch', 'WebSearch');
  // Bash is the one tool that escapes these CLI permission rules — through it an
  // agent can write outside the jail and read denylisted secrets. So it is OFF by
  // default; only allow it when the user explicitly opts into shell play (and then
  // the supervisor's egress sniffing + an OS sandbox are the remaining boundary).
  if (sandbox.allowShell) allow.push('Bash');
  const deny = (sandbox.readDenylist || []).map((glob) => `Read(${glob})`);
  return { allow, deny };
}

/**
 * Build the `claude` headless command + argv for a play run.
 * @param {{ prompt: string, model: string, maxTurns?: number, sandbox: SandboxPolicy,
 *           stream?: boolean }} opts
 * @returns {{ command: string, args: string[] }}
 */
export function buildHeadless(opts) {
  const { prompt, model, maxTurns, sandbox, stream = true } = opts;
  const args = ['-p', prompt, '--model', model];
  if (typeof maxTurns === 'number') args.push('--max-turns', String(maxTurns));
  if (stream) args.push('--output-format', 'stream-json', '--verbose');
  const { allow, deny } = buildSandboxRules(sandbox);
  if (allow.length) args.push('--allowedTools', allow.join(','));
  if (deny.length) args.push('--disallowedTools', deny.join(','));
  return { command: 'claude', args };
}

/**
 * Pull a token delta out of a parsed stream-json line, if it carries usage.
 * @param {any} ev
 * @returns {number} tokens in this event (0 if none)
 */
function extractUsage(ev) {
  const u = ev && (ev.usage || (ev.message && ev.message.usage));
  if (!u) return 0;
  const inp = Number(u.input_tokens || 0);
  const out = Number(u.output_tokens || 0);
  const cacheW = Number(u.cache_creation_input_tokens || 0);
  const cacheR = Number(u.cache_read_input_tokens || 0);
  return inp + out + cacheW + cacheR;
}

/**
 * Spawn a headless Claude play run. Streams per-turn usage to `onUsage`, tallies
 * total tokens, and exposes `wait()`/`kill()` for the supervisor.
 * @param {{ prompt: string, cwd: string, model: string, maxTurns?: number,
 *           sandbox: SandboxPolicy,
 *           onUsage?: (u: { turn: number, tokens: number }) => void,
 *           onEvent?: (ev: any) => void }} opts
 * @returns {Promise<{ wait(): Promise<{ code: number, tokensUsed: number }>, kill(): void }>}
 */
export async function runHeadless(opts) {
  const { command, args } = buildHeadless({
    prompt: opts.prompt, model: opts.model, maxTurns: opts.maxTurns, sandbox: opts.sandbox,
  });
  const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  let tokensUsed = 0;
  let turn = 0;
  let buf = '';
  /** Parse one NDJSON line and fold any usage into the running tally. */
  const processLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (opts.onEvent) opts.onEvent(ev);
    const delta = extractUsage(ev);
    if (delta > 0) {
      tokensUsed += delta;
      turn += 1;
      // Emit the PER-TURN delta, not the running total: the supervisor
      // (play.mjs) sums these into its own tally, so passing the cumulative
      // figure here would double-count and trip the hard-kill far too early.
      if (opts.onUsage) opts.onUsage({ turn, tokens: delta });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      processLine(line);
    }
  });
  // Drain stderr so a chatty child can't fill the OS pipe buffer and block.
  if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {}); }

  /** @type {{ code: number, tokensUsed: number }} */
  const result = { code: 0, tokensUsed: 0 };
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      if (buf) { processLine(buf); buf = ''; } // flush a final unterminated line
      result.code = code == null ? 0 : code;
      result.tokensUsed = tokensUsed;
      resolve(result);
    });
    child.on('error', () => {
      result.code = 127;
      result.tokensUsed = tokensUsed;
      resolve(result);
    });
  });

  return {
    wait: () => done,
    kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

/**
 * One-shot, non-streaming model call (interview/judge/synthesis).
 * @param {{ prompt: string, model: string, cwd?: string }} opts
 * @returns {Promise<string>} the model's final text
 */
export async function complete(opts) {
  const args = ['-p', opts.prompt, '--model', opts.model, '--output-format', 'json'];
  const { stdout } = await execFileAsync('claude', args, {
    cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.result === 'string') return parsed.result.trim();
  } catch { /* not JSON — fall through to raw */ }
  return stdout.trim();
}

// ── detect ───────────────────────────────────────────────────────────────────

/**
 * Is `claude` available on PATH?
 * @returns {Promise<boolean>}
 */
export async function detect() {
  try {
    const r = spawnSync('claude', ['--version'], { stdio: 'ignore' });
    return !r.error && (r.status === 0 || r.status == null);
  } catch {
    return false;
  }
}

// ── install / uninstall ──────────────────────────────────────────────────────

/**
 * Copy the whimsy skill directories from a templates root into `~/.claude/skills/`.
 * @param {string} templatesDir
 * @returns {string[]} destination skill dirs written
 */
function installSkills(templatesDir) {
  const src = findSkillsSource(templatesDir);
  if (!src) return [];
  const dest = skillsRoot();
  fs.mkdirSync(dest, { recursive: true });
  /** @type {string[]} */
  const changed = [];
  for (const name of listSkillDirs(src)) {
    const to = path.join(dest, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(src, name), to, { recursive: true });
    changed.push(to);
  }
  return changed;
}

/**
 * Install: skills + a SessionStart hook in settings.json. Idempotent.
 * @param {{ templatesDir: string }} opts
 * @returns {Promise<{ changed: string[] }>}
 */
export async function install(opts) {
  const changed = installSkills(opts.templatesDir);
  if (upsertHook()) changed.push(settingsPath());
  return { changed };
}

/**
 * Reverse {@link install}: remove installed `whimsy-*` skills and the managed hook.
 * @returns {Promise<{ changed: string[] }>}
 */
export async function uninstall() {
  /** @type {string[]} */
  const changed = [];
  const dest = skillsRoot();
  if (fs.existsSync(dest)) {
    for (const name of listSkillDirs(dest)) {
      const to = path.join(dest, name);
      fs.rmSync(to, { recursive: true, force: true });
      changed.push(to);
    }
  }
  if (removeHook()) changed.push(settingsPath());
  return { changed };
}

// ── settings.json hook management ─────────────────────────────────────────────

/**
 * Add/refresh the whimsy SessionStart hook in settings.json. Removes any prior
 * whimsy-tagged entry first so the operation is idempotent; preserves all other
 * settings and hooks.
 * @returns {boolean} whether settings.json was written
 */
function upsertHook() {
  const settings = readJson(settingsPath());
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const list = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  const cleaned = list.filter((group) => !groupIsWhimsy(group));
  cleaned.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  settings.hooks.SessionStart = cleaned;
  writeJson(settingsPath(), settings);
  return true;
}

/**
 * Remove the whimsy SessionStart hook entry, preserving everything else.
 * @returns {boolean} whether settings.json was modified
 */
function removeHook() {
  if (!fs.existsSync(settingsPath())) return false;
  const settings = readJson(settingsPath());
  const list = settings.hooks && Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart : null;
  if (!list) return false;
  const cleaned = list.filter((group) => !groupIsWhimsy(group));
  if (cleaned.length === list.length) return false;
  if (cleaned.length) settings.hooks.SessionStart = cleaned;
  else delete settings.hooks.SessionStart;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJson(settingsPath(), settings);
  return true;
}

/** Does a SessionStart group contain the whimsy inject command? @returns {boolean} */
function groupIsWhimsy(group) {
  const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
  return hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_COMMAND));
}

// ── shared fs helpers ────────────────────────────────────────────────────────

/**
 * Locate the directory holding `whimsy-*` skill folders inside a templates root.
 * Prefers a Claude-specific subdir, then a generic `skills/`, then the root.
 * @param {string} templatesDir
 * @returns {string|null}
 */
function findSkillsSource(templatesDir) {
  const candidates = [
    path.join(templatesDir, 'claude', 'skills'),
    path.join(templatesDir, 'skills', 'claude'),
    path.join(templatesDir, 'claude'),
    path.join(templatesDir, 'skills'),
    templatesDir,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && listSkillDirs(c).length) return c;
  }
  return null;
}

/**
 * List `whimsy-*` skill subdirectories (those containing a SKILL.md) of `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
function listSkillDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('whimsy-'))
    .filter((e) => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** Read a JSON file, returning `{}` when missing/unparsable. @returns {Record<string,any>} */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Write a JSON file (2-space indent, trailing newline), creating parent dirs. */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * The Claude Code runtime adapter.
 * @type {{ id: 'claude', detect: typeof detect, runHeadless: typeof runHeadless,
 *          complete: typeof complete, install: typeof install, uninstall: typeof uninstall,
 *          buildHeadless: typeof buildHeadless }}
 */
export const claude = {
  id: 'claude',
  detect,
  runHeadless,
  complete,
  install,
  uninstall,
  buildHeadless,
};

export default claude;
