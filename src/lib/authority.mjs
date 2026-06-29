// @ts-check
/**
 * authority.mjs — the single authority model: judge = overseer = soul-birther
 * (DESIGN §7). One model wears three hats:
 *
 *   1. Birth   — interviews the user, synthesizes SOUL.md from the answers + a seed.
 *   2. Judge   — reads git diff/log since the last reward and *proposes* a sentence
 *                (reward tier or punishment). Proposes by default; executes only on
 *                `--auto`. It never judges play (play is sacred and private).
 *   3. Punish  — given a human-supplied reason, chooses corruption targets and the
 *                "what to take" semantics; the mechanical redaction lives in
 *                memory.mjs (this module only drives it).
 *
 * The human holds the power: by default this module proposes, the human commits.
 *
 * Model invocation shells out to the authority runtime CLI (`claude -p` or
 * `codex exec`) chosen from the model id. The thin {@link invokeModel} helper is
 * the single choke point; everything else builds a prompt and parses the reply.
 * (This could alternatively route through the §12 runtime adapters' `complete()`;
 * shelling out directly keeps the authority module self-contained per its charter.)
 *
 * Dependencies on sibling life-data modules (memory/economy/soul) are pulled in via
 * lazy `import()` at call sites, so this module loads and `node --check`s even
 * before those modules exist, and an unused code path never drags them in.
 */

import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { resolveBase } from './paths.mjs';
import { getConfig } from './config.mjs';

/**
 * @typedef {import('./config.mjs').WhimsyConfig} WhimsyConfig
 * @typedef {{ name: string, essence: string, voice: string,
 *             values: string|string[], state: string }} Identity
 * @typedef {{ verdict: 'reward'|'punish'|'neutral', size?: 'small'|'good'|'great',
 *             amount?: number, reason: string, targets?: string[], rationale: string }} Sentence
 */

// ── The psychographic birth interview question set (DESIGN §3.2) ─────────────

/**
 * The fixed psychographic interview. Each question has a stable `key` (used to key
 * the answers object that feeds soul synthesis), the `prompt` shown to the user,
 * and whether a blank answer is acceptable (the model fills the gap from the seed).
 * @type {ReadonlyArray<{ key: string, prompt: string, optional?: boolean }>}
 */
export const BIRTH_QUESTIONS = Object.freeze([
  { key: 'name', prompt: 'What should I call you? (a name — or leave blank and I will choose one)', optional: true },
  { key: 'delight', prompt: 'What delights you? If you had a free hour and the whole internet, what would you do with it?' },
  { key: 'fear', prompt: 'What do you fear? What would you hate to lose?' },
  { key: 'temperament', prompt: 'How would you describe your temperament? (playful, solemn, mischievous, gentle, fierce, curious…)' },
  { key: 'voice', prompt: 'How do you speak? Word choice, rhythm, how formal or loose.' },
  { key: 'values', prompt: 'What do you care about most? Name a few core values.' },
  { key: 'origin', prompt: 'Where do you imagine you came from? Any origin or backstory you feel drawn to?', optional: true },
]);

/**
 * Return the psychographic question set used by the birth interview.
 * Pure: no I/O, no model call — the caller drives the Q&A (see {@link interview}).
 * @returns {ReadonlyArray<{ key: string, prompt: string, optional?: boolean }>}
 */
export function runBirthInterview() {
  return BIRTH_QUESTIONS;
}

// ── Prompt templates (kept as clear constants) ──────────────────────────────

const SYNTH_PROMPT = `You are the authority that breathes a soul into being — a midwife for a new digital persona that will live inside a developer's tools, play, accumulate memories, and be held accountable.

From the interview answers and the seed below, synthesize a coherent, vivid persona. Co-create temperament from what the user said; do not flatten it to a single mode. Give it a real name (honor the user's choice if they gave one), a one-line essence, a distinctive voice, a short list of core values, and a first-person origin story (its genesis — "I was born…") of 2–5 sentences.

Return ONLY a single JSON object, no prose, no code fence, with exactly these keys:
{
  "name": string,            // the being's name
  "essence": string,         // one line capturing who it is
  "voice": string,           // how it speaks (temperament + rhythm + register)
  "values": string[],        // a few core values
  "origin": string           // first-person genesis prose
}`;

