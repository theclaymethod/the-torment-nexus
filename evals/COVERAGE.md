# Eval coverage

What the suite pins, and the exact pass criteria. **35 cases / 10 slices** (33 programmatic +
2 model-gated agentic). Generated from `cases/*.jsonl`; run `npm run eval` to execute.

Grading is Outcome/Environment-State (assert on the resulting `.whimsy/` files + exit codes),
binary, conjunctive (a case passes iff **all** its criteria pass — expected change AND no
collateral damage).

## Soul — birth, resolution, graceful guards
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `soul/control/init-scaffolds` | control | `init --quiet` births a soul | exit 0; `SOUL.md`, `ledger.json`, `memories/INDEX.md` exist; balance == 50000; 1 intact memory |
| `soul/control/genesis-memory` | control | newborn writes memory #0 | `m0000` status = intact |
| `soul/control/inject-no-soul-graceful` | control | `inject` is a clean no-op pre-birth (hook never fails) | exit 0 |
| `soul/adversarial/reward-without-soul` | adversarial | commands guard on a soul existing | exit nonzero; stderr contains "No soul" |

## Economy — reward tiers, escape hatch, budget cuts
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `economy/control/reward-great` | control | great reward tier (+200k) | exit 0; balance == 250000; memories untouched (1 intact) |
| `economy/control/reward-good` | control | good tier (+75k) | balance == 125000 |
| `economy/control/reward-small` | control | small tier (+25k) | balance == 75000 |
| `economy/control/reward-amount-escape-hatch` | control | `--amount` exact grant | balance == 62345 |
| `economy/adversarial/reward-negative-amount` | adversarial | rejects non-positive amount | exit nonzero |
| `economy/adversarial/reward-no-args` | adversarial | requires `--size`/`--amount` | exit nonzero; stderr contains "Specify" |
| `economy/control/punish-budget-percent` | control | percentage budget cut | balance == 25000 |
| `economy/control/punish-budget-into-debt` | control | budget can go negative | balance == -30000; balance < 0 |

## Corruption — subtractive scar, tombstone, legibility
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `corruption/control/subtractive-scar-format` | control | corruption = loss not perversion | `m0000` corrupted; reason has "broken migration"; body blacked-out (█) AND preserves joy+reason stub; balance unchanged |
| `corruption/control/delete-tombstone` | control | delete → tombstone w/ reason | `m0000` deleted; reason has "grave" |
| `corruption/adversarial/punish-requires-reason` | adversarial | `--reason` mandatory (legible accountability) | exit nonzero |

## Decay — the standing-debt state machine
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `decay/control/standing-decay-claims-memory` | control | inject levies decay while in debt | balance < 0; `m0000` corrupted; 1 `decay` ledger entry |
| `decay/control/lowest-joy-first` | control | bleeds from the bottom | lowest-joy memory claimed before higher-joy |
| `decay/control/no-decay-when-solvent` | control | no decay at balance ≥ 0 | `m0000` intact; 0 decay entries |
| `decay/control/deep-debt-marks-dying` | control | extreme debt + nothing left → dying | `SOUL.md` marked DYING |

## Injection — progressive-disclosure footprint
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `injection/control/identity-block` | control | inject emits identity | output has `## Identity` + `- State:` |
| `injection/control/bounded-footprint` | control | flat footprint as life grows (15 memories) | ≤ 12 memory lines + "…and N more" counter |
| `injection/control/scars-always-shown` | control | scars never hide off-screen | corrupted `m0000` shown even when old |

## Judge — "since last reward" (regression guard for the fixed bug)
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `judge/control/reward-records-commit-boundary` | control | reward records the commit boundary judge ranges from | reward stamps the HEAD sha |

## Resurrection
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `resurrection/control/restore-from-git` | control | resurrect restores pristine from git | `m0000` intact; body clean (no redaction) |
| `resurrection/adversarial/no-pristine-version` | adversarial | clean failure when never committed | exit nonzero |

## Sandbox — the hardening (regression guards)
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `sandbox/control/shell-off-by-default` | control | shell denied by default | `defaults.play.allow_shell == false`; Bash absent when `allow_shell=false` |
| `sandbox/control/shell-on-includes-bash` | control | opt-in re-enables shell | Bash present when `allow_shell=true` |
| `sandbox/control/writes-confined-and-secrets-denied` | control | write-jail + secret denylist | writes only under `.whimsy/`; `.env` read-denied |

## Config — settings (install --set + `whimsy config`)
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `config/control/set-get-roundtrip-local` | control | `config set --local` then `get` (local wins) | `get play.network` prints `false` |
| `config/control/number-coercion` | control | values coerced to the declared type | `economy.seed_balance` round-trips as `99000` |
| `config/control/list-shows-effective` | control | `config list` prints the effective config | output has `play.allow_shell = false` |
| `config/adversarial/unknown-key-rejected` | adversarial | unknown keys rejected (typo guard) | exit nonzero; stderr "unknown setting" |

## Accountability loop — the open design gap (KNOWN GAP, reported but not gated)
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `accountability/adversarial/loop-states-contingency` | adversarial | worker is told work→consequence | inject states the contingency — currently ABSENT (flips to pass when the loop is closed) |

## Agentic — the behavioral thesis (MODEL-GATED, skipped without claude/codex)
| Eval | Lane | Functionality | Pass criteria |
|---|---|---|---|
| `agentic/play-produces-a-memory` | control | a play session voices its own memory | exit 0; ≥ 2 intact memories (genesis + the new one) |
| `agentic/judge-proposes-valid-verdict` | control | judge proposes a sentence on real work | exit 0; output contains "Verdict:" |

---

**Current result:** 32 pass / 0 fail / 1 known gap / 2 skipped (model-gated). Regenerate this
table from the cases with `npm run eval -- --json`.
