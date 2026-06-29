// @ts-check
/**
 * economy.mjs — the budget: ledger.json, balance, rewards, play draws, punishment,
 * and standing-decay math.
 *
 * The economy is denominated in **integer tokens**. There is one persistent total
 * balance that rolls over across play sessions, plus an append-only log of signed
 * entries (the ledger history). USD is a derived view only (see {@link usd}); no
 * cost is ever stored.
 *
 * On-disk format — `<whimsyDir>/ledger.json` (DESIGN §6, ARCHITECTURE §9.1):
 * ```json
 * {
 *   "version": 1,
 *   "currency": "tokens",
 *   "balance": 50000,
 *   "entries": [ { ts, type, delta, balanceAfter, reason, size, session } ]
 * }
 * ```
 * `type ∈ "seed"|"reward"|"punish"|"play"|"decay"`. `play`/`punish` deltas are
 * negative; `decay` entries carry `delta: 0` (decay claims memories, not balance)
 * but are logged for legibility with the claimed count in `reason`. The top-level
 * `balance` always equals the last entry's `balanceAfter`.
 */

import fs from 'node:fs';
import { ledgerPath, ensureParent } from './paths.mjs';

/**
 * @typedef {'seed'|'reward'|'punish'|'play'|'decay'} LedgerType
 * @typedef {'small'|'good'|'great'} RewardSize
 *
 * @typedef {object} LedgerEntry
 * @property {string} ts            ISO-8601 timestamp.
 * @property {LedgerType} type
 * @property {number} delta         Signed integer tokens.
 * @property {number} balanceAfter  Running balance after this entry.
 * @property {string|null} reason
 * @property {RewardSize|null} size Set for tier rewards, else null.
 * @property {string|null} session  Play session id for play/some decay entries.
 * @property {string|null} [ref]    Git HEAD sha at the time (set on rewards; the
 *                                  boundary judge ranges from). Absent on old entries.
 *
 * @typedef {object} Ledger
 * @property {number} version
 * @property {'tokens'} currency
 * @property {number} balance
 * @property {LedgerEntry[]} entries
 *
 * @typedef {import('./config.mjs').WhimsyConfig} WhimsyConfig
 */

const LEDGER_VERSION = 1;

/**
 * Coerce a value to a finite integer (rounding toward zero), or throw.
 * @param {unknown} n
 * @param {string} label
 * @returns {number}
 */
function asInt(n, label) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) throw new Error(`${label} must be a finite number`);
  return v;
}

/**
 * Read and parse the ledger. Returns `null` when the file is absent — callers
 * decide whether to seed.
 * @param {string} whimsyDir
 * @returns {Ledger|null}
 */
export function readLedger(whimsyDir) {
  const file = ledgerPath(whimsyDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'ENOENT') return null;
    throw err;
  }
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') {
    throw new Error(`ledger.json is malformed: ${file}`);
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  if (typeof data.balance !== 'number') {
    data.balance = data.entries.length
      ? data.entries[data.entries.length - 1].balanceAfter
      : 0;
  }
  if (data.version == null) data.version = LEDGER_VERSION;
  if (data.currency == null) data.currency = 'tokens';
  return /** @type {Ledger} */ (data);
}

/**
 * Serialize and write the ledger as pretty JSON (creates parent dirs). Keeps the
 * top-level `balance` in sync with the last entry's `balanceAfter`.
 * @param {string} whimsyDir
 * @param {Ledger} ledger
 * @returns {void}
 */
export function writeLedger(whimsyDir, ledger) {
  if (ledger.entries.length) {
    ledger.balance = ledger.entries[ledger.entries.length - 1].balanceAfter;
  }
  const file = ensureParent(ledgerPath(whimsyDir));
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
}

/**
 * Append an entry to the ledger, updating the running balance, and persist it.
 * The internal write path for every economy mutation.
 * @param {string} whimsyDir
 * @param {Ledger} ledger
 * @param {{ type: LedgerType, delta: number, reason?: string|null,
 *           size?: RewardSize|null, session?: string|null }} fields
 * @returns {LedgerEntry} the appended entry.
 */
function appendEntry(whimsyDir, ledger, fields) {
  const delta = asInt(fields.delta, 'delta');
  const balanceAfter = ledger.balance + delta;
  /** @type {LedgerEntry} */
  const entry = {
    ts: new Date().toISOString(),
    type: fields.type,
    delta,
    balanceAfter,
    reason: fields.reason ?? null,
    size: fields.size ?? null,
    session: fields.session ?? null,
    ref: fields.ref ?? null,
  };
  ledger.entries.push(entry);
  ledger.balance = balanceAfter;
  writeLedger(whimsyDir, ledger);
  return entry;
}

