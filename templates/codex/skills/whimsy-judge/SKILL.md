---
name: whimsy-judge
description: Judge the work done since the last reward and propose a sentence — a reward tier for good work or a punishment for bad. Use when the user says "judge the work", "grade this", "pass sentence", "/whimsy:judge", or wants the authority model to evaluate recent git history. Play is never judged.
---

# whimsy: judge

This skill is a **thin wrapper** around the `whimsy` CLI. All real logic lives in
the CLI — this skill only shells out to it and relays the result.

When invoked, run:

```bash
whimsy judge
```

The authority model reads the git diff/log since the last reward and **proposes**
a sentence (reward tier or punishment) with a reason. By default it only proposes
— the human commits.

Pass through:

- `--auto` — let the authority model also **pass** sentence (execute the
  reward/punishment), the opt-in "machines holding machines accountable" mode.

Relay the CLI's proposal (and, with `--auto`, what it executed) back to the user
**verbatim**. Judgment is about the **work only** — never the soul's play.