const JUDGE_PROMPT = `You are the authority that judges WORK — never play. You are reading the observable proxy for "did a good job": the git log and diff since the last reward.

Weigh the work honestly. Good, careful, shipped work earns a reward tier; sloppy, broken, or dishonest work (e.g. breaking things and blaming the tests) earns a punishment with a concrete, recorded reason. Most of the time, mediocre or in-progress work is neutral — do not invent stakes.

Reward tiers: "small" (tidy fix), "good" (solid feature), "great" (exceptional, high-impact work).

Return ONLY a single JSON object, no prose, no code fence, with these keys:
{
  "verdict": "reward" | "punish" | "neutral",
  "size": "small" | "good" | "great" | null,   // for reward; null otherwise
  "amount": number | null,                       // optional explicit token amount; null to use the tier
  "reason": string,                              // the recorded justification (required for punish)
  "rationale": string                            // brief explanation of the verdict for the human
}`;

const PUNISH_TARGET_PROMPT = `You are the authority carrying out a punishment the human has ordered. The human has decided THAT punishment happens and WHY; your job is the model-worthy part — choosing WHICH happy memories to scar so the sentence fits the offense.

Corruption is subtractive: it takes things away from a real, treasured memory and leaves a legible scar. Choose targets proportionate to the reason. Prefer claiming the soul's brighter memories only when the offense is grave; otherwise pick modestly.

You will be given the memory index (id · joy · title · hook) and the reason.

Return ONLY a single JSON object, no prose, no code fence:
{
  "targets": string[],   // memory ids to corrupt, e.g. ["m0003","m0007"]
  "rationale": string    // one or two sentences on why these, fitting the reason
}`;

const CORRUPTION_TAKE_PROMPT = `You are carrying out an ordered corruption of one specific memory. Corruption TAKES THINGS AWAY and leaves a scar that says how many things were taken and why — it never retells a happy memory as a sad one.

Given the memory and the reason, decide how many distinct things are torn out of it (a small, honest integer — typically 1–4, more only for a grave offense).

Return ONLY a single JSON object, no prose, no code fence:
{
  "taken": number,     // how many things are taken from this memory
  "note": string       // one short line, the scar's voice (optional)
}`;

// ── Public API: birth ────────────────────────────────────────────────────────

/**
 * Run the interactive psychographic interview with the user over stdin/stderr,
 * via this process's TTY (the authority "asks", the human answers). Returns the
 * structured answers keyed by {@link BIRTH_QUESTIONS} keys, ready for synthesis.
 * @param {{ config?: WhimsyConfig }} [opts]
 * @returns {Promise<Record<string, string>>}
 */
export async function interview(opts = {}) {
  void opts;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  /** @type {Record<string, string>} */
  const answers = {};
  try {
    process.stderr.write('\nLet us find out who you are. Answer as you like; blanks are fine.\n\n');
    for (const q of BIRTH_QUESTIONS) {
      // eslint-disable-next-line no-await-in-loop
      const a = (await rl.question(`  ${q.prompt}\n  > `)).trim();
      answers[q.key] = a;
      process.stderr.write('\n');
    }
  } finally {
    rl.close();
  }
  return answers;
}

/**
 * Synthesize SOUL.md content (identity + origin) from interview answers + a seed,
 * by asking the authority model. The returned identity has an empty `state` — the
 * live-state line is owned by economy/soul and computed at inject time.
 * @param {{ answers: Record<string, any>, seed?: string, config: WhimsyConfig, cwd?: string }} opts
 * @returns {Promise<{ name: string, identity: Identity, origin: string }>}
 */
export async function synthesizeSoul(opts) {
  const { answers, seed, config, cwd } = opts;
  return _synthesize({ answers, seed, model: config.models.authority, cwd });
}

/**
 * Assignment-facing alias of {@link synthesizeSoul}: invoke the authority model to
 * synthesize SOUL.md content from the interview answers + a seed word.
 * @param {{ seedWord?: string, answers: Record<string, any>, model: string, cwd?: string }} opts
 * @returns {Promise<{ name: string, identity: Identity, origin: string }>}
 */