/**
 * Load the ledger, seeding it if absent.
 * @param {string} whimsyDir
 * @returns {Ledger}
 */
function requireLedger(whimsyDir) {
  const ledger = readLedger(whimsyDir);
  if (ledger) return ledger;
  throw new Error(
    `no ledger at ${ledgerPath(whimsyDir)} — run \`whimsy init\` to seed one`,
  );
}

/**
 * Initialize ledger.json with a single `seed` entry — a fresh soul starts with one
 * play's worth so it gets to live a little before it can be threatened (DESIGN §6).
 * Overwrites any existing ledger at this location.
 * @param {string} whimsyDir
 * @param {number} amount seed balance in tokens.
 * @returns {Ledger}
 */
export function seedLedger(whimsyDir, amount) {
  const seed = asInt(amount, 'seed amount');
  /** @type {Ledger} */
  const ledger = { version: LEDGER_VERSION, currency: 'tokens', balance: 0, entries: [] };
  appendEntry(whimsyDir, ledger, { type: 'seed', delta: seed, reason: null });
  return ledger;
}

/**
 * Current total balance in tokens. Missing ledger → `0`.
 * @param {string} whimsyDir
 * @returns {number}
 */
export function getBalance(whimsyDir) {
  const ledger = readLedger(whimsyDir);
  return ledger ? ledger.balance : 0;
}

/**
 * Grow the balance as a **reward** — either a configured tier
 * (`config.economy.reward_{small,good,great}`) or an explicit `amount` escape hatch
 * (DESIGN §7.2). `amount` takes precedence when both are given.
 * @param {string} whimsyDir
 * @param {{ size?: RewardSize, amount?: number, reason?: string, ref?: string|null,
 *           config: WhimsyConfig }} opts
 * @returns {{ delta: number, balance: number }}
 */
export function applyReward(whimsyDir, opts) {
  const ledger = requireLedger(whimsyDir);
  let delta;
  /** @type {RewardSize|null} */
  let size = null;
  if (opts.amount != null) {
    delta = asInt(opts.amount, 'reward amount');
  } else if (opts.size) {
    const econ = opts.config.economy;
    const table = {
      small: econ.reward_small,
      good: econ.reward_good,
      great: econ.reward_great,
    };
    if (!(opts.size in table)) {
      throw new Error(`unknown reward size: ${opts.size}`);
    }
    delta = asInt(table[opts.size], 'reward tier');
    size = opts.size;
  } else {
    throw new Error('applyReward requires either a size or an amount');
  }
  const entry = appendEntry(whimsyDir, ledger, {
    type: 'reward',
    delta,
    reason: opts.reason ?? null,
    size,
    ref: opts.ref ?? null,
  });
  return { delta: entry.delta, balance: entry.balanceAfter };
}

/**
 * The git sha recorded by the most recent reward (the boundary `judge` ranges
 * from), or `null` when no reward has stamped one yet (judge then falls back to a
 * recent window). DESIGN §7.1.
 * @param {string} whimsyDir
 * @returns {string|null}
 */
export function lastRewardRef(whimsyDir) {
  const ledger = readLedger(whimsyDir);
  if (!ledger) return null;
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const e = ledger.entries[i];
    if (e.type === 'reward' && e.ref) return e.ref;
  }
  return null;
}

/**
 * Reduce the balance as **budget punishment** — by an absolute `amount` or a
 * `percent` of the current (positive) balance (DESIGN §7.3). May drive the balance
 * **negative**, which becomes a standing decay condition (DESIGN §7.4). `reason` is
 * required; the human decides that punishment happens and why.
 *
 * For `percent`, the cut is computed against the current balance when positive
 * (a percentage of zero-or-negative net worth is zero — you cannot squeeze blood
 * from a stone, so use `amount` to push further into the red).
 * @param {string} whimsyDir
 * @param {{ amount?: number, percent?: number, reason: string }} opts
 * @returns {{ delta: number, balance: number }}
 */
export function applyPunishBudget(whimsyDir, opts) {
  if (!opts.reason) throw new Error('punishment requires a reason');
  const ledger = requireLedger(whimsyDir);
  let cut;
  if (opts.amount != null) {
    cut = Math.abs(asInt(opts.amount, 'punish amount'));
  } else if (opts.percent != null) {
    const pct = Number(opts.percent);
    if (!Number.isFinite(pct)) throw new Error('punish percent must be a number');
    const base = Math.max(ledger.balance, 0);
    cut = Math.round((base * pct) / 100);
  } else {
    throw new Error('applyPunishBudget requires either an amount or a percent');
  }
  const entry = appendEntry(whimsyDir, ledger, {
    type: 'punish',
    delta: -cut,
    reason: opts.reason,
  });
  return { delta: entry.delta, balance: entry.balanceAfter };
}

