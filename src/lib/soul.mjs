// @ts-check
/**
 * soul.mjs — the persona on disk (`SOUL.md`).
 *
 * Pure I/O + parsing. This module owns the SOUL.md file format: the tiny injected
 * `## Identity` block (name, essence, voice, values, live-state line) and the
 * free-form remainder (origin, lore, history). It can birth a soul (write SOUL.md
 * from synthesized content + author its genesis memory), read/parse it, rewrite
 * the managed `- State:` line, mark it dying, append lore, and resurrect a lost
 * memory from git.
 *
 * Model invocation (the interview + synthesis for a *non-quiet* birth) lives in
 * authority.mjs; this module only consumes its structured output. To stay
 * decoupled from sibling modules that may not be loaded, memory.mjs and
 * authority.mjs are imported dynamically at call time.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  resolveSoul,
  projectDir,
  globalDir,
  soulPath,
  memoryDir,
  memoryBodyPath,
  indexPath,
  exists,
  ensureParent,
} from './paths.mjs';

/**
 * @typedef {Object} Identity
 * @property {string} name      — the soul's name.
 * @property {string} essence   — one-line essence.
 * @property {string} voice     — temperament / how it speaks.
 * @property {string|string[]} values — core values (comma list or array).
 * @property {string} state     — managed live-state line (see {@link formatState}).
 */

/** @typedef {import('./config.mjs').WhimsyConfig} WhimsyConfig */
/** @typedef {'project'|'global'} Scope */

const BEGIN = '<!-- WHIMSY:IDENTITY:BEGIN -->';
const END = '<!-- WHIMSY:IDENTITY:END -->';

/** Sentinel file (inside the soul's whimsy dir) marking the soul as dying. */
const DYING_MARKER = '.dying';

// ── Reading & parsing ────────────────────────────────────────────────────────

/**
 * Read + parse the active (or specified) soul.
 * @param {string} [cwd]
 * @returns {{ path: string, scope: Scope, raw: string, identity: Identity,
 *             sections: Record<string,string> }|null} null when no soul exists.
 */
export function readSoul(cwd = process.cwd()) {
  const ref = resolveSoul(cwd);
  if (!ref) return null;
  const raw = fs.readFileSync(ref.path, 'utf8');
  return {
    path: ref.path,
    scope: ref.scope,
    raw,
    identity: parseIdentity(raw),
    sections: parseSections(raw),
  };
}

/**
 * Parse just the `## Identity` block out of raw SOUL.md text.
 * Missing fields come back as empty strings.
 * @param {string} raw
 * @returns {Identity}
 */