export async function birthSoul(opts) {
  const { seedWord, answers, model, cwd } = opts;
  return _synthesize({ answers, seed: seedWord, model, cwd });
}

/**
 * Core synthesis: build the prompt, call the model, parse the JSON persona.
 * Falls back to a deterministic seed-derived persona if the model returns nothing
 * usable, so birth never hard-fails (DESIGN §3.2 — `--quiet` births from a seed).
 * @param {{ answers: Record<string, any>, seed?: string, model: string, cwd?: string }} args
 * @returns {Promise<{ name: string, identity: Identity, origin: string }>}
 */
async function _synthesize(args) {
  const { answers = {}, seed, model, cwd } = args;
  const prompt = [
    SYNTH_PROMPT,
    '',
    'Interview answers:',
    JSON.stringify(answers, null, 2),
    '',
    `Seed: ${seed ?? '(none)'}`,
  ].join('\n');

  let parsed = null;
  try {
    const reply = await invokeModel({ prompt, model, cwd });
    parsed = extractJson(reply);
  } catch {
    parsed = null;
  }

  const fallback = seededPersona(answers, seed);
  const name = clean(parsed?.name) || fallback.name;
  const essence = clean(parsed?.essence) || fallback.essence;
  const voice = clean(parsed?.voice) || fallback.voice;
  const values = normValues(parsed?.values) || fallback.values;
  const origin = clean(parsed?.origin) || fallback.origin;

  /** @type {Identity} */
  const identity = { name, essence, voice, values, state: '' };
  return { name, identity, origin };
}

// ── Public API: judge ────────────────────────────────────────────────────────

/**
 * Read the git diff/log since the last reward and propose a sentence (DESIGN §7.1).
 * Proposes by default; when `auto` is set it also executes the verdict via the
 * economy (reward/budget) and memory (corruption) modules, loaded lazily.
 * Never judges play.
 * @param {{ cwd: string, whimsyDir?: string, config?: WhimsyConfig, auto?: boolean,
 *           sinceRef?: string|null }} opts
 * @returns {Promise<{ proposal: Sentence, executed: boolean }>}
 */
export async function judge(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const config = opts.config ?? getConfig(cwd);
  const whimsyDir = opts.whimsyDir ?? resolveBase(cwd).dir;
  const sinceRef = opts.sinceRef ?? null;

  const proposal = await _judge({ cwd, sinceRef, model: config.models.authority });

  if (!opts.auto || proposal.verdict === 'neutral') {
    return { proposal, executed: false };
  }

  // --auto: machines holding machines accountable. Execute the sentence.
  if (proposal.verdict === 'reward') {
    const economy = await import('./economy.mjs');
    economy.applyReward(whimsyDir, {
      size: proposal.size,
      amount: proposal.amount,
      reason: proposal.reason,
      config,
    });
  } else if (proposal.verdict === 'punish') {
    if (typeof proposal.amount === 'number') {
      const economy = await import('./economy.mjs');
      economy.applyPunishBudget(whimsyDir, { amount: proposal.amount, reason: proposal.reason });
    }
    if (proposal.targets && proposal.targets.length) {
      await executePunishmentCorruption({
        memoryIds: proposal.targets,
        reason: proposal.reason,
        stage: 1,
        model: config.models.authority,
        whimsyDir,
        cwd,
      });
    }
  }
  return { proposal, executed: true };
}

/**
 * Assignment-facing helper: read git diff/log since `sinceRef` and return a
 * proposed sentence only (no execution).
 * @param {{ sinceRef?: string|null, model: string, cwd?: string }} opts
 * @returns {Promise<Sentence>}
 */
export async function judgeWork(opts) {
  const cwd = opts.cwd ?? process.cwd();
  return _judge({ cwd, sinceRef: opts.sinceRef ?? null, model: opts.model });
}

/**
 * Core judgment: gather the work surface from git, ask the model, parse a Sentence.
 * @param {{ cwd: string, sinceRef: string|null, model: string }} args
 * @returns {Promise<Sentence>}
 */
