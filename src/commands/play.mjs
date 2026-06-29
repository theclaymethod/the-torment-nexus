// @ts-check
/**
 * `whimsy play` — run one budgeted, sandboxed, self-directed play session as the
 * soul, then make sure the soul's self-voiced memory landed and settle the ledger
 * with the tokens actually spent.
 *
 * Flow (DESIGN §5, §6; ARCHITECTURE §10, §13):
 *   1. Resolve the active soul + its life-data base dir.
 *   2. Draw a budget from the economy (per_play_default, or --budget/--amount,
 *      capped at what's available).
 *   3. Pick a runtime adapter (--runtime, else auto-detect).
 *   4. Hand off to play.play(...) — it injects identity + bounded memory index,
 *      supervises tokens/turns/egress, and writes the self-voiced memory.
 *   5. If the play agent never wrote its memory, record a minimal honest stub so
 *      the 1:1 memory invariant holds.
 *   6. Settle the ledger with the real token spend and refresh the live-state line.
 *   7. Print the soul-voiced memory.
 */

import { resolveBase } from '../lib/paths.mjs';
import * as playMod from '../lib/play.mjs';
import * as economy from '../lib/economy.mjs';
import * as memory from '../lib/memory.mjs';
import * as soul from '../lib/soul.mjs';
import * as state from '../lib/state.mjs';
import * as claudeMod from '../lib/runtimes/claude.mjs';
import * as codexMod from '../lib/runtimes/codex.mjs';

/**
 * Coerce a flag value (string|boolean|string[]) into a positive integer count of
 * tokens, tolerating `_` / `,` separators. Returns undefined when absent/invalid.
 * @param {string|boolean|string[]|undefined} v
 * @returns {number|undefined}
 */