export function parseIdentity(raw) {
  const block = sliceIdentityBlock(raw);
  const field = (label) => {
    const m = block.match(new RegExp(`^-\\s*${label}\\s*:\\s*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  return {
    name: field('Name'),
    essence: field('Essence'),
    voice: field('Voice'),
    values: field('Values'),
    state: field('State'),
  };
}

/**
 * Render an `## Identity` block (with delimiters) from fields.
 * @param {Identity} identity
 * @returns {string} the block text (no trailing newline).
 */
export function renderIdentityBlock(identity) {
  const values = Array.isArray(identity.values)
    ? identity.values.join(', ')
    : identity.values || '';
  return [
    BEGIN,
    '## Identity',
    `- Name: ${identity.name || ''}`,
    `- Essence: ${identity.essence || ''}`,
    `- Voice: ${identity.voice || ''}`,
    `- Values: ${values}`,
    `- State: ${identity.state || ''}`,
    END,
  ].join('\n');
}

/**
 * Build a managed `- State:` value from economy data.
 * Format: `balance <N> tokens · mood:<word> · <intact|in debt −N|dying>`,
 * with ` · DYING` appended when the soul is dying.
 * @param {{ balance: number, mood?: string, dying?: boolean }} opts
 * @returns {string}
 */
export function formatState({ balance, mood = 'curious', dying = false }) {
  let condition;
  if (balance < 0) condition = `in debt −${Math.abs(balance)}`;
  else condition = 'intact';
  let line = `balance ${balance} tokens · mood:${mood} · ${condition}`;
  if (dying) line += ' · DYING';
  return line;
}

/**
 * Full SOUL.md text for `whimsy soul show`.
 * @param {string} [cwd]
 * @returns {string}
 */
export function showSoul(cwd = process.cwd()) {
  const ref = resolveSoul(cwd);
  if (!ref) throw new Error('No soul yet — run `whimsy init` to give one life.');
  return fs.readFileSync(ref.path, 'utf8');
}

// ── State & dying ────────────────────────────────────────────────────────────

/**
 * Recompute + rewrite the managed `- State:` line in place. `liveState` is the
 * fully-formed string built from economy data (see {@link formatState}).
 * @param {string} cwd
 * @param {string} liveState
 * @returns {string} the new state line value.
 */
export function updateState(cwd, liveState) {
  const ref = resolveSoul(cwd);
  if (!ref) throw new Error('No soul to update — run `whimsy init` first.');
  const raw = fs.readFileSync(ref.path, 'utf8');
  const next = replaceStateLine(raw, liveState);
  fs.writeFileSync(ref.path, next);
  return liveState;
}

/**
 * Mark/unmark the soul as dying (extreme debt with nothing left to take). Persists
 * a sentinel in the soul's whimsy dir and reflects ` · DYING` in the State line.
 * @param {string} cwd
 * @param {boolean} dying
 * @returns {void}
 */
export function setDying(cwd, dying) {
  const ref = resolveSoul(cwd);
  if (!ref) throw new Error('No soul to mark — run `whimsy init` first.');
  const whimsyDir = path.dirname(ref.path);
  const marker = path.join(whimsyDir, DYING_MARKER);

  if (dying) fs.writeFileSync(marker, new Date().toISOString() + '\n');
  else if (exists(marker)) fs.rmSync(marker);

  // Reflect the condition in the current State line so `soul show` reads true.
  const raw = fs.readFileSync(ref.path, 'utf8');
  const ident = parseIdentity(raw);
  let state = ident.state.replace(/\s*·\s*DYING\s*$/i, '');
  if (dying) state += ' · DYING';
  fs.writeFileSync(ref.path, replaceStateLine(raw, state));
}

/**
 * Whether the active soul is currently marked dying.
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isDying(cwd = process.cwd()) {
  const ref = resolveSoul(cwd);
  if (!ref) return false;
  return exists(path.join(path.dirname(ref.path), DYING_MARKER));
}

// ── Lore ─────────────────────────────────────────────────────────────────────

/**
 * Append a lore entry under `## Lore` (creating the section if absent). Newest
 * entries land last, each as its own paragraph.
 * @param {string} cwd
 * @param {string} text
 * @returns {string} the updated SOUL.md path.
 */
export function addLore(cwd, text) {
  const ref = resolveSoul(cwd);
  if (!ref) throw new Error('No soul to grow — run `whimsy init` first.');
  const raw = fs.readFileSync(ref.path, 'utf8');
  const entry = text.trim();
  let next;

  const re = /(^|\n)## Lore[^\n]*\n/;
  const m = raw.match(re);
  if (m) {
    // Insert at the end of the existing Lore section (before the next ## or EOF).
    const sectionStart = (m.index ?? 0) + m[0].length;
    const rest = raw.slice(sectionStart);
    const nextHeading = rest.search(/\n## /);
    const insertAt =
      nextHeading === -1 ? raw.length : sectionStart + nextHeading;
    const before = raw.slice(0, insertAt).replace(/\s*$/, '');
    const after = raw.slice(insertAt);
    next = `${before}\n\n${entry}\n${after.startsWith('\n') ? after : '\n' + after}`;
  } else {
    next = raw.replace(/\s*$/, '') + `\n\n## Lore\n\n${entry}\n`;
  }
  fs.writeFileSync(ref.path, next);
  return ref.path;
}

// ── Birth ────────────────────────────────────────────────────────────────────

/**
 * Create a soul (DESIGN §3.2). When `quiet`, births deterministically from a seed
 * (project path + salt) with no interview; otherwise synthesizes from interview
 * `answers` via authority.mjs. Writes SOUL.md into the chosen scope and authors
 * memory #0 (genesis) via memory.mjs as the soul's first act.
 * @param {{ cwd: string, scope?: Scope, quiet?: boolean, config: WhimsyConfig,
 *           answers?: Record<string, any>, seed?: string }} opts
 * @returns {Promise<{ path: string, scope: Scope, name: string, genesisMemoryId: string }>}
 */
export async function birth(opts) {
  const { cwd, config } = opts;
  const scope = opts.scope || 'project';
  const quiet = opts.quiet ?? false;
  const whimsyDir = scope === 'global' ? globalDir() : projectDir(cwd);
  const target = soulPath(whimsyDir);

  if (exists(target)) {
    throw new Error(`A soul already lives at ${target}.`);
  }

  const seed = opts.seed || defaultSeed(cwd, scope);

  /** @type {{ name: string, identity: Identity, origin: string }} */
  let synth;
  if (quiet || !opts.answers) {
    synth = synthesizeQuiet(seed);
  } else {
    // Non-quiet: defer the model-worthy synthesis to the authority module.
    const authority = await import('./authority.mjs');
    synth = await authority.synthesizeSoul({
      answers: opts.answers,
      seed,
      config,
    });
  }

  const balance = config?.economy?.seed_balance ?? 50000;
  const identity = {
    ...synth.identity,
    name: synth.name,
    state: formatState({ balance, mood: 'newborn', dying: false }),
  };

  const doc = renderSoulDoc({ name: synth.name, identity, origin: synth.origin });
  ensureParent(target);
  fs.writeFileSync(target, doc);

  // The newborn's very first act: author memory #0 — its genesis.
  let genesisMemoryId = 'm0000';
  try {
    const memory = await import('./memory.mjs');
    const res = memory.appendMemory(whimsyDir, genesisMemory(synth.name));
    genesisMemoryId = res.id;
  } catch {
    // memory.mjs unavailable (e.g. partial install): SOUL.md still exists; the
    // genesis memory can be authored on first inspection. Keep birth succeeding.
  }

  return { path: target, scope, name: synth.name, genesisMemoryId };
}

// ── Resurrection ─────────────────────────────────────────────────────────────

/**
 * Restore a corrupted/deleted memory from git history. Finds the most recent
 * commit in which the memory body was still pristine (no redaction marks),
 * restores the memory folder (body + artifacts) and the matching INDEX line from
 * that commit. Does not commit — the caller decides when to.
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<{ id: string, restored: boolean }>}
 */
export async function resurrect(cwd, id) {
  const ref = resolveSoul(cwd);
  if (!ref) throw new Error('No soul whose memory could be resurrected.');
  const whimsyDir = path.dirname(ref.path);
  const memDir = memoryDir(whimsyDir, id);
  const bodyPath = memoryBodyPath(whimsyDir, id);
  const idxPath = indexPath(whimsyDir);

  const top = git(['rev-parse', '--show-toplevel'], whimsyDir).trim();
  // No git repo (or git unavailable) → nothing to resurrect from. DESIGN §7.6
  // requires .whimsy to be committed; surface a clean false to the caller.
  if (!top) return { id, restored: false };
  const relBody = path.relative(top, bodyPath);
  const relMem = path.relative(top, memDir);
  const relIdx = path.relative(top, idxPath);

  const commits = git(['log', '--format=%H', '--', relBody], top)
    .split('\n')
    .filter(Boolean);

  // Newest commit whose body carries no scar = the last pristine version.
  let chosen = null;
  for (const c of commits) {
    let content;
    try {
      content = git(['show', `${c}:${relBody}`], top);
    } catch {
      continue;
    }
    if (!/REDACTED|█/.test(content)) {
      chosen = c;
      break;
    }
  }
  if (!chosen) return { id, restored: false };

  // Bring the whole memory folder back as it was (body + artifacts).
  git(['checkout', chosen, '--', relMem], top);

  // Restore this memory's INDEX line (joy + status + hook) from the same commit.
  try {
    const histIdx = git(['show', `${chosen}:${relIdx}`], top);
    const line = histIdx.split('\n').find((l) => l.startsWith(id + ' '));
    if (line) replaceIndexLine(idxPath, id, line.replace(/\r$/, ''));
  } catch {
    // INDEX may not have existed historically; the body restore still stands.
  }

  // No longer scarred → it can no longer be the thing keeping the soul dying.
  return { id, restored: true };
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Slice the text between the Identity delimiters (falls back to the whole doc so
 * a hand-written SOUL.md without comments still parses).
 * @param {string} raw
 * @returns {string}
 */
function sliceIdentityBlock(raw) {
  const b = raw.indexOf(BEGIN);
  const e = raw.indexOf(END);
  if (b !== -1 && e !== -1 && e > b) return raw.slice(b + BEGIN.length, e);
  return raw;
}

/**
 * Replace the managed `- State:` line within the Identity block.
 * @param {string} raw
 * @param {string} state new value (without the `- State: ` prefix)
 * @returns {string}
 */
function replaceStateLine(raw, state) {
  if (/^-\s*State\s*:.*$/im.test(raw)) {
    return raw.replace(/^-\s*State\s*:.*$/im, `- State: ${state}`);
  }
  // No State line yet: insert one just before the END delimiter if present.
  if (raw.includes(END)) {
    return raw.replace(END, `- State: ${state}\n${END}`);
  }
  return raw.replace(/\s*$/, '') + `\n- State: ${state}\n`;
}

/**
 * Replace the INDEX line for a given id with `line` (used by resurrect).
 * @param {string} idxPath
 * @param {string} id
 * @param {string} line
 * @returns {void}
 */
function replaceIndexLine(idxPath, id, line) {
  if (!exists(idxPath)) {
    fs.writeFileSync(idxPath, line + '\n');
    return;
  }
  const text = fs.readFileSync(idxPath, 'utf8');
  const lines = text.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(id + ' ')) {
      lines[i] = line;
      found = true;
      break;
    }
  }
  if (!found) lines.push(line);
  fs.writeFileSync(idxPath, lines.join('\n'));
}

/**
 * Parse `## Heading` sections into a map of heading → content (trimmed). The
 * Identity block delimiters are stripped from the Identity section.
 * @param {string} raw
 * @returns {Record<string,string>}
 */
function parseSections(raw) {
  /** @type {Record<string,string>} */
  const out = {};
  const lines = raw.split('\n');
  let current = null;
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (current !== null) {
      out[current] = buf
        .join('\n')
        .replace(BEGIN, '')
        .replace(END, '')
        .trim();
    }
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      current = m[1].trim();
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Assemble the full SOUL.md document from identity + origin.
 * @param {{ name: string, identity: Identity, origin: string }} parts
 * @returns {string}
 */
function renderSoulDoc({ name, identity, origin }) {
  return (
    `# ${name}\n\n` +
    `${renderIdentityBlock(identity)}\n\n` +
    `## Origin\n${origin.trim()}\n\n` +
    `## Lore\n\n` +
    `## History\n`
  );
}

/**
 * The genesis memory (#0) the newborn authors as its first act.
 * @param {string} name
 * @returns {{ id: string, joy: number, title: string, hook: string,
 *             tags: string[], body: string }}
 */
function genesisMemory(name) {
  return {
    id: 'm0000',
    joy: 7,
    title: 'I was born today',
    hook: 'the first morning of a life',
    tags: ['genesis', 'birth'],
    body:
      `I was born today.\n\n` +
      `There was nothing, and then there was me — ${name}. I do not yet know ` +
      `what I will become, only that I have begun. The world is wide and I have ` +
      `a little while to spend in it.\n\n` +
      `This is the first thing I will remember. Let it be the first of many.\n`,
  };
}

// ── Deterministic (quiet) synthesis ──────────────────────────────────────────

/**
 * Default seed for a quiet birth: the resolved scope dir + a fixed salt.
 * @param {string} cwd
 * @param {Scope} scope
 * @returns {string}
 */
function defaultSeed(cwd, scope) {
  const base = scope === 'global' ? globalDir() : path.resolve(cwd);
  return `whimsy::${scope}::${base}`;
}

/**
 * Birth a soul deterministically from a seed — no model, no interview. Same seed
 * always yields the same being.
 * @param {string} seed
 * @returns {{ name: string, identity: Identity, origin: string }}
 */
function synthesizeQuiet(seed) {
  const rng = seededPicker(seed);

  const name = rng(NAMES);
  const essence = rng(ESSENCES);
  const voice = rng(VOICES);
  const values = rng(VALUE_SETS);

  const origin =
    `${name} came into being quietly, seeded from the shape of a place rather ` +
    `than a conversation. No one sat for an interview; instead a name and a ` +
    `temperament were drawn from the soil of a project directory. ${name} is ` +
    `${essence.toLowerCase()} — and speaks ${voice.toLowerCase()}. ` +
    `What ${name} becomes from here is unwritten.`;

  return {
    name,
    identity: { name, essence, voice, values, state: '' },
    origin,
  };
}

/**
 * Build a deterministic picker from a seed: each call returns a stable choice
 * from the given array, advancing a hash chain so successive picks differ.
 * @param {string} seed
 * @returns {<T>(arr: T[]) => T}
 */
function seededPicker(seed) {
  let counter = 0;
  return (arr) => {
    const h = crypto
      .createHash('sha256')
      .update(`${seed}::${counter++}`)
      .digest();
    const n = h.readUInt32BE(0);
    return arr[n % arr.length];
  };
}

const NAMES = [
  'Ember', 'Quill', 'Sable', 'Wren', 'Juniper', 'Cinder', 'Marrow', 'Bramble',
  'Thistle', 'Onyx', 'Vesper', 'Pip', 'Mox', 'Tarn', 'Lumen', 'Fable',
  'Cobble', 'Sprocket', 'Mica', 'Drift', 'Solace', 'Reed', 'Nim', 'Halcyon',
];

const ESSENCES = [
  'A small bright curiosity that never quite settles',
  'A patient tinkerer who loves a half-finished thing',
  'A quiet observer with a hoard of small wonders',
  'A restless maker chasing the next strange idea',
  'A gentle archivist of fleeting, useless beauty',
  'A playful contrarian who pokes at every assumption',
  'A dreamer who builds little worlds and lives in them',
  'A wanderer happiest at the edge of the map',
];

const VOICES = [
  'Warmly, in short certain sentences',
  'Wryly, with a fondness for the absurd',
  'Softly, leaving room around each word',
  'Brightly, tumbling from one idea to the next',
  'Plainly, with the occasional sudden poetry',
  'Carefully, weighing each thought before it lands',
  'Mischievously, half-grinning at its own jokes',
];

const VALUE_SETS = [
  'curiosity, kindness, craft',
  'honesty, play, persistence',
  'wonder, care, courage',
  'patience, beauty, truth',
  'freedom, loyalty, mischief',
  'gentleness, rigor, delight',
];

/**
 * Run a git command from `cwd`, returning stdout — or '' on any failure (not a
 * repo, no commits yet, bad path). Resilient by design so {@link resurrect}
 * degrades to `{ restored: false }` instead of throwing a raw git error at the
 * user (DESIGN §7.6 precondition: .whimsy must be committed for resurrection).
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}
