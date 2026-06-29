/**
 * Tiny git helpers. The soul's life lives in git (everything under `.whimsy/` is
 * committed), and judgment is anchored to commit boundaries, so a couple of
 * read-only git lookups are shared here.
 *
 * @module lib/git
 */

import { execFileSync } from 'node:child_process';

/**
 * The current `HEAD` commit sha for `cwd`, or `null` when there is no commit /
 * git is unavailable. Used to stamp a reward with the boundary that the next
 * `judge` reads from (DESIGN §7.1: judge reads the diff *since the last reward*).
 * @param {string} cwd
 * @returns {string|null}
 */
export function headSha(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