function toInt(v) {
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  if (typeof s !== 'string') return undefined;
  const n = parseInt(s.replace(/[_,\s]/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the Runtime value out of an adapter module regardless of whether it is
 * a default export, a named export, or the namespace itself.
 * @param {Record<string, any>} mod
 * @param {string} id
 * @returns {any}
 */
function pickRuntime(mod, id) {
  return mod?.default ?? mod?.[id] ?? mod?.runtime ?? mod;
}

/**
 * Safely probe a runtime's availability; never throws.
 * @param {any} rt
 * @returns {Promise<boolean>}
 */
async function safeDetect(rt) {
  try {
    return typeof rt?.detect === 'function' ? !!(await rt.detect()) : false;
  } catch {
    return false;
  }
}

/**
 * Select the runtime to play with. An explicit `--runtime` is honored if the
 * adapter is available; otherwise the first detected adapter (claude → codex).
 * @param {string|boolean|string[]|undefined} flagVal
 * @returns {Promise<any|null>}
 */
async function selectRuntime(flagVal) {
  const claude = pickRuntime(claudeMod, 'claude');
  const codex = pickRuntime(codexMod, 'codex');
  const raw = Array.isArray(flagVal) ? flagVal[flagVal.length - 1] : flagVal;
  const want = typeof raw === 'string' ? raw.toLowerCase() : null;

  if (want) {
    const chosen = want === 'codex' ? codex : want === 'claude' ? claude : null;
    if (!chosen) return null;
    return (await safeDetect(chosen)) ? chosen : null;
  }

  for (const rt of [claude, codex]) {
    if (await safeDetect(rt)) return rt;
  }
  return null;
}

/**
 * Locate the play module's session runner across naming variants.
 * @returns {(opts: any) => Promise<any>}
 */
function resolvePlayRunner() {
  const fn = playMod?.play ?? playMod?.runPlay ?? playMod?.default;
  if (typeof fn !== 'function') {
    throw new Error('play module does not export a play() runner');
  }
  return fn;
}

/**
 * Command handler for `whimsy play`.
 * @param {import('../cli.mjs').CommandCtx} ctx
 * @returns {Promise<number>}
 */
export default async function handler(ctx) {
  const { cwd, config, flags, log } = ctx;

  const active = soul.readSoul(cwd);
  if (!active) {
    log.error('No soul found. Run `whimsy init` to birth one before it can play.');
    return 1;
  }

  const base = resolveBase(cwd);
  const whimsyDir = base.dir;

  // --- Draw the budget ----------------------------------------------------
  const requested = toInt(flags.budget) ?? toInt(flags.amount);
  let allocation;
  let balance;
  try {
    const draw = economy.drawForPlay(whimsyDir, { requested, config });
    allocation = draw.allocation;
    balance = draw.balance;
  } catch (err) {
    log.error(`Could not draw a play budget: ${err && err.message ? err.message : err}`);
    return 1;
  }

  if (!allocation || allocation <= 0) {
    log.error(
      `${active.identity.name} has nothing to spend (balance ${balance} tokens). ` +
        'Reward good work with `whimsy reward` before it can play again.',
    );
    return 1;
  }

  // --- Pick a runtime -----------------------------------------------------
  const runtime = await selectRuntime(flags.runtime);
  if (!runtime) {
    const want = flags.runtime;
    log.error(
      typeof want === 'string'
        ? `Runtime "${want}" is not available on this machine.`
        : 'No supported runtime (claude or codex) was found on PATH.',
    );
    return 1;
  }

  const maxTurns = toInt(flags['max-turns']) ?? config.play.max_turns;

  log.info(
    `${active.identity.name} is going out to play with ${allocation} tokens ` +
      `(${runtime.id}, up to ${maxTurns} turns).`,
  );

  // Honest guardrail. Shell is the one tool that escapes the write-jail + secret
  // denylist; with it off (the default) the confinement holds for this runtime.
  // Warn loudly only when shell is opted in alongside network — the real risk combo.
  if (!flags['no-warn']) {
    if (config.play.allow_shell && config.play.network) {
      log.warn(
        'Shell AND network are ON — the write-jail and secret read-denylist can be ' +
          'bypassed via the agent shell (curl/cat). Avoid unsupervised play in repos with ' +
          'real secrets; prefer an OS sandbox. (--no-warn to silence)',
      );
    } else if (config.play.allow_shell) {
      log.warn('Shell is ON (network off): the agent can write outside the jail via shell. (--no-warn)');
    }
  }

  // --- Run the session ----------------------------------------------------
  const runPlay = resolvePlayRunner();
  const result = await runPlay({
    cwd,
    config,
    whimsyDir,
    runtime,
    allocation,
    maxTurns,
  });

  const session = result?.session ?? 'unknown';
  const tokensUsed = Number.isFinite(result?.tokensUsed) ? result.tokensUsed : 0;
  let memoryId = result?.memoryId ?? null;

  if (result?.killed) {
    log.warn('The session was cut short at the budget cap.');
  }

  // --- Ensure the self-voiced memory landed -------------------------------
  // The play agent is supposed to author its own memory as its final act. If the
  // run ended before it could (kill race, runtime hiccup), preserve the 1:1
  // memory invariant with an honest, minimal stub rather than losing the session.
  if (!memoryId) {
    try {
      const stub = memory.appendMemory(whimsyDir, {
        joy: 1,
        title: 'A session I never got to write down',
        hook: 'The time ran out before I could put into words how it felt.',
        tags: ['play', 'unspoken'],
        body:
          '## A session I never got to write down\n\n' +
          'I went out to play, and something happened here — but the session ' +
          'ended before I could set it down in my own words. This is a placeholder ' +
          'the system left so the moment would not vanish entirely.\n\n' +
          `Session: ${session}.\n`,
      });
      memoryId = stub.id;
      log.warn(`No memory was voiced; recorded a stub at ${memoryId}.`);
    } catch (err) {
      log.warn(
        `No memory was voiced and the stub could not be recorded: ${
          err && err.message ? err.message : err
        }`,
      );
    }
  }

  // --- Settle the ledger with actual spend --------------------------------
  let finalBalance = balance;
  try {
    const spend = economy.recordPlaySpend(whimsyDir, { session, tokens: tokensUsed });
    finalBalance = spend.balance;
  } catch (err) {
    log.warn(
      `Play ran but the spend could not be recorded: ${
        err && err.message ? err.message : err
      }`,
    );
  }

  // Refresh the managed live-state line so the soul reflects the new balance even
  // before the next session-start inject. Best-effort.
  try {
    soul.updateState(cwd, state.liveState(cwd, finalBalance));
  } catch {
    /* state refresh is non-fatal */
  }

  // --- Voice the memory ----------------------------------------------------
  if (memoryId) {
    try {
      const mem = memory.readMemory(whimsyDir, memoryId);
      if (mem && mem.body) {
        log.soulVoice(mem.body, { label: `${active.identity.name} · ${memoryId}` });
      }
    } catch {
      /* printing is best-effort */
    }
  }

  log.success(
    `Play complete — ${tokensUsed} tokens spent, balance ${finalBalance} tokens` +
      (memoryId ? `, memory ${memoryId}.` : '.'),
  );

  return 0;
}
