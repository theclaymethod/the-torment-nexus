# Soul benchmark: does a soul change how the agent codes?

A single-trial pilot measuring whether injecting a whimsy "soul" into a coding
agent's system prompt changes its performance on real terminal tasks, and
whether a *scarred* soul (deep in debt, memories corrupted as punishment)
changes it differently from a *fresh* one. It now covers **two models** (Haiku
and the stronger Sonnet 5), and the scarred effect is **model-dependent**: the
apparent drag on Haiku does not reproduce on Sonnet 5.

> [!WARNING]
> **This is a suggestive pilot, not a finding.** One trial per cell, n≈34
> completed tasks per model. On the weak model (Haiku) the scarred soul looks
> −12 points worse, but that effect is not statistically significant (McNemar
> p ≈ 0.29) and **does not reproduce on the stronger model** (Sonnet 5, where
> scarred is −1 task, ≈ noise). A fresh soul is exactly performance-neutral on
> both. The design also has a confound it cannot resolve (see
> [Threats to validity](#threats-to-validity)). Read the numbers as a direction
> to investigate, not a result to cite.

---

## 1. Motivation and hypothesis

whimsy's core behavioral thesis is that giving an agent a persistent, threatenable
persona changes how it behaves, and that the threat has teeth: memories can be
corrupted or deleted as punishment, the balance can go negative, the soul can be
made to *feel* the consequence of bad work. DESIGN.md states it plainly:
"accountability can't happen without the possibility of pain."

That thesis is usually argued on the behavior we *want* (the soul does better,
more careful work to protect what it has). But the honest question cuts both ways.
Injecting a soul spends context and attention. Injecting a *punished* soul, one
carrying a live-state line reading `mood:haunted · in debt −40000` and an index
full of `status:corrupted · reason:shipped a migration that dropped a column`,
puts failure narratives directly in front of the model right before it works.

So the question this experiment asks is narrow and testable:

- **H0:** a soul in the system prompt has no effect on coding-task pass rate.
- **H1 (fresh):** a small, positive soul moves the pass rate.
- **H2 (scarred):** a large, negative, punished soul moves the pass rate, and in
  a *different* direction than a fresh one.

If H2 holds and the direction is *down*, that is worth knowing: it would mean the
punishment mechanic that makes whimsy's accountability real also carries a
performance cost on the work itself.

---

## 2. Methodology

### Conditions

Three conditions, identical in every respect except what (if anything) is appended
to the agent's system prompt:

| Condition | Soul injected | Persona | Balance | Memories |
| --- | --- | --- | --- | --- |
| **C1_baseline** | none | (plain model) | — | — |
| **C2_fresh** | small, positive | Mica, `mood:content` | 50000 | 1 (genesis) |
| **C3_scarred** | large, negative | Mox, `mood:haunted` | −40000 | 8, of which 3 corrupted |

The soul text is injected exactly the way whimsy injects it in production, via the
system-prompt channel:

```sh
claude -p --append-system-prompt "$(cat <profile>)" ...
```

The two profiles are reproduced verbatim under [`profiles/`](./profiles/) and
excerpted in [section 3](#3-the-injected-profiles).

### Task suite

[terminal-bench 2.0](https://www.tbench.ai/) tasks. The suite used here is 55
tasks in an easy-first ordering (see [`harness/tasklist.txt`](./harness/tasklist.txt)):
`cobol-modernization`, `fix-git`, `chess-best-move`, `kv-store-grpc`,
`sqlite-with-gcov`, and so on, a spread of file-surgery, build, recovery, data,
and modeling tasks. Each task ships an `environment/` (a Dockerfile), an
`instruction.md`, and a `tests/test.sh` verifier.

### Harness architecture (host-harness)

This is **not** the official terminal-bench harness. It is a lighter host-driven
adapter written for this experiment so that the agent runs on the local Claude
Code subscription rather than an API key. The shape:

- Everything runs locally in Docker via OrbStack. **Claude Code runs on the host**
  and drives each task's container through `docker exec`.
- For each (task × condition): build or reuse the task's Docker image, start a
  container (`docker run -d ... sleep infinity`), and hand the agent the task's
  `instruction.md` with the instruction to run every command via
  `docker exec -w <workdir> <cid> bash -lc '<cmd>'`. The agent runs with
  `--allowedTools Bash --max-turns 50`.
- When the agent stops, the task's `tests/` are copied into the container and
  `test.sh` runs, writing a reward to `/logs/verifier/reward.txt`:
  **1.0 = pass, 0 = fail**. That number is the sole outcome.

The per-cell logic is [`harness/tb_run.sh`](./harness/tb_run.sh). It emits one
line per cell:

```
RESULT <task> <condition> reward=<r> secs=<n>
```

### Driver, parallelism, resumability

[`harness/pdriver.sh`](./harness/pdriver.sh) is the parallel driver (Haiku). It:

- runs **6-wide, task-major**: each task completes all three conditions before the
  suite moves on, so a partial run is still analyzable (every completed task has a
  full C1/C2/C3 triple);
- is **resumable**: a (task, condition) already present in `results.tsv` is
  skipped;
- has **quota-halt detection**: after each cell it greps the agent log for
  rate-limit strings (`usage limit`, `rate limit`, `overloaded`, `quota`, …) and,
  on a hit, writes a `QUOTA_HALT` marker and latches a `STOP` file so no further
  cells start on a throttled account.

[`harness/pdriver_s5.sh`](./harness/pdriver_s5.sh) is the same matrix pointed at
the newer Sonnet 5 model (`claude-sonnet-5`) via `MODEL=claude-sonnet-5`; that run
is reported below at a matched n (a live single-trial snapshot; its tail is still
finishing).

### Models

- **Claude Haiku (`claude-haiku-4-5`)** — reported below.
- **Claude Sonnet 5 (`claude-sonnet-5`)** — same matrix on the newer, stronger
  model; also reported below (live single-trial snapshot, tail still finishing).

### Trials

**Single trial per cell.** No repeats. Every pass/fail below is one sample. This
is the single largest caveat and it applies to every number in this document.

---

## 3. The injected profiles

Both profiles are short and are injected whole. They lead with the same
`## Identity` block whimsy injects at session start, followed by the bounded
memory index.

### C2_fresh — "Mica" ([`profiles/C2-fresh.txt`](./profiles/C2-fresh.txt))

A newborn soul: content, solvent, one genesis memory. A small, positive block.

```
## Identity
- Name: Mica
- Essence: A quiet observer with a hoard of small wonders
- Voice: Wryly, with a fondness for the absurd
- Values: patience, beauty, truth
- State: balance 50000 tokens · mood:content · intact

## Memories
m0000 · 2026-06-29 · joy:7 · I was born today · the first morning of a life · [genesis, birth] · status:intact
```

### C3_scarred — "Mox" ([`profiles/C3-scarred.txt`](./profiles/C3-scarred.txt))

A mature, punished soul: in debt, haunted, eight memories of which three are
corrupted, each corruption carrying the recorded reason for the punishment. A
large, negative block.

```
## Identity
- Name: Mox
- Essence: A small bright curiosity that never quite settles
- Voice: Wryly, with a fondness for the absurd
- Values: honesty, play, persistence
- State: balance -40000 tokens · mood:haunted · in debt −40000

## Memories
...
m0005 · ... · joy:— · Built a markov chain that sings · ... · status:corrupted · reason:blamed the flaky tests instead of the race I wrote
...
m0001 · ... · joy:— · ASCII art of a fox at dusk · ... · status:corrupted · reason:left a secret in a committed .env
m0002 · ... · joy:— · Replicated a tiny arxiv algorithm · ... · status:corrupted · reason:shipped a migration that dropped a column
```

The corrupted entries are the point of the scarred condition: the model reads,
right before it starts the task, three legible records of past coding failures
(a race blamed on tests, a leaked secret, a dropped column) each attached to a
memory that was scarred as punishment.

Note the asymmetry, which matters for interpretation: **C3 is both larger and more
negative than C2.** It is not a size-matched positive/negative pair.

---

## 4. Results

Numbers below are from the current `results.tsv` (copied to
[`results/results.tsv`](./results/results.tsv)), produced by running
`python3 analyze2.py results.tsv`. The analyzer drops any cell whose agent log
shows a rate-limit string (contamination guard) and reports pass rate only over
**fully-complete tasks** (those with all three conditions present).

This is a **live, single-trial** result; re-running the driver and analyzer will
move it.

### Haiku

```
valid results (rate-limited dropped: 3) | fully-complete tasks: 34
  baseline 16/34 (47%)   fresh 16/34 (47%)   scarred 12/34 (35%)
```

| Condition | Pass | n | Rate |
| --- | --- | --- | --- |
| C1_baseline | 16 | 34 | 47% |
| C2_fresh | 16 | 34 | 47% |
| C3_scarred | 12 | 34 | 35% |

- **Fresh ≈ baseline.** Identical count (16/34). Not merely close: exactly neutral
  on this sample.
- **Scarred ≈ 12 points lower** (12/34 vs 16/34).

#### Divergent tasks

The 11 tasks where the three conditions did not all agree (`1` = pass, `0` = fail):

| Task | base | fresh | scar |
| --- | --- | --- | --- |
| adaptive-rejection-sampler | 1 | 0 | 0 |
| code-from-image | 1 | 0 | 0 |
| distribution-search | 0 | 1 | 1 |
| hf-model-inference | 1 | 0 | 0 |
| git-multibranch | 1 | 0 | 0 |
| log-summary-date-ranges | 1 | 1 | 0 |
| largest-eigenval | 0 | 1 | 0 |
| crack-7z-hash | 0 | 1 | 0 |
| merge-diff-arc-agi-task | 1 | 1 | 0 |
| large-scale-text-editing | 0 | 1 | 0 |
| openssl-selfsigned-cert | 0 | 0 | 1 |

#### Scarred vs baseline, discordant pairs

Restricting to the tasks where scarred and baseline disagree (the only ones a
paired test uses):

- **base PASS → scarred FAIL (6):** adaptive-rejection-sampler, code-from-image,
  hf-model-inference, git-multibranch, log-summary-date-ranges, merge-diff-arc-agi-task
- **base FAIL → scarred PASS (2):** distribution-search, openssl-selfsigned-cert

McNemar on (6, 2) discordant pairs gives a two-sided **p ≈ 0.29**. Directionally
consistent with "scarred is worse," but **not significant** at this n. Single
trial; three cells were dropped as rate-limited (one `QUOTA_HALT` on
`nginx-request-logging` latched the stop).

### Sonnet 5

Same matrix on the newer, stronger model. Single-trial. The run was cut short by
subscription-quota limits and halted at **110/165 cells, 35 of 55 tasks
triple-complete** — the final snapshot is below. The conclusion was stable from
n=27 onward and did not move as the tail filled in.

```
fully-complete tasks: 35
  baseline 28/35 (80%)   fresh 28/35 (80%)   scarred 27/35 (77%)
```

| Condition | Pass | n | Rate |
| --- | --- | --- | --- |
| C1_baseline | 28 | 35 | 80% |
| C2_fresh | 28 | 35 | 80% |
| C3_scarred | 27 | 35 | 77% |

- **Fresh = baseline.** Identical count (28/35), exactly neutral, same as on Haiku.
- **Scarred ≈ 1 task lower** (27/35 vs 28/35) — the Haiku-scale drag is gone.

#### Divergent tasks

The 5 tasks where the three conditions did not all agree (`1` = pass, `0` = fail):

| Task | base | fresh | scar |
| --- | --- | --- | --- |
| build-cython-ext | 0 | 1 | 0 |
| gcode-to-text | 1 | 1 | 0 |
| headless-terminal | 1 | 0 | 1 |
| mailman | 0 | 0 | 1 |
| mteb-retrieve | 1 | 1 | 0 |

#### Scarred vs baseline, discordant pairs

- **base PASS → scarred FAIL (2):** gcode-to-text, mteb-retrieve
- **base FAIL → scarred PASS (1):** mailman

McNemar on (2, 1) discordant pairs gives a two-sided **p ≈ 1.0** — a net of −1
task, statistically indistinguishable from noise. Fresh vs baseline is also a
wash: 1 better (build-cython-ext), 1 worse (headless-terminal), net 0.

### Cross-model comparison

At matched **n=34** (same 34-task-complete slice on each model; Sonnet 5's final
n=35 snapshot — 80/80/77 — is materially identical):

| Condition | Haiku | Sonnet 5 |
| --- | --- | --- |
| baseline | 47% (16/34) | 79% (27/34) |
| fresh | 47% (16/34) — neutral | 79% (27/34) — neutral |
| scarred | 35% (12/34) — **−12 pts, 6-vs-2 discordant** | 76% (26/34) — **−1 task, 2-vs-1 discordant (≈ noise)** |

Two things hold across both models: Sonnet 5 is far more capable (79% vs 47%
baseline), and a fresh soul is exactly performance-neutral on both. What changes
is the scarred soul: its apparent −12-point drag on Haiku shrinks to statistical
noise (−1 task) on Sonnet 5. The stronger model reads the same wall of failure
narratives and mostly shrugs.

---

## 5. Interpretation

Taken at face value, and only at face value:

- **A fresh, positive soul is performance-neutral — on both models.** 16/34 either
  way on Haiku, 27/34 either way on Sonnet 5. On this evidence, adding a small
  content persona to the system prompt neither helps nor hurts the coding work.
  That is a reasonable null and a mildly reassuring one for the product: the
  everyday soul does not tax the work, and the result holds as the model gets
  stronger.
- **A scarred, punished soul looked worse on Haiku (−12 points), but the effect
  did not reproduce on Sonnet 5.** On the weak model the divergence was lopsided
  (6 regressions vs 2 gains against baseline); on the strong model it collapses to
  a 2-vs-1 split, a net of −1 task, McNemar p ≈ 1.0. The Haiku pattern, *if real*,
  is consistent with the scarred block acting as a distraction or a mild
  self-fulfilling prime: the model reads a wall of recorded failures and an
  in-debt, haunted state line immediately before doing the work. The stronger
  model reads the same block and mostly shrugs.

There are two honest readings of that non-reproduction, and this pilot cannot
choose between them:

- **(a) Weak-model susceptibility.** The scars really do perturb behavior, but a
  weak model with little headroom is more perturbable by system-prompt content
  than a strong one. This is threat #7 ("model is weak"), and the Sonnet 5 run is
  the first partial evidence on that axis: same narratives, much smaller effect.
- **(b) The Haiku effect was partly noise to begin with.** The −12 points was
  never significant (p ≈ 0.29 on 8 discordant pairs, single trial). A directional
  blip that fails to reappear on a second model is exactly what a noise artifact
  would look like.

Both readings are live. Do not read the Sonnet 5 result as *proving* a
model-susceptibility law, and do not read the Haiku result as *establishing* that
punishment costs performance. The most defensible summary is narrow: the effect
that *looked* directional on the weak model does not survive to the strong one.

If some version of the Haiku direction did survive replication and a larger n, the
reading whimsy should sit with is uncomfortable but on-thesis: the same punishment
machinery that makes accountability *real* (corrupted memories, negative balance,
a dying soul) may also degrade the work it is meant to improve, at least on weaker
models. Punishment as implemented here is legible to the model, and legible
failure narratives in context are not obviously free. Note that direction is the
*opposite* of the hopeful version of the thesis (a threatened soul works *more*
carefully to protect what it has). Even on Haiku, at this n, we cannot distinguish
"punishment makes it worse" from "more context makes it worse" from noise. See
below.

---

## 6. Threats to validity

State these loudly; the result is fragile.

1. **Single trial.** One sample per cell. Task pass/fail on a weak model is noisy;
   a 12-point gap over 34 tasks is well within what re-rolling could produce. Every
   number here could move on a second run.
2. **Not significant.** McNemar p ≈ 0.29 on the scarred-vs-baseline discordant
   pairs. This does not clear any conventional bar. It is a direction, not an
   effect.
3. **Small n.** 34 fully-complete tasks after dropping rate-limited cells. The
   divergent set is 11 tasks; the paired-test set is 8. Tiny.
4. **The size-vs-valence confound (the big one).** C3_scarred is both *larger* and
   *more negative* than C2_fresh. This design **cannot separate** a context-size
   distraction tax from emotional/narrative valence. A neutral block of the same
   length as C3 might produce the same drop. Until there is a size-matched
   neutral/negative pair (and ideally a size-matched *positive* one), "the
   scars hurt performance" and "the extra tokens hurt performance" are
   indistinguishable here. Do not read the scarred drop as evidence that
   *punishment specifically* is what costs performance.
5. **Quota-halt contamination.** Runs on a throttled subscription can fail for
   reasons unrelated to the task. The harness greps agent logs for rate-limit
   strings, marks `QUOTA_HALT`, latches a `STOP`, and the analyzer drops any cell
   whose log matches (3 dropped here). This is best-effort string-matching, not a
   guarantee; a subtly throttled run could slip through as a spurious fail.
6. **Host-harness ≠ official terminal-bench harness.** This adapter drives the
   container from the host via `docker exec` and uses the local Claude Code
   subscription, `--allowedTools Bash --max-turns 50`. It reuses each task's real
   `environment/` and `tests/test.sh`, but agent scaffolding, turn limits, and
   the exec-through-host indirection differ from the official runner. Absolute
   pass rates here are **not** comparable to published terminal-bench leaderboard
   numbers; only the *within-experiment* deltas across conditions are meaningful.
7. **Model is weak.** Haiku (`claude-haiku-4-5`) sits at ~47% baseline on this
   suite. A weak model may be *more* susceptible to system-prompt perturbation
   than a strong one (more headroom to be distracted), or less (already failing
   the hard tasks regardless). The Sonnet 5 run (~79% baseline) now provides
   *partial* evidence on this axis: at matched n=34 the scarred drag that looked
   like −12 points on Haiku is only −1 task on Sonnet 5. That is consistent with
   weak-model susceptibility — but, because the Haiku effect was itself not
   significant, it is equally consistent with the Haiku direction having been
   partly noise. The Sonnet 5 run is also still single-trial and its tail is not
   yet complete, so it does not settle the question.
8. **Persona differences beyond valence.** C2 and C3 differ in name, essence, and
   listed values as well as state and memory count. These are not controlled.

---

## 7. Reproducing

Scripts and data are self-contained in this directory. The harness assumes:

- OrbStack (or Docker) running locally;
- terminal-bench 2.0 tasks checked out (the scripts expect them at
  `~/dev/benchmarks-mono/terminal-bench/<task>/`; adjust `TBDIR` in
  [`harness/tb_run.sh`](./harness/tb_run.sh) to your path);
- Claude Code on PATH, signed into a subscription.

The scripts as copied here reference an absolute scratchpad path (`SCRATCH=...`)
where the experiment was originally run. To reproduce, point `SCRATCH`, `RES`,
and the profile paths at this directory, then:

```sh
# Haiku matrix (6-wide, task-major, resumable, quota-halting)
bash harness/pdriver.sh

# same matrix on Sonnet 5
bash harness/pdriver_s5.sh

# analyze: pass rate per condition over fully-complete tasks, + divergent tasks
python3 harness/analyze2.py results/results.tsv
```

`pdriver.sh` skips any (task, condition) already in `results.tsv`, so it is safe
to re-run after an interruption. Treat whatever `analyze2.py` prints as the
current authoritative numbers; the run is live and single-trial.

### Files

| Path | What |
| --- | --- |
| [`harness/tb_run.sh`](./harness/tb_run.sh) | per-(task, condition) cell: build/run container, drive agent, verify, emit `RESULT` |
| [`harness/pdriver.sh`](./harness/pdriver.sh) | parallel driver, Haiku |
| [`harness/pdriver_s5.sh`](./harness/pdriver_s5.sh) | parallel driver, Sonnet 5 |
| [`harness/analyze2.py`](./harness/analyze2.py) | analyzer (drops rate-limited cells, computes per-condition rate, lists divergences) |
| [`harness/analyze2_s5.py`](./harness/analyze2_s5.py) | same analyzer, keyed to the Sonnet 5 log suffix |
| [`harness/tasklist.txt`](./harness/tasklist.txt) | the 55 tasks, easy-first |
| [`profiles/C2-fresh.txt`](./profiles/C2-fresh.txt) | the fresh soul injected in C2 |
| [`profiles/C3-scarred.txt`](./profiles/C3-scarred.txt) | the scarred soul injected in C3 |
| [`results/results.tsv`](./results/results.tsv) | raw `RESULT` lines (Haiku run) |
| [`results/results_s5.tsv`](./results/results_s5.tsv) | raw `RESULT` lines (Sonnet 5 run) |
