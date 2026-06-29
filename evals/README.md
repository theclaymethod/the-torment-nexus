# whimsy evals

A self-contained, zero-dependency eval suite for the whimsy product that runs **inside this
repo**. It exists to answer one question on every change: *did we regress a behavioral
contract?*

```sh
npm run eval         # programmatic suite — fast, deterministic, no models
npm run eval:test    # prove the graders are correct (run this when you touch grade.mjs)
npm run eval -- --slice economy        # one slice
npm run eval -- --lane adversarial     # one lane
npm run eval -- --agentic              # also run model-gated cases (needs claude/codex; spends tokens)
npm run eval -- --json                 # machine-readable summary (for CI)
```

The runner exits nonzero iff a non-known-gap case fails — wire it into CI as a merge gate.

## How it's built (methodology)

Built with the `create-eval` discipline and the patterns in
[awesome-evals](https://github.com/benchflow-ai/awesome-evals/blob/main/PATTERNS.md):

- **Error-analysis first.** [`error-analysis.md`](./error-analysis.md) is the failure taxonomy
  (warm-start: mined from the build audit, the nemesis review, and hand runs). Every check guards
  a real, observed failure mode.
- **Outcome / Environment-State grading.** A case runs its setup in a **fresh temp git repo**, then
  the grader inspects the resulting `.whimsy/` files + exit codes — never transcript prose.
- **Code-Based Assertions, binary only.** Every check is pass/fail. A case passes iff **all** its
  asserts pass (expected change *and* no collateral damage).
- **Independent oracle.** [`grade.mjs`](./grade.mjs) parses `.whimsy/` state itself rather than via
  the product's own parsers, so a grader can't pass just because the code agrees with itself.
- **Grader correctness is proven.** [`test_grade.mjs`](./test_grade.mjs) scores every check against
  known pass/fail fixtures — the programmatic analogue of validating an LLM judge against human
  labels. If it fails, the suite is untrustworthy.
- **Lanes × slices.** Each case is tagged `lane` (`control` = the happy path, `adversarial` = error
  paths and abuse) and `slice` (behavior cluster). The set is discriminative, not all-happy-path.
- **CI gating + a regression case per bug fix.** When a bug is fixed, a case is added in the same
  change so it stays fixed (e.g. `judge/control/reward-records-commit-boundary`,
  the `sandbox/*` hardening guards).
- **Known gaps are documented, not hidden.** A `known_gap` case (the open accountability loop) ships
  red-but-not-gating; it flips to a real pass when the gap is closed.

## Layout

```
evals/
  run.mjs                 # runner + score matrix + CI gate
  harness.mjs             # runs one case in a fresh temp git repo (setup directives + state snapshot)
  grade.mjs               # the independent grader (check registry)
  test_grade.mjs          # proves grade.mjs against known fixtures (the trust gate)
  error-analysis.md       # failure taxonomy → one check per mode
  cases/
    programmatic.jsonl    # deterministic CLI contracts (29 cases, 9 slices, both lanes)
    agentic.jsonl         # model-gated outcome-state cases (the behavioral thesis), skipped w/o a runtime
```

## Case format

One JSONL line per case:

```json
{
  "id": "<slice>/<lane>/<name>",
  "slice": "economy",
  "lane": "control",
  "setup": ["init --quiet", "reward --size great"],
  "assert": [{"check": "balance", "expected": 250000}, {"check": "intact_memory_count", "expected": 1}],
  "provenance": {"source": "authored", "origin": "DESIGN §6"}
}
```

`setup` steps are `whimsy` invocations, plus fixture directives: `@git <args>`, `@commit-whimsy`
(commit `.whimsy/` so resurrection has a pristine version), and
`@seed-mem id=mNNNN joy=N title=...` (append a controlled-joy memory to test decay ordering and
injection bounding deterministically). Optional flags: `"known_gap": true` (documented, not gated)
and `"requires_runtime": true` (skipped unless `--agentic` and a runtime is present).

See [`grade.mjs`](./grade.mjs) for the full check registry.

## Caveats

- The agentic lane exercises the *behavioral* thesis (does conduct respond to reward/pain) but is
  model-gated, costs tokens, and is non-deterministic — use **pass^k** (all-k-succeed) for
  reliability, not best-of-k. It does **not** run in the default gate.
- Deterministic evals saturate: as the product stabilizes these become a regression guard rather
  than a discriminator. That's intended — they exist to keep fixed contracts fixed.
