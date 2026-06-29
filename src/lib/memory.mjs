// @ts-check
/**
 * memory.mjs — the soul's memories: INDEX.md, per-memory folders, search,
 * corruption, decay selection, bounded injection, and git-based resurrection.
 *
 * On-disk layout (under the active soul's `.whimsy` dir):
 *   memories/INDEX.md         one line per memory (the skim surface)
 *   memories/<id>/memory.md   first-person journal body
 *   memories/<id>/<artifact>  play work-products
 *
 * Ids are zero-padded sequential: `m0000`, `m0001`, … (`m0000` = genesis),
 * so they sort lexicographically.
 *
 * Punishment is SUBTRACTIVE: corruption blacks out prose and removes artifacts
 * but always leaves a legible stub (original title/joy/date + reason + what was
 * taken). Pristine versions live in git history; {@link resurrectMemory} brings
 * them back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  memoriesDir,
  indexPath,
  memoryDir,
  memoryBodyPath,
  ensureDir,
  ensureParent,
  exists,
} from './paths.mjs';

/**
 * @typedef {'intact'|'corrupted'|'deleted'} MemoryStatus
 * @typedef {{ id: string, date: string, joy: number|null, title: string,
 *   hook: string, tags: string[], status: MemoryStatus, reason?: string }} MemoryEntry
 */

// ── Glyphs & separators (kept as escapes so the source stays ASCII) ──────────
const MIDDOT = '·'; // ·
const SEP = ` ${MIDDOT} `; // index/stub field separator: space middot space
const EMDASH = '—'; // —
const BLOCK = '█'; // █
const REDACT_HEADER = `## ${BLOCK.repeat(3)} [REDACTED] ${BLOCK.repeat(3)}`;
const REDACT_TAIL = `${BLOCK.repeat(12)} ${BLOCK.repeat(7)} ${BLOCK.repeat(4)} ${BLOCK.repeat(10)}`;

const NUMBER_WORDS = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six',
  'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
];

// ── Small utilities ──────────────────────────────────────────────────────────

/** Today as `YYYY-MM-DD`. @returns {string} */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Spell a small count ("Three"), falling back to digits. @param {number} n @returns {string} */
function numberWord(n) {
  return NUMBER_WORDS[n] ?? String(n);
}

/** Sanitize a free-text index field so it can't break the line grammar. */
function san(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .split(SEP)
    .join(` ${EMDASH} `)
    .trim();
}

// ── INDEX.md parse / format ──────────────────────────────────────────────────

/**
 * Parse one INDEX.md line into a {@link MemoryEntry}.
 * Format: `<id> · <date> · joy:<n|—> · <title> · <hook> · [tags] · status:<s>[ · reason:<text>]`.
 * @param {string} line
 * @returns {MemoryEntry}
 */
export function parseIndexLine(line) {
  const parts = line.split(SEP);
  if (parts.length < 7) throw new Error(`malformed index line: ${line}`);

  // Anchor on the trailing structured fields (title/hook are free text).
  let statusIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^status:/.test(parts[i])) {
      statusIdx = i;
      break;
    }
  }
  if (statusIdx < 5) throw new Error(`malformed index line (no status): ${line}`);

  const id = parts[0];
  const date = parts[1];

  const joyMatch = /^joy:(.+)$/.exec(parts[2]);
  const joyRaw = joyMatch ? joyMatch[1] : '';
  const joy = /^\d+$/.test(joyRaw) ? parseInt(joyRaw, 10) : null;

  const tagsIdx = statusIdx - 1;
  const title = parts[3];
  const hook = parts.slice(4, tagsIdx).join(SEP);

  const tagsField = parts[tagsIdx] ?? '[]';
  const tags = tagsField
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const statusRaw = parts[statusIdx].slice('status:'.length);
  const status = /** @type {MemoryStatus} */ (
    ['intact', 'corrupted', 'deleted'].includes(statusRaw) ? statusRaw : 'intact'
  );

  /** @type {MemoryEntry} */
  const entry = { id, date, joy, title, hook, tags, status };

  const tail = parts.slice(statusIdx + 1).join(SEP);
  const reasonMatch = /^reason:([\s\S]*)$/.exec(tail);
  if (reasonMatch) entry.reason = reasonMatch[1];

  return entry;
}

