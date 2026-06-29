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

// ── Settings (get/set on dotted keys, type-coerced from defaults) ────────────

/**
 * The declared type of a dotted config key, read from the built-in defaults.
 * @param {string} dottedKey e.g. `play.allow_shell`
 * @returns {'boolean'|'number'|'array'|'string'|null} null = unknown key
 */
function keyType(dottedKey) {
  let node = /** @type {any} */ (defaults);
  for (const p of dottedKey.split('.')) {
    if (node == null || typeof node !== 'object' || !(p in node)) return null;
    node = node[p];
  }
  if (Array.isArray(node)) return 'array';
  if (typeof node === 'boolean') return 'boolean';
  if (typeof node === 'number') return 'number';
  if (typeof node === 'string') return 'string';
  return null;
}

/** The settable keys (dotted), for help + validation. @returns {string[]} */
export function settableKeys() {
  return flattenConfig(defaults).map((line) => line.split(' = ')[0]);
}

/**
 * Coerce a raw string to the type a dotted key declares in defaults. Unknown keys
 * are rejected (catches typos) — every setting must map to a real default.
 * @param {string} dottedKey @param {string} raw
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function coerceSetting(dottedKey, raw) {
  const t = keyType(dottedKey);
  if (t == null) return { ok: false, error: `unknown setting "${dottedKey}"` };
  if (t === 'boolean') {
    if (!/^(true|false)$/i.test(raw)) return { ok: false, error: `${dottedKey} expects true|false` };
    return { ok: true, value: /^true$/i.test(raw) };
  }
  if (t === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `${dottedKey} expects a number` };
    return { ok: true, value: n };
  }
  if (t === 'array') return { ok: true, value: raw.split(',').map((s) => s.trim()).filter(Boolean) };
  return { ok: true, value: raw };
}

/** Read a dotted key from a config object. @returns {any} null if absent. */
export function getSetting(config, dottedKey) {
  return dottedKey.split('.').reduce((o, k) => (o == null ? o : o[k]), config) ?? null;
}

/** Set a dotted key into a config object (mutates, creating intermediate tables). */
export function setSetting(config, dottedKey, value) {
  const parts = dottedKey.split('.');
  let node = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

/** Flatten a config to sorted `dotted.key = value` lines (arrays as `[a, b]`). */
export function flattenConfig(config) {
  /** @type {string[]} */
  const out = [];
  const walk = (obj, prefix) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const key = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) out.push(`${key} = [${v.join(', ')}]`);
      else if (v && typeof v === 'object') walk(v, key);
      else out.push(`${key} = ${v}`);
    }
  };
  walk(config, '');
  return out.sort();
}

/**
 * Parse repeated `--set key=value` flags into coerced pairs.
 * @param {string|boolean|string[]|undefined} setFlag
 * @returns {{ pairs: {key:string, value:any}[], errors: string[] }}
 */
export function parseSetFlags(setFlag) {
  const raw = setFlag == null || typeof setFlag === 'boolean' ? [] : Array.isArray(setFlag) ? setFlag : [setFlag];
  /** @type {{key:string,value:any}[]} */ const pairs = [];
  /** @type {string[]} */ const errors = [];
  for (const item of raw) {
    const idx = String(item).indexOf('=');
    if (idx === -1) { errors.push(`bad --set "${item}" (expected key=value)`); continue; }
    const key = String(item).slice(0, idx).trim();
    const c = coerceSetting(key, String(item).slice(idx + 1).trim());
    if (!c.ok) { errors.push(c.error); continue; }
    pairs.push({ key, value: c.value });
  }
  return { pairs, errors };
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