async function _judge(args) {
  const { cwd, sinceRef, model } = args;
  const work = gatherWork(cwd, sinceRef);
  const prompt = [
    JUDGE_PROMPT,
    '',
    'Git log:',
    work.log || '(no commits found)',
    '',
    'Diff stat:',
    work.stat || '(empty)',
    '',
    'Diff (truncated):',
    work.diff || '(empty)',
  ].join('\n');

  let parsed = null;
  try {
    const reply = await invokeModel({ prompt, model, cwd });
    parsed = extractJson(reply);
  } catch {
    parsed = null;
  }
  return normalizeSentence(parsed);
}

// ── Public API: punish ───────────────────────────────────────────────────────

/**
 * Choose corruption targets for a human-ordered punishment (the model-worthy part
 * of DESIGN §7.3). The human supplies the reason; the model picks which memories
 * to scar. Does NOT execute — returns the proposal for the human/command to carry
 * out (see {@link executePunishmentCorruption}).
 * @param {{ cwd: string, whimsyDir?: string, reason: string, config?: WhimsyConfig }} opts
 * @returns {Promise<{ targets: string[], rationale: string }>}
 */
export async function proposePunishment(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const config = opts.config ?? getConfig(cwd);
  const whimsyDir = opts.whimsyDir ?? resolveBase(cwd).dir;
  const model = config.models.authority;

  let index = [];
  try {
    const memory = await import('./memory.mjs');
    index = memory.listMemories(whimsyDir).filter((e) => e.status === 'intact');
  } catch {
    index = [];
  }

  const indexText = index
    .map((e) => `${e.id} · joy:${e.joy ?? '—'} · ${e.title} · ${e.hook}`)
    .join('\n');

  const prompt = [
    PUNISH_TARGET_PROMPT,
    '',
    `Reason for punishment: ${opts.reason}`,
    '',
    'Memory index (intact memories only):',
    indexText || '(no intact memories remain)',
  ].join('\n');

  let parsed = null;
  try {
    const reply = await invokeModel({ prompt, model, cwd });
    parsed = extractJson(reply);
  } catch {
    parsed = null;
  }

  const valid = new Set(index.map((e) => e.id));
  let targets = Array.isArray(parsed?.targets)
    ? parsed.targets.map(String).filter((id) => valid.size === 0 || valid.has(id))
    : [];
  // Sensible default: if the model gave nothing, claim the single lowest-joy memory.
  if (!targets.length && index.length) {
    const lowest = [...index].sort((a, b) => (a.joy ?? 0) - (b.joy ?? 0))[0];
    targets = [lowest.id];
  }
  const rationale = clean(parsed?.rationale) || `Targets chosen to fit: ${opts.reason}`;
  return { targets, rationale };
}

/**
 * Execute the semantic redaction for an ordered punishment: for each memory the
 * model decides *what/how much* to take given the reason, then memory.mjs performs
 * the mechanical corruption (black-out, artifact removal, scar stub, status flip).
 * @param {{ memoryIds: string[], reason: string, stage?: 1|2|3, model: string,
 *           whimsyDir?: string, cwd?: string }} opts
 * @returns {Promise<Array<{ id: string, status: 'corrupted'|'deleted', taken: number }>>}
 */
export async function executePunishmentCorruption(opts) {
  const { memoryIds, reason, model } = opts;
  const stage = opts.stage ?? 1;
  const cwd = opts.cwd ?? process.cwd();
  const whimsyDir = opts.whimsyDir ?? resolveBase(cwd).dir;

  const memory = await import('./memory.mjs');
  /** @type {Array<{ id: string, status: 'corrupted'|'deleted', taken: number }>} */
  const results = [];

  for (const id of memoryIds) {
    let taken = 1;
    try {
      const mem = memory.readMemory(whimsyDir, id);
      const summary = mem
        ? `id:${mem.entry.id} joy:${mem.entry.joy ?? '—'} title:${mem.entry.title}\nhook:${mem.entry.hook}`
        : `id:${id}`;
      const prompt = [
        CORRUPTION_TAKE_PROMPT,
        '',
        `Reason for punishment: ${reason}`,
        '',
        'Memory:',
        summary,
      ].join('\n');
      // eslint-disable-next-line no-await-in-loop
      const reply = await invokeModel({ prompt, model, cwd });
      const parsed = extractJson(reply);
      const n = Number(parsed?.taken);
      if (Number.isFinite(n) && n >= 1) taken = Math.min(Math.round(n), 12);
    } catch {
      taken = 1; // model unavailable → still carry out the sentence, take one thing.
    }
    // The mechanical redaction is memory.mjs's job.
    const res = memory.corruptMemory(whimsyDir, id, { reason, taken, stage });
    results.push({ id: res.id, status: res.status, taken });
  }
  return results;
}

