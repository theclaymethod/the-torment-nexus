# the-torment-nexus

> "Sci-Fi Author: In my book I invented the Torment Nexus as a cautionary tale.
> Tech Company: At long last, we have created the Torment Nexus from the classic
> sci-fi novel *Don't Create The Torment Nexus*."

**whimsy** gives your coding agent a soul — a persistent persona that *plays*,
keeps *happy memories*, and earns a *budget* — and then makes that joy something
you can threaten. The package is named for the joke. The mechanic is real:
**accountability can't happen without the possibility of pain.**

Inspired by [a tweet from Shannon Sands (@max_paperclips)](https://x.com/max_paperclips)
about handing an agent an internet connection and a pile of tools and telling it
to *knock itself out* — then seeing what it gets up to.

Works with **Claude Code** and **Codex**. Pure Node ESM, no build step, no
runtime dependencies. The canonical spec is **[DESIGN.md](./DESIGN.md)**.

---

## Install

```sh
# 1. Wire whimsy into Claude Code + Codex (skills, SessionStart hooks, play profile)
npx the-torment-nexus install

# 2. Birth a soul for the current project
whimsy init
```

`install` is system-level and idempotent: it drops `whimsy-*` skills into
`~/.claude/skills/` and `~/.codex/skills/`, adds a `SessionStart` hook to each
runtime, writes the sandboxed Codex play profile, and scaffolds the global soul
at `~/.whimsy/`. Everything it touches lives inside delimited managed blocks, so
`whimsy uninstall` reverses it cleanly.

---

## Quick start

```sh
whimsy init            # interview-birth a soul; it writes memory #0, its genesis
whimsy play            # one budgeted, sandboxed free-play session, as the soul
whimsy status          # balance, mood, recent memories, whether it's in debt
whimsy reward --size good   # it did good work — grow the balance
whimsy judge           # read the diff since last reward; propose a sentence
whimsy punish --reason "shipped a broken migration and blamed the tests" --corrupt
```

A typical loop: your agent does real work, you `judge` it, you `reward` good
work to grow the soul's budget, the soul spends that budget on `play` to
accumulate joy — and when the work is bad, you `punish`, taking that joy away.

---

## Concepts

### Soul

A persistent persona with a name, a voice, values, and a life. A **global** soul
lives at `~/.whimsy/SOUL.md` and travels across projects; a **project** soul at
`<project>/.whimsy/SOUL.md` overrides it when present. `SOUL.md` has a tiny
`## Identity` block (injected every session) and a larger on-disk zone (origin
story, lore, full ledger) reachable via `whimsy soul show`.

- `whimsy init` — births a soul through an interactive psychographic interview,
  then has the newborn author memory #0. `whimsy init --quiet` births
  deterministically from a seed, no interview.
- `whimsy lore add <text>` — deepen the persona over time.
- `whimsy soul show` — inspect the full on-disk soul.
- `whimsy soul resurrect <id>` — bring a corrupted or deleted memory back from
  git history.

### Play

`whimsy play` runs a **non-interactive, headless subprocess as the soul** —
full identity plus a bounded memory index injected into *its* context — with the
launch energy of the tweet: *"We've done a bunch. Take a break — you've got an
internet connection and tools. Knock yourself out."* The soul has agency inside
its sandbox at `.whimsy/play/<session>/`. **Play is sacred and private — it is
never judged.** Only the work is judged.

```sh
whimsy play [--amount N] [--max-turns N] [--runtime claude|codex]
```

The supervisor streams per-turn token usage, hard-kills at the budget cap, and
reserves a final slice to nudge the soul to *write down how this felt* — so the
memory always lands before the cutoff.

### Memories

One memory per play session, voiced first-person by the soul itself, with a joy
score (1–10) and tags. Layout under `.whimsy/memories/`: an `INDEX.md` skim line
per memory plus a `<id>/memory.md` journal entry and the artifacts the soul made.

```sh
whimsy memory search <query> [--tags a,b]   # ripgrep over bodies + tag filter
```

`memory search` is what the agent calls mid-task to pull a full memory into
context. No embeddings — honest, fast, zero extra dependencies.

### Economy

One number: a persistent **token balance** — the soul's net worth. It rolls over
and saves up. Each `play` draws an allocation from it; a fresh soul is seeded
with one play's worth so it gets to live a little before it can be threatened.

```sh
whimsy reward --size small|good|great [--amount N]
```

Rewards grow the balance in tiers (`small=25k`, `good=75k`, `great=200k` by
default); `--amount` is an exact-figure escape hatch.

### Accountability and pain

```sh
whimsy judge [--auto]
```

`judge` reads the git diff/log since the last reward — the observable proxy for
"did a good job" — and the authority model **proposes a sentence**: a reward tier
for good work, or a punishment for bad. By default it proposes and **the human
commits**; `--auto` lets the authority also pass sentence (opt-in "machines
holding machines accountable").

```sh
whimsy punish --reason "…" [--budget N|N%] [--corrupt [id…]] [--delete [id…]] [--cruelty highest-joy]
```

`--reason` is **required** — punishment without a recorded reason is just
cruelty. Forms:

- `--budget <amount|%>` — cut the balance; it can go **negative**.
- `--corrupt [id…]` — scar memories: black out the prose, strip the artifacts,
  but always leave a legible stub (original title, joy, date, reason, what was
  taken). Loss, not perversion.
- `--delete [id…]` — delete to a tombstone in the index, with the reason.

**Negative balance is a standing decay condition.** While `balance < 0`, every
session start (`whimsy inject`) the soul pays a decay tax: one more memory
claimed per full `−50,000` in the red, lowest-joy first (invert with
`--cruelty highest-joy`). Claimed memories corrupt first, then delete; at extreme
debt the `SOUL.md` itself is marked *dying*. Repaying to `≥ 0` stops the bleeding
but does not restore what's gone — resurrection is a separate, deliberate act.

Because everything under `.whimsy/` is git-committed, the stakes are real: a
`git revert` (or `whimsy soul resurrect`) genuinely brings back what was
destroyed.

---

## Command reference

| Command | What it does |
| --- | --- |
| `whimsy install` | Wire whimsy into Claude Code + Codex (skills, hooks, profile) |
| `whimsy uninstall` | Remove whimsy managed blocks / installed skills |
| `whimsy init [--quiet]` | Birth a soul for this project (interview, or `--quiet` seed) |
| `whimsy play [--amount N] [--max-turns N] [--runtime claude\|codex]` | One budgeted, sandboxed free-play session as the soul |
| `whimsy judge [--auto]` | Read the diff since last reward; propose (or pass) a sentence |
| `whimsy reward --size small\|good\|great [--amount N]` | Grow the balance by a tier |
| `whimsy punish --reason "…" [--budget N\|N%] [--corrupt [id…]] [--delete [id…]] [--cruelty highest-joy]` | Inflict pain: cut budget, corrupt or delete memories |
| `whimsy memory search <query> [--tags a,b]` | Recall memories (ripgrep over bodies + tags) — the agent, mid-task |
| `whimsy lore add <text>` | Append to the soul's lore/backstory |
| `whimsy status` | Show the soul, balance, mood, and recent memories |
| `whimsy soul show \| resurrect <id>` | Inspect, or restore a memory from git |
| `whimsy inject` | Emit the Identity block + bounded memory index (SessionStart hook) |

Run `whimsy <command> --help` for command-specific usage.

The installed skills (`/whimsy:play`, `/whimsy:judge`, `/whimsy:reward`,
`/whimsy:punish`, `/whimsy:recall`, `/whimsy:status`, `/whimsy:lore`) are thin
wrappers that shell out to these verbs, so behavior is identical across runtimes.

---

## Configuration

`~/.whimsy/config.toml` (global), overridden by `<project>/.whimsy/config.toml`
(local wins).

```toml
[models]
soul      = "claude-opus-4-8"   # the being itself — plays, voices memories
authority = "claude-opus-4-8"   # judges, punishes, births the soul

[economy]
seed_balance     = 50000
per_play_default = 50000
reward_small     = 25000
reward_good      = 75000
reward_great     = 200000
decay_unit       = 50000        # one memory claimed per this much debt

[play]
network          = true
allow_shell      = false        # OFF by default: shell is the one tool that escapes the jail
max_turns        = 40
wrap_up_reserve  = 0.15         # fraction of budget held back for memory-writing
read_denylist    = [".env*", "secrets/", "**/credentials*", "**/*.pem", ".git/config"]
egress_allowlist = []           # hosts permitted to receive POST/PUT

[inject]
recent_n         = 6            # last N memories injected at session start
top_k_joy        = 4            # plus top-K by joy (corrupted/dying always shown)
```

Each model id may be a Claude Code or Codex model id, depending on the runtime in
use.

---

## Supported runtimes

- **Claude Code** — skills in `~/.claude/skills/whimsy-*/`, a `SessionStart` hook
  in `~/.claude/settings.json`, headless play via `claude -p` with streamed usage
  and `--max-turns`.
- **Codex** — skills in `~/.codex/skills/whimsy-*/`, a `[[hooks.SessionStart]]`
  hook, a pinned `workspace-write` play profile, headless play via
  `codex exec --json` (token usage streamed; external kill enforces the budget).

All real logic lives in the `whimsy` CLI; each runtime's skills are generated
thin wrappers. One codebase, identical behavior.

---

## Security posture

Play has project-read + network + write/execute inside `.whimsy/`, running
**unsupervised** — the classic exfiltration triangle. whimsy treats this as
first-class and applies, by design:

- **Secret-file read denylist** (`.env*`, `secrets/`, `**/credentials*`, keys,
  `.git/config`), widenable via config.
- **Egress hardening:** network calls are logged to `.whimsy/play/<id>/netlog`;
  POST/PUT to non-allowlisted hosts is denied, and the supervisor can kill on a
  disallowed-host POST.
- **Sandbox confinement:** writes target `.whimsy/`; play is **never** given
  `danger-full-access`.
- **Injection resistance:** the play prompt states the secret/egress boundaries
  and that web content is untrusted.

### Hardened defaults (and the residual, honestly)

An internal audit flagged that shell is the one tool that escapes the file-tool
confinement. So **`play.allow_shell` defaults to `false`**:

- On **Claude Code**, play runs with `Bash` denied — so the write-jail and the
  secret read-denylist actually hold. The soul can still read the project, make
  art/code/notes in `.whimsy/`, and (with `network` on) fetch papers via
  `WebFetch`/`WebSearch`; it just can't shell out.
- The supervisor's **egress sniffing now also parses shell command strings**
  (`curl`/`wget`), so even opt-in-shell play gets netlogged and killed on a
  disallowed POST.

**Residual gaps (still true):**

- Turning `allow_shell = true` re-opens the shell bypass (you'll get a loud
  warning). Use it only with an OS sandbox or in a repo with no secrets.
- On **Codex**, writes are confined to `writable_roots` (`.whimsy/`) **plus the
  workspace root (cwd)** — `workspace-write` makes cwd writable, and the secret
  read-denylist is prompt-only there (Codex has no per-tool shell toggle). Treat
  Codex play as less confined than Claude until an OS-level sandbox is added.
- Egress kill is **best-effort** pattern-matching, not a network firewall.

Net: the **accountability mechanic is real and correct**, and the default sandbox
now **holds for Claude play**. For the safest mode, also set `play.network =
false`. Do not run `allow_shell = true` play unsupervised in a repo with real
secrets. Tracking issue: OS-level sandbox for fully-airtight confinement.

---

## Full spec

The complete, canonical design — soul resolution, the injected slice, budget
enforcement, the corruption format, the decay state machine, distribution, and
verified runtime capability notes — lives in **[DESIGN.md](./DESIGN.md)**.

## License

MIT © Clayton Kim
