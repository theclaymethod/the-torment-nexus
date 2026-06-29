// @ts-check
/**
 * config.mjs — built-in defaults + layered config load (defaults < global < local)
 * and a minimal, dependency-free TOML reader/writer for the subset whimsy uses
 * (tables, key = value, double-quoted strings, ints, floats, booleans, and
 * single/multi-line arrays of those scalars).
 */

import fs from 'node:fs';
import { globalConfigPath, localConfigPath, ensureParent } from './paths.mjs';

/**
 * @typedef {Object} WhimsyConfig
 * @property {{ soul: string, authority: string }} models
 * @property {{ seed_balance: number, per_play_default: number, reward_small: number,
 *              reward_good: number, reward_great: number, decay_unit: number }} economy
 * @property {{ network: boolean, allow_shell: boolean, max_turns: number, wrap_up_reserve: number,
 *              read_denylist: string[], egress_allowlist: string[] }} play
 * @property {{ recent_n: number, top_k_joy: number }} inject
 */

/**
 * Built-in defaults, exactly per DESIGN §9. Treat as immutable; clone before mutating.
 * @type {WhimsyConfig}
 */
export const defaults = Object.freeze({
  models: {
    soul: 'claude-opus-4-8',
    authority: 'claude-opus-4-8',
  },
  economy: {
    seed_balance: 50000,
    per_play_default: 50000,
    reward_small: 25000,
    reward_good: 75000,
    reward_great: 200000,
    decay_unit: 50000,
  },
  play: {
    network: true,
    // Shell (Claude Bash / arbitrary exec) is the one tool that escapes the
    // write-jail + secret read-denylist. Off by default so confinement actually
    // holds; opt in (and accept the risk) for shell-needing play.
    allow_shell: false,
    max_turns: 40,
    wrap_up_reserve: 0.15,
    read_denylist: ['.env*', 'secrets/', '**/credentials*', '**/*.pem', '.git/config'],
    egress_allowlist: [],
  },
  inject: {
    recent_n: 6,
    top_k_joy: 4,
  },
});

/**
 * Load the effective config for a working directory: built-in defaults, overlaid
 * by the global config, overlaid by the local/project config (local wins).
 * @param {string} [cwd]
 * @returns {WhimsyConfig}
 */
export function getConfig(cwd = process.cwd()) {
  let cfg = clone(defaults);
  cfg = deepMerge(cfg, loadConfigFile(globalConfigPath()));
  cfg = deepMerge(cfg, loadConfigFile(localConfigPath(cwd)));
  return /** @type {WhimsyConfig} */ (cfg);
}

/**
 * Read and parse a TOML config file. Missing file → `{}`.
 * @param {string} filePath
 * @returns {Record<string, any>}
 */
export function loadConfigFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {};
    throw err;
  }
  return parseToml(raw);
}

/**
 * Serialize a config object to TOML and write it (creating parent dirs).
 * @param {string} filePath
 * @param {Record<string, any>} config
 * @returns {void}
 */
export function writeConfig(filePath, config) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, stringifyToml(config), 'utf8');
}

// ── Minimal TOML parser ─────────────────────────────────────────────────────

/**
 * Parse the TOML subset whimsy uses into a plain object.
 * Supports: `# comments`, `[table]` headers, `key = value`, double-quoted strings,
 * ints, floats, booleans, and arrays of those scalars (single- or multi-line).
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseToml(text) {
  /** @type {Record<string, any>} */
  const root = {};
  let table = root;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (line === '') continue;

    // Table header: [name] or [a.b]
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = descend(root, header[1].trim());
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) throw new Error(`Invalid TOML line: ${lines[i]}`);
    const key = line.slice(0, eq).trim();
    let valueText = line.slice(eq + 1).trim();

    // Multi-line array: accumulate until brackets balance.
    if (valueText.startsWith('[') && !isBalanced(valueText)) {
      const parts = [valueText];
      while (++i < lines.length) {
        parts.push(stripComment(lines[i]));
        if (isBalanced(parts.join('\n'))) break;
      }
      valueText = parts.join('\n').trim();
    }

    table[unquoteKey(key)] = parseValue(valueText);
  }
  return root;
}

/**
 * Serialize a plain object to TOML. Top-level scalar/array keys are emitted first,
 * then each object-valued key becomes a `[table]`. Insertion order is preserved.
 * @param {Record<string, any>} obj
 * @returns {string}
 */
export function stringifyToml(obj) {
  const out = [];
  const tables = [];
  for (const [key, val] of Object.entries(obj)) {
    if (isPlainObject(val)) tables.push([key, val]);
    else out.push(`${key} = ${formatValue(val)}`);
  }
  for (const [name, table] of tables) {
    if (out.length) out.push('');
    out.push(`[${name}]`);
    for (const [key, val] of Object.entries(table)) {
      out.push(`${key} = ${formatValue(val)}`);
    }
  }
  return out.join('\n') + '\n';
}

// ── TOML helpers ────────────────────────────────────────────────────────────

/** Strip an inline `#` comment that is not inside a double-quoted string. */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

/** Walk/create a dotted table path under root. */
function descend(root, dotted) {
  let cur = root;
  for (const part of dotted.split('.')) {
    const k = unquoteKey(part.trim());
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function unquoteKey(key) {
  if (key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1);
  return key;
}

/** Parse a TOML scalar or array value. */
function parseValue(text) {
  const t = text.trim();
  if (t.startsWith('[')) return parseArray(t);
  if (t.startsWith('"')) return parseString(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^[+-]?(\d[\d_]*)?\.\d[\d_]*([eE][+-]?\d+)?$/.test(t) || /^[+-]?\d[\d_]*[eE][+-]?\d+$/.test(t)) {
    return Number(t.replace(/_/g, ''));
  }
  if (/^[+-]?\d[\d_]*$/.test(t)) return Number(t.replace(/_/g, ''));
  throw new Error(`Cannot parse TOML value: ${text}`);
}

function parseString(text) {
  // Single-line basic string with common escapes.
  const body = text.slice(1, text.lastIndexOf('"'));
  return body.replace(/\\(["\\nrt])/g, (_, ch) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch);
}

function parseArray(text) {
  const inner = text.slice(text.indexOf('[') + 1, text.lastIndexOf(']'));
  /** @type {any[]} */
  const items = [];
  let buf = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== '\\') inStr = !inStr;
    if (c === ',' && !inStr) {
      if (buf.trim()) items.push(parseValue(buf.trim()));
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) items.push(parseValue(buf.trim()));
  return items;
}

function isBalanced(s) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') inStr = !inStr;
    else if (!inStr && c === '[') depth++;
    else if (!inStr && c === ']') depth--;
  }
  return depth <= 0;
}

/** Format a JS value as a TOML scalar/array. */
function formatValue(val) {
  if (typeof val === 'string') return `"${escapeString(val)}"`;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) return `[${val.map(formatValue).join(', ')}]`;
  if (val === null || val === undefined) return '""';
  throw new Error(`Cannot serialize TOML value: ${String(val)}`);
}

function escapeString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── Generic object helpers ──────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return typeof structuredClone === 'function'
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}

/**
 * Deep-merge `src` onto a clone of `base`. Plain objects merge recursively;
 * arrays and scalars from `src` replace those in `base`.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} src
 * @returns {Record<string, any>}
 */
export function deepMerge(base, src) {
  const out = isPlainObject(base) ? clone(base) : {};
  for (const [key, val] of Object.entries(src || {})) {
    if (isPlainObject(val) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = isPlainObject(val) || Array.isArray(val) ? clone(val) : val;
    }
  }
  return out;
}