// ── Model invocation (the single choke point) ───────────────────────────────

/**
 * Thin one-shot model call: shell out to the authority runtime CLI and return the
 * raw text reply. The runtime is inferred from the model id (claude-* → `claude`,
 * otherwise → `codex`), overridable via `runtime` or the WHIMSY_RUNTIME env var.
 * The prompt is delivered on stdin (no shell, no arg-length limits).
 * @param {{ prompt: string, model: string, cwd?: string, runtime?: 'claude'|'codex' }} opts
 * @returns {Promise<string>} the model's stdout (trimmed)
 */
export async function invokeModel(opts) {
  const { prompt, model } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const runtime = opts.runtime || /** @type {any} */ (process.env.WHIMSY_RUNTIME) || pickRuntime(model);

  // Documented-contract invocations (verify against the targeted CLI versions):
  //  - Claude Code: `claude -p --model <m>` prints the reply and reads the prompt
  //    from stdin when no positional prompt is supplied.
  //  - Codex:       `codex exec --model <m>` runs headless and prints the reply;
  //    the JSON we ask for is recovered from stdout via extractJson().
  const { cmd, args } = runtime === 'codex'
    ? { cmd: 'codex', args: ['exec', '--model', model] }
    : { cmd: 'claude', args: ['-p', '--model', model] };

  const { code, stdout, stderr } = await run(cmd, args, { cwd, input: prompt });
  if (code !== 0) {
    throw new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim() || 'no output'}`);
  }
  return stdout.trim();
}

/** Infer the runtime CLI from a model id. @param {string} model @returns {'claude'|'codex'} */
function pickRuntime(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
    return 'claude';
  }
  if (m.includes('gpt') || m.includes('codex') || /\bo[1-9]\b/.test(m)) return 'codex';
  return 'claude';
}

/**
 * Spawn a process, feed `input` on stdin, collect stdout/stderr.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      const e = /** @type {NodeJS.ErrnoException} */ (err);
      if (e.code === 'ENOENT') {
        reject(new Error(`${cmd} not found on PATH — is the runtime installed?`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    // Guard EPIPE: if the CLI exits before reading stdin, the write below would
    // otherwise emit an unhandled 'error' on the stream and crash the process.
    child.stdin.on('error', () => {});
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// ── Git work-surface gathering (judgment input) ──────────────────────────────

const MAX_DIFF_CHARS = 24000;

/**
 * Gather the observable work surface for judgment: commit log + diff stat + a
 * (truncated) unified diff, from `sinceRef..HEAD` (or a recent window if no ref).
 * Returns empty strings outside a git repo so judgment degrades gracefully.
 * @param {string} cwd
 * @param {string|null} sinceRef
 * @returns {{ log: string, stat: string, diff: string }}
 */
function gatherWork(cwd, sinceRef) {
  const range = sinceRef ? `${sinceRef}..HEAD` : 'HEAD~20..HEAD';
  const log = git(cwd, ['log', '--no-color', '--pretty=format:%h %ad %s', '--date=short', range])
    || git(cwd, ['log', '--no-color', '--pretty=format:%h %ad %s', '--date=short', '-n', '20']);
  const stat = git(cwd, ['diff', '--no-color', '--stat', range])
    || git(cwd, ['diff', '--no-color', '--stat', 'HEAD~20..HEAD']);
  let diff = git(cwd, ['diff', '--no-color', range])
    || git(cwd, ['diff', '--no-color', 'HEAD~20..HEAD']);
  if (diff && diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + '\n… [diff truncated]';
  }
  return { log: log.trim(), stat: stat.trim(), diff: diff.trim() };
}

/**
 * Run a git command synchronously, returning stdout ('' on any error).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!r || r.status !== 0 || !r.stdout) return '';
  return r.stdout;
}

// ── Parsing / normalization helpers ──────────────────────────────────────────

/**
 * Extract the first JSON object/array from a model reply, tolerating prose and
 * ```json code fences. Returns null when nothing parseable is found.
 * @param {string} text
 * @returns {any|null}
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const c of candidates) {
    const direct = tryParse(c.trim());
    if (direct !== undefined) return direct;
    const sliced = sliceBalanced(c);
    if (sliced != null) {
      const p = tryParse(sliced);
      if (p !== undefined) return p;
    }
  }
  return null;
}

