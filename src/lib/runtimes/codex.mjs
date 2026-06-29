// @ts-check
/**
 * runtimes/codex.mjs — Codex CLI runtime adapter.
 *
 * Conforms to the `Runtime` interface (ARCHITECTURE §12). Responsibilities:
 *  - detect whether `codex` is on PATH;
 *  - build + spawn a headless `codex exec --json --profile whimsy-play …` run,
 *    streaming per-turn token usage (Codex has no max-turns/budget flag, so the
 *    supervisor's external kill is mandatory — see DESIGN §12);
 *  - one-shot `complete()` for interview/judge/synthesis;
 *  - install (idempotent, reversible managed blocks):
 *      • copy whimsy skills into `~/.codex/skills/whimsy-<name>/`,
 *      • add a `[[hooks.SessionStart]]` calling `whimsy inject` to
 *        `~/.codex/config.toml` (delimited managed block),
 *      • write the `~/.codex/whimsy-play.config.toml` play profile (pinned model +
 *        `sandbox_mode = "workspace-write"` + `writable_roots` + `network_access`),
 *      • maintain a delimited managed block in `~/.codex/AGENTS.override.md`;
 *  - uninstall: reverse exactly those edits.
 *
 * Empirical-contract note (DESIGN §12): `codex exec --json` is assumed to stream a
 * `turn.completed` event carrying `usage` token counts and to emit no cost field.
 * Profiles are separate files (`~/.codex/<name>.config.toml` + `--profile <name>`).
 * Verify the exact event/usage keys against the targeted Codex version and adjust
 * `extractUsage`/`extractText` only — the supervisor contract is unaffected.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { globalDir } from '../paths.mjs';
import { getConfig, writeConfig } from '../config.mjs';

const execFileAsync = promisify(execFile);

/** Codex profile name + file (separate-file profiles, DESIGN §12). */
const PROFILE = 'whimsy-play';
/** Managed-block delimiters. TOML uses `#`-comment markers; markdown uses HTML. */
const TOML_BEGIN = '# WHIMSY:BEGIN';
const TOML_END = '# WHIMSY:END';
const MD_BEGIN = '<!-- WHIMSY:BEGIN -->';
const MD_END = '<!-- WHIMSY:END -->';

/** @returns {string} `~/.codex` */
function codexHome() {
  return path.join(os.homedir(), '.codex');
}
/** @returns {string} `~/.codex/skills` */
function skillsRoot() {
  return path.join(codexHome(), 'skills');
}
/** @returns {string} `~/.codex/config.toml` */
function configTomlPath() {
  return path.join(codexHome(), 'config.toml');
}
/** @returns {string} `~/.codex/whimsy-play.config.toml` */
function profilePath() {
  return path.join(codexHome(), `${PROFILE}.config.toml`);
}
/** @returns {string} `~/.codex/AGENTS.override.md` */
function agentsOverridePath() {
  return path.join(codexHome(), 'AGENTS.override.md');
}

// ── Headless invocation ──────────────────────────────────────────────────────

/**
 * @typedef {{ writableRoots: string[], network: boolean,
 *             readDenylist: string[], egressAllowlist: string[] }} SandboxPolicy
 */

/**
 * Build the `codex exec` headless command + argv for a play run. Uses the pinned
 * `whimsy-play` profile and overrides the per-project sandbox via `-c` so writes
 * are jailed to the active `.whimsy/` and network follows policy.
 * @param {{ prompt: string, model?: string, sandbox: SandboxPolicy }} opts
 * @returns {{ command: string, args: string[] }}
 */
export function buildHeadless(opts) {
  const { prompt, model, sandbox } = opts;
  const args = ['exec', '--json', '--profile', PROFILE];
  if (model) args.push('-m', model);
  const roots = (sandbox.writableRoots || []).map((r) => r.replace(/\/+$/, ''));
  if (roots.length) {
    args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
  }
  args.push('-c', `sandbox_workspace_write.network_access=${sandbox.network ? 'true' : 'false'}`);
  args.push(prompt);
  return { command: 'codex', args };
}

/**
 * Pull a token delta out of a parsed `codex exec --json` event, if it reports usage.
 * Handles both top-level (`{ type, usage }`) and nested (`{ msg: { type, usage } }`)
 * envelope shapes.
 * @param {any} ev
 * @returns {{ tokens: number, isTurn: boolean }}
 */