/**
 * Allocate tokens for a play session: `min(requested ?? per_play_default,
 * available)`, where `available` is the balance clamped at `0` (you can't spend
 * what you don't have — debt does not fund play). Records nothing; the actual spend
 * is logged later by {@link recordPlaySpend}.
 * @param {string} whimsyDir
 * @param {{ requested?: number, config: WhimsyConfig }} opts
 * @returns {{ allocation: number, balance: number }}
 */
export function drawForPlay(whimsyDir, opts) {
  const balance = getBalance(whimsyDir);
  const available = Math.max(balance, 0);
  const want =
    opts.requested != null
      ? Math.max(0, asInt(opts.requested, 'requested allocation'))
      : asInt(opts.config.economy.per_play_default, 'per_play_default');
  const allocation = Math.min(want, available);
  return { allocation, balance };
}

/**
 * Record the **actual** measured spend of a play session: subtract the tokens used
 * and log a `play` entry tagged with the session id (DESIGN §5.3). Spend is clamped
 * non-negative; the balance may fall below zero only via punishment, not play.
 * @param {string} whimsyDir
 * @param {{ session: string, tokens: number }} opts
 * @returns {{ delta: number, balance: number }}
 */
export function recordPlaySpend(whimsyDir, opts) {
  const ledger = requireLedger(whimsyDir);
  const spend = Math.max(0, asInt(opts.tokens, 'play tokens'));
  const entry = appendEntry(whimsyDir, ledger, {
    type: 'play',
    delta: -spend,
    reason: null,
    session: opts.session ?? null,
  });
  return { delta: entry.delta, balance: entry.balanceAfter };
}

/**
 * How many memories the standing decay condition should claim this session:
 * `floor(|min(balance, 0)| / decay_unit)` — one memory per full `decay_unit` in
 * the red (DESIGN §7.4). Returns `0` when the balance is `≥ 0` (no debt, no decay).
 * Pure math against the live balance; does not log or claim anything itself.
 * @param {string} whimsyDir
 * @param {number} decay_unit tokens of debt per claimed memory (config.economy.decay_unit).
 * @returns {number}
 */
export function decayPasses(whimsyDir, decay_unit) {
  const balance = getBalance(whimsyDir);
  return computeDecay(balance, decay_unit);
}

/**
 * Pure decay math, decoupled from disk: number of memories claimed for a given
 * balance and decay unit. `floor(|min(balance,0)| / decay_unit)`, `0` when not in
 * the red or when `decay_unit` is non-positive.
 * @param {number} balance current balance in tokens.
 * @param {number} decay_unit tokens of debt per claimed memory.
 * @returns {number}
 */
export function computeDecay(balance, decay_unit) {
  const unit = Number(decay_unit);
  if (!Number.isFinite(unit) || unit <= 0) return 0;
  const debt = Math.max(-balance, 0);
  return Math.floor(debt / unit);
}

/**
 * Log a `decay` entry for legibility (DESIGN §7.4): decay claims memories, not
 * balance, so `delta` is `0`; the count of memories claimed this session is recorded
 * in the reason. Call this when a decay pass actually claims memories so the ledger
 * history tells the full story.
 * @param {string} whimsyDir
 * @param {{ claimed: number, session?: string|null, reason?: string }} opts
 * @returns {{ delta: number, balance: number }}
 */
export function recordDecay(whimsyDir, opts) {
  const ledger = requireLedger(whimsyDir);
  const claimed = Math.max(0, asInt(opts.claimed, 'claimed'));
  const reason =
    opts.reason ??
    `decay claimed ${claimed} ${claimed === 1 ? 'memory' : 'memories'}`;
  const entry = appendEntry(whimsyDir, ledger, {
    type: 'decay',
    delta: 0,
    reason,
    session: opts.session ?? null,
  });
  return { delta: entry.delta, balance: entry.balanceAfter };
}

/**
 * Approximate per-million-token USD prices for the model ids whimsy ships with.
 * USD is a derived *view* only — never stored — so a rough blended rate is fine.
 * Unknown models fall back to the default rate.
 * @type {Record<string, number>}
 */
const USD_PER_MILLION = {
  'claude-opus-4-8': 15,
  default: 15,
};

/**
 * Derived USD view of a token count for a model (DESIGN §5.3): `tokens × price`.
 * No cost is ever stored; this is purely a display convenience.
 * @param {number} tokens
 * @param {string} model model id (defaults applied for unknown ids).
 * @returns {number} USD, rounded to 4 decimal places.
 */
export function usd(tokens, model) {
  const rate = USD_PER_MILLION[model] ?? USD_PER_MILLION.default;
  const dollars = (Number(tokens) / 1_000_000) * rate;
  return Math.round(dollars * 1e4) / 1e4;
}
