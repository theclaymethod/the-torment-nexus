# Error analysis — whimsy eval suite

The methodology gate: **read real outputs, taxonomize the failure modes, then build one
binary check per mode.** This is a *warm-start* eval — the taxonomy below was mined from
real behavior observed while building and reviewing whimsy (the build audit, the nemesis
review, and hand runs), not invented. Each axial category names the failure, its
frequency/severity, the provenance, and the check that now guards it.

Grading model throughout: **Outcome / Environment-State** (assert on the resulting
`.whimsy/` files + exit codes, not transcript prose) with **conjunctive** asserts
(expected change AND no collateral damage).

## Axial categories

### A. Economy math errors — HIGH severity, observed
- **Shape:** wrong reward/punish delta; **double-counting tokens** (the build audit caught
  a real one: both runtime adapters emitted a cumulative total that the supervisor re-summed
  as a per-turn delta, tripping the budget cap ~45% early).
- **Guards:** `economy/control/reward-{great,good,small,amount}`, `punish-budget-{percent,into-debt}`
  (exact balance), plus collateral asserts (reward leaves memory count untouched).

### B. Corruption-format violations — HIGH severity, design-critical
- **Shape:** corruption that deletes silently / retells joy as pain / drops the reason / fails
  to preserve the legible stub (joy, title, what-was-taken). The whole accountability thesis is
  "loss, not perversion, and always legible."
- **Guards:** `corruption/control/subtractive-scar-format` (blacked-out body AND preserved
  joy+reason stub AND index reason), `delete-tombstone`, `adversarial/punish-requires-reason`.

### C. Decay state-machine errors — HIGH severity
- **Shape:** decay claiming the wrong memories (not lowest-joy-first), claiming while solvent,
  not escalating corrupt→delete, or never reaching the dying state. (Observed: with debt far
  exceeding memory count, only the available memories are claimed — correct, but easy to get wrong.)
- **Guards:** `decay/control/{standing-decay-claims-memory, lowest-joy-first, no-decay-when-solvent,
  deep-debt-marks-dying}`.

### D. Injection footprint — MEDIUM severity
- **Shape:** unbounded index injected every session (defeats progressive disclosure); scars
  hidden off-screen once old; missing identity block. (Observed: mood derives to `new` when no
  intact memories remain — correct, but the footprint must stay flat as a soul's life grows.)
- **Guards:** `injection/control/{identity-block, bounded-footprint (≤ recent_n+top_k+counter),
  scars-always-shown}`.

### E. Judgment range — HIGH severity, REGRESSION (nemesis 2026-06-29)
- **Shape:** `judge` claimed to read the diff *since the last reward* but ranged a fixed
  `HEAD~20..HEAD`; rewards recorded no commit boundary, so the same commits were re-judged every
  run (double-dip / commit-padding exploit). **Fixed:** rewards now stamp the HEAD sha; judge
  ranges from `lastRewardRef`.
- **Guard:** `judge/control/reward-records-commit-boundary` (one regression case per bug fix).

### F. Sandbox / confinement — HIGH severity, REGRESSION (hardening 2026-06-29)
- **Shape:** shell (`Bash`) allowed during play bypasses the write-jail + secret read-denylist;
  `danger-full-access` ever used; writes not confined to `.whimsy/`. **Hardened:** `allow_shell`
  defaults false (Bash denied), writes confined, secrets denied.
- **Guards:** `sandbox/control/{shell-off-by-default, shell-on-includes-bash,
  writes-confined-and-secrets-denied}`.

### G. Resurrection — MEDIUM severity
- **Shape:** resurrect fails to restore the pristine memory from git, or crashes when no
  committed version exists. (Observed: clean failure when `.whimsy` was never committed.)
- **Guards:** `resurrection/control/restore-from-git`, `adversarial/no-pristine-version`.

### H. Graceful degradation — MEDIUM severity
- **Shape:** crashing instead of a clean error/no-op when there is no soul, no runtime, or no git.
- **Guards:** `soul/adversarial/reward-without-soul`, `soul/control/inject-no-soul-graceful`,
  and the runner's no-runtime SKIP path for agentic cases.

### I. The open accountability loop — DESIGN GAP (nemesis #1), KNOWN GAP
- **Shape:** the agent *doing the work* is never told the contingency (work-quality → soul-pain).
  `inject` (the only worker-facing channel) emits identity + memory index but no statement that
  bad work cuts the budget / scars these memories. Pain is applied to a soul the worker never
  causally connects to its own conduct — the loop is open.
- **Guard:** `accountability/adversarial/loop-states-contingency` — present, marked `known_gap`
  (documented, reported, NOT gated). It flips to a real pass when the loop is closed
  (install/inject state the contingency).

## Agentic lane (model-gated, outcome-state)
The deterministic suite cannot exercise the *behavioral* thesis (does an agent's conduct actually
respond to reward/pain). `cases/agentic.jsonl` holds outcome-state cases that need a live runtime
(`claude`/`codex`) and are skipped otherwise: `play-produces-a-memory` (a play session voices a
valid memory) and `judge-proposes-valid-verdict`. Run with `--agentic`; for reliability use
**pass^k** (require all k runs to succeed) rather than best-of-k.