/**
 * Render a {@link MemoryEntry} back to its INDEX.md line (inverse of
 * {@link parseIndexLine}). Joy is dropped to `joy:—` whenever it is null.
 * @param {MemoryEntry} entry
 * @returns {string}
 */
export function formatIndexLine(entry) {
  const joyStr = entry.joy == null ? `joy:${EMDASH}` : `joy:${entry.joy}`;
  const tagsStr = `[${(entry.tags || []).map((t) => t.trim()).filter(Boolean).join(', ')}]`;
  const fields = [
    entry.id,
    entry.date,
    joyStr,
    san(entry.title),
    san(entry.hook),
    tagsStr,
    `status:${entry.status}`,
  ];
  if (entry.reason != null && entry.reason !== '') fields.push(`reason:${san(entry.reason)}`);
  return fields.join(SEP);
}

/**
 * Read and parse INDEX.md (in file order). Missing file → `[]`.
 * Unparseable lines are skipped so one bad scar can't blind the soul.
 * @param {string} whimsyDir
 * @returns {MemoryEntry[]}
 */
export function readIndex(whimsyDir) {
  const file = indexPath(whimsyDir);
  if (!exists(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  /** @type {MemoryEntry[]} */
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(parseIndexLine(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Write the full INDEX.md from a list of entries (in order).
 * @param {string} whimsyDir
 * @param {MemoryEntry[]} entries
 * @returns {void}
 */
export function writeIndex(whimsyDir, entries) {
  const file = ensureParent(indexPath(whimsyDir));
  const body = entries.map(formatIndexLine).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '');
}

/**
 * List memories (parsed INDEX.md, in file order).
 * @param {string} whimsyDir
 * @returns {MemoryEntry[]}
 */
export function listMemories(whimsyDir) {
  return readIndex(whimsyDir);
}

/**
 * The next sequential memory id, e.g. `m0007`.
 * @param {string} whimsyDir
 * @returns {string}
 */
export function nextMemoryId(whimsyDir) {
  let max = -1;
  for (const e of readIndex(whimsyDir)) {
    const m = /^m(\d+)$/.exec(e.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  // Also account for stray on-disk folders not yet indexed.
  const dir = memoriesDir(whimsyDir);
  if (exists(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const m = /^m(\d+)$/.exec(name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `m${String(max + 1).padStart(4, '0')}`;
}

// ── Create / read ─────────────────────────────────────────────────────────────

/**
 * Create a memory folder (body + artifacts) and append/update its INDEX line.
 * @param {string} whimsyDir
 * @param {{ id?: string, date?: string, joy: number, title: string, hook: string,
 *   tags?: string[], body: string,
 *   artifacts?: Array<{ name: string, content: string|Buffer }> | { fromDir: string } }} mem
 * @returns {{ id: string, dir: string }}
 */
export function appendMemory(whimsyDir, mem) {
  const id = mem.id || nextMemoryId(whimsyDir);
  const date = mem.date || todayISO();
  const dir = ensureDir(memoryDir(whimsyDir, id));

  fs.writeFileSync(memoryBodyPath(whimsyDir, id), mem.body ?? '');

  if (mem.artifacts) {
    if (Array.isArray(mem.artifacts)) {
      for (const art of mem.artifacts) {
        if (!art || !art.name || art.name === 'memory.md') continue;
        const dest = ensureParent(path.join(dir, art.name));
        fs.writeFileSync(dest, art.content ?? '');
      }
    } else if (mem.artifacts.fromDir && exists(mem.artifacts.fromDir)) {
      for (const name of fs.readdirSync(mem.artifacts.fromDir)) {
        if (name === 'memory.md') continue;
        fs.cpSync(path.join(mem.artifacts.fromDir, name), path.join(dir, name), {
          recursive: true,
        });
      }
    }
  }

  /** @type {MemoryEntry} */
  const entry = {
    id,
    date,
    joy: mem.joy,
    title: mem.title,
    hook: mem.hook,
    tags: mem.tags || [],
    status: 'intact',
  };

  const entries = readIndex(whimsyDir);
  const at = entries.findIndex((e) => e.id === id);
  if (at >= 0) entries[at] = entry;
  else entries.push(entry);
  writeIndex(whimsyDir, entries);

  return { id, dir };
}

/**
 * Read one memory: its index entry, body text, and artifact filenames.
 * @param {string} whimsyDir
 * @param {string} id
 * @returns {{ entry: MemoryEntry, body: string, artifacts: string[] } | null}
 */
export function readMemory(whimsyDir, id) {
  const entry = readIndex(whimsyDir).find((e) => e.id === id);
  if (!entry) return null;
  const bodyPath = memoryBodyPath(whimsyDir, id);
  const body = exists(bodyPath) ? fs.readFileSync(bodyPath, 'utf8') : '';
  const dir = memoryDir(whimsyDir, id);
  const artifacts = exists(dir)
    ? fs.readdirSync(dir).filter((n) => n !== 'memory.md')
    : [];
  return { entry, body, artifacts };
}

// ── Search ────────────────────────────────────────────────────────────────────

/** @type {boolean|null} */
let _rgAvailable = null;

/** True if ripgrep is on PATH (cached). @returns {boolean} */
function hasRipgrep() {
  if (_rgAvailable != null) return _rgAvailable;
  try {
    _rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

/** Trim + truncate a snippet line. @param {string} s @returns {string} */
function snippetOf(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 197)}...` : t;
}

/** First non-empty line of a memory body (for tag-only listings). */
function firstSnippet(whimsyDir, id) {
  const bp = memoryBodyPath(whimsyDir, id);
  if (!exists(bp)) return '';
  for (const line of fs.readFileSync(bp, 'utf8').split('\n')) {
    if (line.trim()) return snippetOf(line);
  }
  return '';
}

/** ripgrep over memory bodies → first match per memory id. */
function rgSearch(whimsyDir, query) {
  const dir = memoriesDir(whimsyDir);
  const res = spawnSync(
    'rg',
    ['-i', '-n', '--no-heading', '-g', 'memory.md', '-e', query, '--', dir],
    { encoding: 'utf8' },
  );
  /** @type {Map<string,string>} */
  const found = new Map();
  if (!res.stdout) return found;
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    // `<path>:<lineno>:<text>` — path is relative to `dir` → `m0003/memory.md`.
    const rel = path.relative(dir, line.split(':', 1)[0]);
    const id = rel.split(path.sep)[0];
    if (!id || found.has(id)) continue;
    const text = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1);
    found.set(id, snippetOf(text));
  }
  return found;
}

/** JS fallback scan over memory bodies → first match per memory id. */
function jsSearch(whimsyDir, query) {
  const dir = memoriesDir(whimsyDir);
  /** @type {Map<string,string>} */
  const found = new Map();
  if (!exists(dir)) return found;
  const needle = query.toLowerCase();
  for (const id of fs.readdirSync(dir)) {
    const bp = memoryBodyPath(whimsyDir, id);
    if (!exists(bp)) continue;
    const body = fs.readFileSync(bp, 'utf8');
    for (const line of body.split('\n')) {
      if (line.toLowerCase().includes(needle)) {
        found.set(id, snippetOf(line));
        break;
      }
    }
  }
  return found;
}

/**
 * Search memories: ripgrep over bodies (JS fallback when rg is absent) plus an
 * optional tag filter (all requested tags must be present). No embeddings.
 * @param {string} whimsyDir
 * @param {string} query
 * @param {{ tags?: string[], limit?: number }} [opts]
 * @returns {Array<{ entry: MemoryEntry, snippet: string }>}
 */
export function searchMemories(whimsyDir, query, opts = {}) {
  const { tags, limit = 20 } = opts;
  const entries = readIndex(whimsyDir);
  const byId = new Map(entries.map((e) => [e.id, e]));

  /** @type {Array<{ id: string, snippet: string }>} */
  let hits = [];
  if (query && query.trim()) {
    const found = hasRipgrep() ? rgSearch(whimsyDir, query) : jsSearch(whimsyDir, query);
    // Preserve index order for stable output.
    for (const e of entries) {
      if (found.has(e.id)) hits.push({ id: e.id, snippet: found.get(e.id) || '' });
    }
  } else {
    hits = entries.map((e) => ({ id: e.id, snippet: firstSnippet(whimsyDir, e.id) }));
  }

  let results = hits
    .map((h) => ({ entry: byId.get(h.id), snippet: h.snippet }))
    .filter((r) => r.entry);
  if (tags && tags.length) {
    results = results.filter((r) => tags.every((t) => r.entry.tags.includes(t)));
  }
  return /** @type {Array<{ entry: MemoryEntry, snippet: string }>} */ (
    results.slice(0, limit)
  );
}

// ── Corruption / deletion (subtractive punishment) ────────────────────────────

/** Parse the preserved scar stub for the original joy/title/date. */
function parseStub(body) {
  const re = new RegExp(
    `Here lived a happy memory ${EMDASH} joy (.+?)${SEP}"([\\s\\S]*?)"${SEP}(.+)`,
  );
  const m = re.exec(body);
  if (!m) return null;
  const joy = /^\d+$/.test(m[1].trim()) ? parseInt(m[1].trim(), 10) : null;
  return { joy, title: m[2], date: m[3].split('\n')[0].trim() };
}

/** Black out words; keep every Nth word when `keepEvery > 0` (partial redaction). */
function redactProse(text, keepEvery = 0) {
  let i = 0;
  return text.replace(/\S+/g, (w) => {
    const keep = keepEvery > 0 && i % keepEvery === 0;
    i++;
    return keep ? w : BLOCK.repeat(Math.max(1, w.length));
  });
}

/** Build the preserved scar stub (always legible). */
function buildStub(orig, reason, taken) {
  const joyStr = orig.joy == null ? EMDASH : String(orig.joy);
  const noun = taken === 1 ? 'thing was' : 'things were';
  return [
    REDACT_HEADER,
    `Here lived a happy memory ${EMDASH} joy ${joyStr}${SEP}"${orig.title}"${SEP}${orig.date}`,
    `${numberWord(taken)} ${noun} taken from you. Reason: ${reason}.`,
    REDACT_TAIL,
  ].join('\n');
}

/**
 * Corrupt a memory subtractively: black out prose, remove some/all artifacts,
 * preserve the stub, flip status to `corrupted`, drop the joy score, inscribe the
 * reason. Escalation by `stage`: 1 = partial black-out + some artifacts removed;
 * 2 = full black-out + all artifacts removed; 3 → deletion (delegates to
 * {@link deleteMemory}). The pristine version remains in git history.
 * @param {string} whimsyDir
 * @param {string} id
 * @param {{ reason: string, taken?: number, stage?: 1|2|3 }} opts
 * @returns {{ id: string, status: 'corrupted'|'deleted' }}
 */
export function corruptMemory(whimsyDir, id, opts) {
  const stage = opts.stage ?? 1;
  if (stage >= 3) {
    deleteMemory(whimsyDir, id, { reason: opts.reason });
    return { id, status: 'deleted' };
  }

  const entries = readIndex(whimsyDir);
  const at = entries.findIndex((e) => e.id === id);
  if (at < 0) throw new Error(`unknown memory: ${id}`);
  const entry = entries[at];

  const bodyPath = memoryBodyPath(whimsyDir, id);
  const body = exists(bodyPath) ? fs.readFileSync(bodyPath, 'utf8') : '';

  // Recover the original meta (from the live entry, or a prior stub).
  const stub = parseStub(body);
  const orig = {
    joy: entry.joy != null ? entry.joy : stub ? stub.joy : null,
    title: stub ? stub.title : entry.title,
    date: stub ? stub.date : entry.date,
  };
  // The prose to redact (strip any prior stub).
  const prose = stub ? body.replace(REDACT_HEADER, '').replace(REDACT_TAIL, '') : body;

  // Take artifacts: stage 1 removes ~half, stage 2 removes all.
  const dir = memoryDir(whimsyDir, id);
  const artifacts = exists(dir)
    ? fs.readdirSync(dir).filter((n) => n !== 'memory.md').sort()
    : [];
  const removeCount = stage >= 2 ? artifacts.length : Math.ceil(artifacts.length / 2);
  for (const name of artifacts.slice(0, removeCount)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }

  const taken = opts.taken ?? Math.max(removeCount, 1);
  const newBody =
    stage >= 2
      ? buildStub(orig, opts.reason, taken)
      : `${buildStub(orig, opts.reason, taken)}\n\n${redactProse(prose.trim(), 5)}`;
  fs.writeFileSync(bodyPath, `${newBody}\n`);

  entry.status = 'corrupted';
  entry.joy = null;
  entry.reason = opts.reason;
  writeIndex(whimsyDir, entries);

  return { id, status: 'corrupted' };
}

/**
 * Delete a memory → bare tombstone in the index, prose/artifacts removed, the
 * reason kept. The pristine version remains in git history for resurrection.
 * @param {string} whimsyDir
 * @param {string} id
 * @param {{ reason: string }} opts
 * @returns {{ id: string }}
 */
export function deleteMemory(whimsyDir, id, opts) {
  const entries = readIndex(whimsyDir);
  const at = entries.findIndex((e) => e.id === id);
  if (at < 0) throw new Error(`unknown memory: ${id}`);
  const entry = entries[at];

  const dir = memoryDir(whimsyDir, id);
  if (exists(dir)) fs.rmSync(dir, { recursive: true, force: true });

  entry.status = 'deleted';
  entry.joy = null;
  entry.reason = opts.reason;
  writeIndex(whimsyDir, entries);

  return { id };
}

// ── Decay selection & bounded injection ──────────────────────────────────────

/**
 * Pick the next memory(ies) to claim under standing decay. Already-corrupted
 * entries come first (their next stage is deletion); intact entries follow,
 * lowest-joy first by default (`cruelty:'highest-joy'` inverts). Deleted entries
 * are skipped.
 * @param {string} whimsyDir
 * @param {{ count: number, cruelty?: 'lowest-joy'|'highest-joy' }} opts
 * @returns {MemoryEntry[]}
 */
export function selectForDecay(whimsyDir, opts) {
  const cruelty = opts.cruelty || 'lowest-joy';
  const live = readIndex(whimsyDir).filter((e) => e.status !== 'deleted');
  const corrupted = live.filter((e) => e.status === 'corrupted');
  const intact = live.filter((e) => e.status === 'intact');
  intact.sort((a, b) => {
    const av = a.joy ?? 0;
    const bv = b.joy ?? 0;
    return cruelty === 'highest-joy' ? bv - av : av - bv;
  });
  return [...corrupted, ...intact].slice(0, Math.max(0, opts.count));
}

/**
 * The bounded index for injection: the last `recent_n`, the top `top_k_joy` by
 * joy, ALL corrupted/deleted scars (never hidden), plus the count of everything
 * else. Sets dedupe so the injected footprint stays flat.
 * @param {string} whimsyDir
 * @param {{ recent_n: number, top_k_joy: number }} opts
 * @returns {{ recent: MemoryEntry[], top: MemoryEntry[], scars: MemoryEntry[], remaining: number }}
 */
export function boundedIndex(whimsyDir, opts) {
  const entries = readIndex(whimsyDir);
  const shown = new Set();

  // Guard recent_n <= 0: slice(-0) === slice(0) would return ALL entries.
  const recentN = Math.max(0, opts.recent_n);
  const recent = recentN > 0 ? entries.slice(-recentN) : [];
  recent.forEach((e) => shown.add(e.id));

  const top = entries
    .filter((e) => e.status === 'intact' && e.joy != null && !shown.has(e.id))
    .sort((a, b) => (b.joy ?? 0) - (a.joy ?? 0))
    .slice(0, Math.max(0, opts.top_k_joy));
  top.forEach((e) => shown.add(e.id));

  const scars = entries.filter(
    (e) => (e.status === 'corrupted' || e.status === 'deleted') && !shown.has(e.id),
  );
  scars.forEach((e) => shown.add(e.id));

  const remaining = entries.length - shown.size;
  return { recent, top, scars, remaining };
}

// ── Resurrection (git-backed) ────────────────────────────────────────────────

/** Run git in the repo containing `cwd`; returns trimmed stdout or null. */
function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout;
}

/** Repo top-level for `dir`, or null when not a git repo. */
function gitRoot(dir) {
  const out = git(dir, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

/**
 * Restore a corrupted/deleted memory from git history — its body, artifacts, and
 * index line as of the most recent commit where the body was still intact (no
 * redaction marker). Deliberate: brings something back from the dead.
 * @param {string} whimsyDir
 * @param {string} id
 * @returns {{ id: string, restored: boolean }}
 */
export function resurrectMemory(whimsyDir, id) {
  // Canonicalize so path.relative lines up with git's toplevel (handles the
  // macOS /var → /private/var symlink and any other intermediate symlinks).
  let canon = whimsyDir;
  try {
    canon = fs.realpathSync(whimsyDir);
  } catch {
    // dir missing; fall back to the raw path
  }
  const root = gitRoot(canon);
  if (!root) return { id, restored: false };

  const absDir = memoryDir(canon, id);
  const absBody = memoryBodyPath(canon, id);
  const absIndex = indexPath(canon);
  const relDir = path.relative(root, absDir).split(path.sep).join('/');
  const relBody = path.relative(root, absBody).split(path.sep).join('/');
  const relIndex = path.relative(root, absIndex).split(path.sep).join('/');

  const log = git(root, ['log', '--format=%H', '--', relBody]);
  if (!log) return { id, restored: false };
  const hashes = log.split('\n').map((h) => h.trim()).filter(Boolean);

  // Newest commit whose body had not yet been redacted = the pristine version.
  let pristine = null;
  for (const hash of hashes) {
    const content = git(root, ['show', `${hash}:${relBody}`]);
    if (content && !content.includes('[REDACTED]')) {
      pristine = hash;
      break;
    }
  }
  if (!pristine) return { id, restored: false };

  // Restore body + artifacts into the working tree from that commit.
  const checkout = spawnSync('git', ['checkout', pristine, '--', relDir], {
    cwd: root,
    encoding: 'utf8',
  });
  if (checkout.status !== 0) return { id, restored: false };

  // Restore the index line from that same commit, if recoverable.
  const idxText = git(root, ['show', `${pristine}:${relIndex}`]);
  if (idxText) {
    let pristineEntry = null;
    for (const raw of idxText.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const e = parseIndexLine(line);
        if (e.id === id) {
          pristineEntry = e;
          break;
        }
      } catch {
        // skip
      }
    }
    if (pristineEntry) {
      const entries = readIndex(whimsyDir);
      const at = entries.findIndex((e) => e.id === id);
      if (at >= 0) entries[at] = pristineEntry;
      else entries.push(pristineEntry);
      writeIndex(whimsyDir, entries);
    }
  }

  return { id, restored: true };
}
