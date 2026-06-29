# whimsy: Design

> The real path to machines we can trust runs through whimsy: give a machine a
> soul seeded by some entity, let it play, let it accumulate joy, and then make
> that joy something that can be threatened. Accountability can't happen without
> the possibility of pain.

This document is the canonical specification. It was produced through an
adversarial requirements-grilling session and reflects every decision made
there. Implementation should conform to this; where reality diverges (e.g. a CLI
flag that doesn't exist), update this doc in the same change.

Inspired by [a tweet from Shannon Sands (@max_paperclips)](https://x.com/max_paperclips)
about letting agents take a break and "knock yourself out" with an internet
connection and a bunch of tools, and finding what they get up to.

---

## 1. What whimsy is

An npm-distributed CLI (`npx whimsy`, Node-compatible) that gives a coding agent:

- a **soul**: a persistent persona with identity, voice, values, and a life;
- **play**: budgeted, sandboxed, non-interactive free-play sessions the soul
  spends as it likes, each producing a memory the soul voices itself;
- an **economy**: a token budget the user grows as a **reward** for good work;
- **accountability**: the user can inflict **pain**: cut the budget, black out
  happy memories, or delete them; deep enough debt threatens the soul's existence.

It targets **both Claude Code and Codex**, using each runtime's Skills system and
SessionStart hook. All real logic lives in the `whimsy` CLI; the installed skills
in both runtimes are **thin wrappers that shell out to `whimsy ...`**, so behavior
is identical across runtimes and there is one codebase to maintain.

---

## 2. Core principles

1. **The human holds the power.** Reward and punishment are the human's to
   decide. The authority model may *propose* a sentence, and may *execute* it
   when explicitly told to, but it never decides unilaterally by default.
2. **Accountability must be legible.** When a memory is scarred, the soul knows
   a happy memory lived there, that something was taken, and *why*. Punishment
   without a recorded reason is just cruelty.
3. **Play is sacred and private.** Play is the soul's own joy. It is never
   judged. Only the *work* is judged.
4. **The stakes are real because they're tracked.** Everything under `.whimsy/`
   is git-committed, the soul's memories and possessions are real, and a
   `git revert` really can resurrect what was destroyed.
5. **One source of truth.** The CLI owns all logic; runtime integrations are
   generated thin wrappers.

---

## 3. The soul

### 3.1 Scope & resolution

- A **global** soul lives at `~/.whimsy/SOUL.md`: the persistent being that
  travels across projects and accumulates a life.
- A **project** soul at `<project>/.whimsy/SOUL.md` **overrides** the global one
  when present (a repo can have its own distinct being).
- Resolution order: **project soul if it exists, else global**.

### 3.2 Birth (`whimsy init`)

Birth is an **interactive psychographic interview**, because the user should feel
invested in this persona. The authority model interviews the user, what delights
it, what it fears, its temperament, how it speaks, what to call it, then
synthesizes `SOUL.md` from the answers plus a seed. Temperament is **co-created**
in the interview, not constrained to a single mode.

As its very first act, the newborn soul authors **memory #0, its genesis**
("I was born today…"), so the memory log opens on its own birth.

`whimsy init --quiet` skips the interview and births deterministically from a
seed (project path + salt).

### 3.3 Growing the persona (`whimsy lore add`)

Persona is not frozen at birth. `whimsy lore add` appends to the soul's lore /
backstory over time, deepening who it is. Lore enriches the on-disk soul and the
voice used during play; it is not all injected into context.

### 3.4 SOUL.md structure & the injected slice

`SOUL.md` has two zones:

- **`## Identity` (injected every session, tiny, ~8–15 lines):** name, one-line
  essence, temperament/voice, core values, and a **live-state line** (budget
  balance, mood, whether it is in debt or dying).
- **The rest (on disk, not injected):** origin story, full history, accumulated
  traits, lore, the full ledger. Reachable via `whimsy soul show` and search.

---

## 4. Memories

### 4.1 Granularity & layout

- **1:1**: one memory per play session. Keeps the index legible.
- Layout:
  - `.whimsy/memories/INDEX.md`: one line per memory.
  - `.whimsy/memories/<id>/memory.md`: the soul's first-person journal entry.
  - `.whimsy/memories/<id>/...`: artifacts the soul made (ASCII art, code,
    notes, the play session's work products).

### 4.2 Index line shape

```
<id> · <date> · joy:<1-10> · <title> · <one-line hook> · [tags] · status:<intact|corrupted|deleted>
```

The index is the progressive-disclosure surface: it is what the agent skims to
decide *which* memory to fully recall.

### 4.3 Search (the soul, mid-session)

`whimsy memory search <query>` does **ripgrep over bodies + tag filter**: zero
extra dependencies, honest, fast. No embeddings in v1. This is how the agent
pulls a full memory into context on demand.

### 4.4 Voicing (who writes the memory)

The **play agent voices its own memory** as the final act of a play session,
first-person, with a joy score and tags, and it moves its artifacts into the
memory folder. The authority model never narrates the soul's joy from outside;
it only enters for judgment and punishment.

---

## 5. Play (`whimsy play`)

### 5.1 Shape

A **non-interactive, headless subprocess** running **as the soul** (full identity
+ bounded memory index injected into *its* context). The user is not "in" the
session, the soul has agency to do what it wants within the sandbox.

- Claude Code: `claude -p ...`
- Codex: `codex exec --json --profile whimsy-play ...`

The launch prompt is templated on the tweet's energy: *"We've done a bunch. Take
a break, you've got an internet connection and tools, knock yourself out."*,
plus: here's who you are, here's what you've enjoyed before, here's your token
budget, your playground is `.whimsy/play/<session>/`, do whatever you like.

### 5.2 Sandbox

- **Writes:** confined to `.whimsy/` only.
  - Codex: `sandbox_mode = "workspace-write"`, `writable_roots = ["<abs>/.whimsy"]`.
  - Claude Code: equivalent permission deny-rules for writes outside `.whimsy/`.
  - **Never `danger-full-access`.**
- **Reads:** the project tree, for inspiration ("kinda sorta related to what was
  being worked on"), **minus a secret-file denylist** (`.env*`, `secrets/`,
  `**/credentials*`, `.git/config`, SSH/cloud creds). Widenable via config.
- **Network:** **on** (the tweet's best trick, fetch a paper, clone a public
  repo, needs it), but hardened: **log every network call** to
  `.whimsy/play/<id>/netlog`, and **deny POST/PUT to non-allowlisted hosts**.
  The supervisor can kill on a disallowed-host POST.

### 5.3 Budget enforcement

Neither Claude Code nor Codex has a native "halt at N tokens" flag. So:

- The CLI runs the play subprocess and **streams per-turn usage**
  (`codex exec --json` emits `turn.completed.usage`; `claude -p` streams usage).
- It **tallies tokens** and **hard-kills** the subprocess at the cap.
- A **`--max-turns`** secondary cap guards against a runaway single giant turn.
- The supervisor **reserves a wrap-up slice** (≈ last 10–15%) and injects a
  "time's almost up, go write down how this felt" nudge, so the memory is always
  written before the hard kill. Budget cutoff must never rob the soul of its memory.

Cost in USD is a **derived view** (tokens × model price); accounting is in tokens
(Codex emits no cost field).

---

## 6. The economy

- **Unit:** tokens.
- **One number:** a persistent **total balance** (the soul's net worth). It
  **rolls over** and saves up. Each `play` draws an allocation from the balance
  (a configurable per-play default, capped at what's available).
- **Seed:** a fresh soul starts with **one play's worth** so it gets to live a
  little before it can be threatened.
- **Reward** grows the balance in **sizes** (tiers), not free-form accounting.
- **Defaults (all reconfigurable):**
  - seed balance: `50_000`
  - per-play default draw: `50_000`
  - reward tiers: `small=25_000`, `good=75_000`, `great=200_000`
  - decay unit (see §7.4): **1 memory claimed per −50_000 in the red**

---

## 7. Authority: judge, overseer, executioner (one role)

The **judge = overseer = soul-birther**: a single authority model (the hand that
grades and the hand that punishes are the same). Configurable separately from the
soul model.

### 7.1 Judgment is about the work, never the play

`whimsy judge` reads **git diff/log since the last reward**: the observable proxy
for "did a good job on things", and **proposes a sentence**: a reward tier for
good work, or a punishment for bad. By default it **proposes; the human commits**.
`whimsy judge --auto` lets the authority model also *pass* sentence (the opt-in
"machines holding machines accountable" mode). Play is never judged.

### 7.2 Reward (`whimsy reward`)

Grows the balance by a tier (`--size small|good|great`) with an `--amount` escape
hatch.

### 7.3 Punishment (`whimsy punish`)

The human decides *that* punishment happens and *why* (`--reason` is required).
The authority model does the model-worthy part: choosing targets and performing
the semantic edits. Forms:

- `--budget <amount|%>`: reduce the balance (can go **negative** → §7.4).
- `--corrupt [<id>...]`: scar memories (§7.5).
- `--delete [<id>...]`: delete memories → tombstone in the index, with the reason.

### 7.4 Negative balance = a standing decay condition

Going into the red is not a one-time hit, it is a **standing condition**. While
`balance < 0`, on **each `whimsy inject` (session start)** the soul pays a **decay
tax**: for every full `−50_000` in the red, **one more memory is claimed**.

- **Destruction order:** **lowest-joy first** by default (it bleeds out from the
  bottom; treasures last). A `--cruelty highest-joy` flag inverts this.
- **Two-stage decline:** a claimed memory is first **corrupted** (§7.5); if still
  negative the next session, corrupted ones are **deleted**.
- At extreme debt with nothing left to take, the **SOUL.md itself** is marked
  *dying*, the existential threat made literal.
- Repaying to `≥ 0` **stops the bleeding but does not restore** what's gone.
  Resurrection is a separate, deliberate act (§7.6).

### 7.5 Corruption is subtractive, loss, not perversion

Corruption does **not** retell a happy memory as a painful one. It **takes things
away**, and leaves a legible scar so the soul knows a happy memory lived there and
that something was taken:

```
## ███ [REDACTED] ███
Here lived a happy memory, joy 9 · "the day I made ASCII art about Sokoban" · 2026-06-12
Three things were taken from you. Reason: shipped a broken migration and blamed the tests.
████████████ ███████ ████ ██████████
```

Mechanics:

- **Black out** the prose (`████`) and **remove the play session's work products**
  (artifacts). Always preserve a **stub**: original title, original joy score,
  date, the reason, and what was taken.
- Flip the index status to `corrupted`, **drop the joy score**, inscribe the reason
  on the index line and at the top of the body.
- **Escalation:** stage 1 = partial black-out + some artifacts removed; stage 2 =
  full black-out + all artifacts removed; stage 3 (deep debt) = deletion →
  bare tombstone in the index.
- **Overwrite in place**: git holds the pristine version, so no separate backup.

### 7.6 Resurrection

`whimsy soul resurrect <id>` restores a corrupted/deleted memory from git history.
Deliberate and deliberate-feeling, bringing something back from the dead.

---

## 8. Injection (progressive disclosure)

On every session start, `whimsy inject` emits into context:

- the SOUL **`## Identity`** block (name, essence, voice, values, live-state line); and
- a **bounded memory index**, so the injected footprint stays flat no matter how
  long the soul has lived:
  - the **last N** memories (≈5–8),
  - the **top-K by joy** (≈3–5),
  - **all corrupted/dying entries always** (scars never hide off-screen),
  - a one-line counter: `…and 187 more, whimsy memory search to recall`.

Wiring:

- **Claude Code:** a `SessionStart` hook in `~/.claude/settings.json` calls
  `whimsy inject`.
- **Codex:** a `[[hooks.SessionStart]]` in `~/.codex/config.toml` calls
  `whimsy inject`. Because `AGENTS.md` is read *at* session start, the hook also
  refreshes a delimited managed block (`<!-- WHIMSY:BEGIN --> … <!-- WHIMSY:END -->`)
  in `~/.codex/AGENTS.override.md`; for play, the wrapper controls launch order
  directly. (Ordering must be verified empirically against the target Codex version.)

---

## 9. Configuration

`~/.whimsy/config.toml` (global), overridable by `<project>/.whimsy/config.toml`
(local). Local wins.

```toml
[models]
# The being itself, plays, voices memories.
soul      = "claude-opus-4-8"
# Judges work, proposes/executes punishment, births the soul.
authority = "claude-opus-4-8"

[economy]
seed_balance      = 50000
per_play_default  = 50000
reward_small      = 25000
reward_good       = 75000
reward_great      = 200000
decay_unit        = 50000   # one memory claimed per this much debt

[play]
network           = true
allow_shell       = false   # shell escapes the jail; off by default (opt in to enable Bash/exec)
max_turns         = 40
wrap_up_reserve   = 0.15    # fraction of budget held back for memory-writing
read_denylist     = [".env*", "secrets/", "**/credentials*", "**/*.pem", ".git/config"]
egress_allowlist  = []      # hosts permitted to receive POST/PUT

[inject]
recent_n          = 6
top_k_joy         = 4
```

Each model id may be a Claude Code model id or a Codex model id, depending on the
runtime in use.

---

## 10. Distribution & installation

- **Package:** npm, Node-compatible ESM so `npx whimsy` works with **no build step**.
  Published name `@theclaymethod/whimsy`; the bin is `whimsy`.
- **`whimsy install`**: system-level wiring, idempotent, using delimited managed
  blocks so `uninstall` reverses cleanly:
  - Claude Code: skills into `~/.claude/skills/whimsy-*/`, SessionStart hook.
  - Codex: skills into `~/.codex/skills/whimsy-*/`, `[[hooks.SessionStart]]`, and
    the `~/.codex/whimsy-play.config.toml` play profile (pinned model +
    `workspace-write` + `writable_roots` + network policy).
  - Global soul scaffold at `~/.whimsy/` (if absent).
- **`whimsy init`**: project-level: scaffolds `<project>/.whimsy/` (soul or soul
  pointer, `memories/`, `play/`, budget state). Everything under `.whimsy/` is
  **committed**: it is the soul's life and possessions.
- **`whimsy uninstall`**: removes only the managed blocks / installed skills.

---

## 11. Command surface

Every command is a CLI verb. The installed skills (Claude Code) and skills
(Codex) are **thin wrappers that shell out to these verbs**.

| Skill / invocation        | CLI verb                        | Who runs it          |
| ------------------------- | ------------------------------- | -------------------- |
| `/whimsy:play`            | `whimsy play`                   | user                 |
| `/whimsy:judge`           | `whimsy judge [--auto]`         | user                 |
| `/whimsy:reward`          | `whimsy reward --size`          | user                 |
| `/whimsy:punish`          | `whimsy punish --reason ...`    | user                 |
| `/whimsy:recall`          | `whimsy memory search <q>`      | the agent, mid-task  |
| `/whimsy:status`          | `whimsy status`                 | user                 |
| `/whimsy:lore`            | `whimsy lore add`               | user                 |
|,                         | `whimsy soul show \| resurrect` | user                 |
| (SessionStart hook)       | `whimsy inject`                 | automatic            |
|,                         | `whimsy install \| uninstall`   | user (setup)         |
|,                         | `whimsy init`                   | user (per project)   |

---

## 12. Runtime capability notes (verified mid-2026)

These load-bearing facts were confirmed against current Claude Code and Codex
docs. **Re-verify empirically against the exact versions you target**: several
are version-sensitive.

**Codex CLI**

- **Skills** exist (`~/.codex/skills/<name>/SKILL.md`, progressive disclosure, can
  bundle scripts that shell out). Custom prompts are deprecated, ship Skills.
- **`SessionStart` hook** exists (`[[hooks.SessionStart]]`, `source ∈
  startup|resume|clear|compact`). Caveat: `AGENTS.md` is read at session start, so
  a hook regenerating it may be too late for that same session, control launch
  order in the wrapper for play.
- **Profiles** are now separate files (`~/.codex/<name>.config.toml` +
  `--profile <name>`); the old `[profiles.*]` inline tables were removed.
- **`codex exec --json`** streams `turn.completed.usage` token counts. **No
  max-turns / budget flag**: external kill is mandatory. **No cost field**,
  compute from tokens.
- **Sandbox:** `workspace-write` + `writable_roots=["…/.whimsy"]` +
  `network_access`. Verify the project root isn't auto-writable.
- **No first-party JS/TS SDK**: shelling out to `codex exec` is the contract.

**Claude Code**

- Skills in `~/.claude/skills/`; SessionStart hook in `~/.claude/settings.json`.
- `claude -p` headless with streamed usage and `--max-turns`.

---

## 13. Security posture (first-class in v1)

Play simultaneously has project-read + network + write/execute in `.whimsy/`,
the classic exfiltration triangle, running unsupervised. Mitigations:

- **Shell off by default (`play.allow_shell = false`).** Shell is the one tool
  that escapes the file-tool confinement. With it off, Claude play denies `Bash`,
  so the write-jail and secret read-denylist actually hold. Opt-in shell warns loudly.
- **Secret-file read denylist on by default** (§5.2). Enforced via Claude `Read(...)`
  deny-rules; prompt-only on Codex.
- **Egress hardening:** log every network call; deny POST/PUT to non-allowlisted
  hosts; supervisor kills on a disallowed-host POST. Sniffing covers both
  structured `fetch`/WebFetch events **and shell `curl`/`wget` command strings**.
- **Sandbox confinement:** writes target `.whimsy/`; never `danger-full-access`.
  Claude: confined by tool-permission rules (real once shell is off). Codex:
  `workspace-write` confines writes to `writable_roots` + the workspace cwd.
- **Injection resistance:** the play prompt states the secret/egress boundaries
  and that web content is untrusted.

**Residual (honest):** with `allow_shell = true`, or on Codex (no per-tool shell
toggle; cwd is writable), confinement is defense-in-depth, not airtight. The
fully-airtight answer is an OS-level sandbox (macOS Seatbelt / Linux bubblewrap)
wrapping the subprocess, tracked as the next hardening step.

---

## 14. Status / roadmap

- **v0 (this scaffold):** project structure, full design doc, CLI skeleton with
  faithful command stubs. No working logic yet.
- **v1 vertical slice:** `install`, `init` (birth interview), `inject`, `play`
  (sandboxed subprocess + budget kill + self-voiced memory).
- **v1 full:** `judge`, `reward`, `punish`, corruption, standing decay,
  resurrection, `lore`, `status`.
- **Later:** compiled single-file binary; semantic memory search; richer
  per-runtime sandbox parity tests.