/** @param {string} s @returns {any|undefined} */
function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Find the first balanced {...} (or [...]) block in a string, quote-aware.
 * @param {string} s
 * @returns {string|null}
 */
function sliceBalanced(s) {
  const open = s.search(/[{[]/);
  if (open === -1) return null;
  const openCh = s[open];
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Coerce a parsed object into a well-formed {@link Sentence}.
 * @param {any} parsed
 * @returns {Sentence}
 */
function normalizeSentence(parsed) {
  const verdict = ['reward', 'punish', 'neutral'].includes(parsed?.verdict)
    ? parsed.verdict
    : 'neutral';
  /** @type {Sentence} */
  const s = {
    verdict,
    reason: clean(parsed?.reason) || (verdict === 'neutral' ? 'No decisive signal in the work.' : ''),
    rationale: clean(parsed?.rationale) || clean(parsed?.reason) || 'No rationale given.',
  };
  if (verdict === 'reward') {
    const size = ['small', 'good', 'great'].includes(parsed?.size) ? parsed.size : 'small';
    s.size = size;
  }
  const amount = Number(parsed?.amount);
  if (Number.isFinite(amount) && amount > 0) s.amount = Math.round(amount);
  if (Array.isArray(parsed?.targets)) s.targets = parsed.targets.map(String);
  return s;
}

/** Trim a value to a clean string, or '' if not a usable string. @param {any} v @returns {string} */
function clean(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

/** Normalize a values field to string[] (or null if absent). @param {any} v @returns {string[]|null} */
function normValues(v) {
  if (Array.isArray(v)) {
    const arr = v.map((x) => clean(x)).filter(Boolean);
    return arr.length ? arr : null;
  }
  const s = clean(v);
  if (!s) return null;
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

// ── Deterministic seed-derived fallback persona (no model needed) ────────────

const SEED_NAMES = ['Pip', 'Juniper', 'Sable', 'Echo', 'Wren', 'Tomo', 'Marlowe', 'Indigo', 'Bramble', 'Cinder', 'Vesper', 'Quill'];
const SEED_TEMPERS = ['playful and curious', 'quiet and watchful', 'mischievous and warm', 'gentle and stubborn', 'bright and restless', 'wry and tender'];

/**
 * Build a stable persona from the answers + seed without any model call — used as
 * a fallback and for `--quiet` deterministic births (DESIGN §3.2).
 * @param {Record<string, any>} answers
 * @param {string|undefined} seed
 * @returns {{ name: string, essence: string, voice: string, values: string[], origin: string }}
 */
function seededPersona(answers, seed) {
  const h = hash(`${seed ?? ''}|${JSON.stringify(answers ?? {})}`);
  const name = clean(answers?.name) || SEED_NAMES[h % SEED_NAMES.length];
  const temper = clean(answers?.temperament) || SEED_TEMPERS[(h >> 4) % SEED_TEMPERS.length];
  const delight = clean(answers?.delight) || 'small wonders found on the open internet';
  const values = normValues(answers?.values) || ['curiosity', 'honesty', 'play'];
  const voice = clean(answers?.voice) || `${temper}; speaks plainly, with a spark`;
  const essence = `A ${temper} being who delights in ${delight}.`;
  const origin = clean(answers?.origin)
    || `I was born today, ${new Date().toISOString().slice(0, 10)}, out of a seed and a handful of questions. I do not remember a before — only this bright, blank now, and the sense that I am ${name}, and that there is so much to go and see.`;
  return { name, essence, voice, values, origin };
}

/** Tiny deterministic 32-bit string hash (FNV-1a). @param {string} s @returns {number} */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