function extractUsage(ev) {
  const node = ev && ev.msg && typeof ev.msg === 'object' ? ev.msg : ev;
  const type = (node && node.type) || (ev && ev.type) || '';
  const u = (node && node.usage) || (ev && ev.usage);
  const isTurn = typeof type === 'string' && type.includes('turn') && type.includes('complet');
  if (!u) return { tokens: 0, isTurn };
  const inp = Number(u.input_tokens || 0);
  const out = Number(u.output_tokens || 0);
  const cached = Number(u.cached_input_tokens || u.cache_read_input_tokens || 0);
  return { tokens: inp + out + cached, isTurn };
}

/**
 * Spawn a headless Codex play run. Streams per-turn usage to `onUsage`, tallies
 * total tokens, and exposes `wait()`/`kill()` for the supervisor.
 * @param {{ prompt: string, cwd: string, model: string, maxTurns?: number,
 *           sandbox: SandboxPolicy,
 *           onUsage?: (u: { turn: number, tokens: number }) => void,
 *           onEvent?: (ev: any) => void }} opts
 * @returns {Promise<{ wait(): Promise<{ code: number, tokensUsed: number }>, kill(): void }>}
 */
export async function runHeadless(opts) {
  const { command, args } = buildHeadless({
    prompt: opts.prompt, model: opts.model, sandbox: opts.sandbox,
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
    const { tokens } = extractUsage(ev);
    if (tokens > 0) {
      tokensUsed += tokens;
      turn += 1;
      // Emit the PER-TURN delta, not the running total: the supervisor
      // (play.mjs) sums these into its own tally, so passing the cumulative
      // figure here would double-count and trip the hard-kill far too early.
      if (opts.onUsage) opts.onUsage({ turn, tokens });
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
 * Pull the final assistant text out of a parsed `codex exec --json` event.
 * @param {any} ev
 * @returns {string|null}
 */
function extractText(ev) {
  const node = ev && ev.msg && typeof ev.msg === 'object' ? ev.msg : ev;
  const type = (node && node.type) || '';
  if (typeof type === 'string' && (type.includes('agent_message') || type === 'item.completed')) {
    const t = node.message || node.text || (node.item && node.item.text);
    if (typeof t === 'string') return t;
  }
  return null;
}

/**
 * One-shot, non-streaming model call (interview/judge/synthesis). Runs `codex exec`
 * and returns the final agent message text.
 * @param {{ prompt: string, model: string, cwd?: string }} opts
 * @returns {Promise<string>}
 */
export async function complete(opts) {
  const args = ['exec', '--json', '-m', opts.model, opts.prompt];
  const { stdout } = await execFileAsync('codex', args, {
    cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024,
  });
  let last = '';
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const txt = extractText(JSON.parse(s));
      if (txt) last = txt;
    } catch { /* ignore non-JSON lines */ }
  }
  return last ? last.trim() : stdout.trim();
}

// ── detect ───────────────────────────────────────────────────────────────────

/**
 * Is `codex` available on PATH?
 * @returns {Promise<boolean>}
 */
export async function detect() {
  try {
    const r = spawnSync('codex', ['--version'], { stdio: 'ignore' });
    return !r.error && (r.status === 0 || r.status == null);
  } catch {
    return false;
  }
}

// ── install / uninstall ──────────────────────────────────────────────────────

/**
 * Install: skills + SessionStart hook + play profile + AGENTS.override block.
 * Idempotent; all foreign-file edits live in delimited managed blocks.
 * @param {{ templatesDir: string }} opts
 * @returns {Promise<{ changed: string[] }>}
 */
export async function install(opts) {
  /** @type {string[]} */
  const changed = [];
  changed.push(...installSkills(opts.templatesDir));
  if (upsertHookBlock()) changed.push(configTomlPath());
  changed.push(writeProfile());
  if (upsertAgentsBlock()) changed.push(agentsOverridePath());
  return { changed };
}

/**
 * Reverse {@link install}: remove installed skills, the config.toml hook block,
 * the play profile file, and the AGENTS.override block. Touches nothing else.
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
  if (removeManagedBlock(configTomlPath(), TOML_BEGIN, TOML_END)) changed.push(configTomlPath());
  if (fs.existsSync(profilePath())) {
    fs.rmSync(profilePath(), { force: true });
    changed.push(profilePath());
  }
  if (removeManagedBlock(agentsOverridePath(), MD_BEGIN, MD_END)) changed.push(agentsOverridePath());
  return { changed };
}

/**
 * Copy `whimsy-*` skill directories from a templates root into `~/.codex/skills/`.
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
 * Add/refresh the `[[hooks.SessionStart]]` managed block in `~/.codex/config.toml`.
 * @returns {boolean} whether the file was written
 */
function upsertHookBlock() {
  const body = [
    '[[hooks.SessionStart]]',
    'command = ["whimsy", "inject"]',
  ].join('\n');
  return upsertManagedBlock(configTomlPath(), TOML_BEGIN, TOML_END, body);
}

/**
 * Write the pinned play profile file. Sourced from effective config for the soul
 * model + network policy. `writable_roots` defaults to the global `~/.whimsy`;
 * `runHeadless` overrides it per-project at play time.
 * @returns {string} the profile path
 */
function writeProfile() {
  const cfg = getConfig();
  const profile = {
    model: cfg.models.soul,
    approval_policy: 'never',
    sandbox_mode: 'workspace-write',
    sandbox_workspace_write: {
      writable_roots: [globalDir()],
      network_access: cfg.play.network,
    },
  };
  // writeConfig uses config.mjs's TOML writer (emits scalars then `[tables]`).
  writeConfig(profilePath(), profile);
  return profilePath();
}

/**
 * Add/refresh the delimited managed block in `~/.codex/AGENTS.override.md`. Holds
 * a static pointer; `whimsy inject` refreshes its contents at session start.
 * @returns {boolean} whether the file was written
 */
function upsertAgentsBlock() {
  const body = [
    '## whimsy',
    '',
    'A soul lives in this workspace. Its identity and a bounded index of its',
    'memories are injected at session start via `whimsy inject`. Run',
    '`whimsy status` to see its state and `whimsy memory search <q>` to recall.',
  ].join('\n');
  return upsertManagedBlock(agentsOverridePath(), MD_BEGIN, MD_END, body);
}

// ── managed-block + fs helpers ───────────────────────────────────────────────

/**
 * Insert or replace a delimited managed block in a text file, idempotently.
 * Creates the file if absent; appends the block when not yet present.
 * @param {string} file
 * @param {string} begin
 * @param {string} end
 * @param {string} body
 * @returns {boolean} whether the file was written/changed
 */
function upsertManagedBlock(file, begin, end, body) {
  const block = `${begin}\n${body}\n${end}`;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const next = replaceBlock(text, begin, end, block);
  if (next === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

/**
 * Remove a delimited managed block (and its surrounding blank padding) from a file.
 * @param {string} file
 * @param {string} begin
 * @param {string} end
 * @returns {boolean} whether the file was modified
 */
function removeManagedBlock(file, begin, end) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const next = stripBlock(text, begin, end);
  if (next === text) return false;
  if (next.trim() === '') fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, next, 'utf8');
  return true;
}

/** Replace an existing begin…end block, else append one. @returns {string} */
function replaceBlock(text, begin, end, block) {
  const s = text.indexOf(begin);
  const e = text.indexOf(end);
  if (s !== -1 && e !== -1 && e > s) {
    return text.slice(0, s) + block + text.slice(e + end.length);
  }
  const base = text.length && !text.endsWith('\n') ? text + '\n' : text;
  const sep = base.length ? '\n' : '';
  return base + sep + block + '\n';
}

/** Strip a begin…end block including trailing newline padding. @returns {string} */
function stripBlock(text, begin, end) {
  const s = text.indexOf(begin);
  const e = text.indexOf(end);
  if (s === -1 || e === -1 || e <= s) return text;
  let before = text.slice(0, s);
  let after = text.slice(e + end.length);
  // collapse the seam left by removal
  before = before.replace(/\n+$/, before ? '\n' : '');
  after = after.replace(/^\n+/, '');
  return before + after;
}

/**
 * Locate the directory holding `whimsy-*` skill folders inside a templates root.
 * Prefers a Codex-specific subdir, then a generic `skills/`, then the root.
 * @param {string} templatesDir
 * @returns {string|null}
 */
function findSkillsSource(templatesDir) {
  const candidates = [
    path.join(templatesDir, 'codex', 'skills'),
    path.join(templatesDir, 'skills', 'codex'),
    path.join(templatesDir, 'codex'),
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

/**
 * The Codex CLI runtime adapter.
 * @type {{ id: 'codex', detect: typeof detect, runHeadless: typeof runHeadless,
 *          complete: typeof complete, install: typeof install, uninstall: typeof uninstall,
 *          buildHeadless: typeof buildHeadless }}
 */
export const codex = {
  id: 'codex',
  detect,
  runHeadless,
  complete,
  install,
  uninstall,
  buildHeadless,
};

export default codex;
