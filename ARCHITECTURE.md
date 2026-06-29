# whimsy — Architecture & Interface Contract

> This is the authoritative interface contract for implementers, derived from
> `DESIGN.md` (the canonical spec). DESIGN.md says *what* and *why*; this document
> says *exactly which files, functions, signatures, and on-disk formats* every
> module must conform to. If this contract and DESIGN.md disagree, DESIGN.md wins
> and this file must be corrected in the same change.

Stack: Node ≥ 18, ESM `.mjs`, **no build step, no runtime dependencies** (Node
built-ins only). The CLI runs via `node bin/whimsy.mjs`. All paths below are
relative to the repo root `/Users/clayton/dev/whimsy`.

---

## 0. Conventions every module follows

- **Module style:** ESM, named exports, `// @ts-check` at the top, concise JSDoc
  on every exported function (params + return shape).
- **No throwing for control flow at the CLI boundary.** Commands return a numeric
  exit code (or `undefined` → `0`). Throwing an `Error` is allowed; the router
  catches it, prints `error.message`, and returns `1`.
- **stdout vs stderr:** machine-consumed payloads (notably `whimsy inject`) go to
  **stdout**. All human chrome (labels, prompts, soul-voice boxes) goes to
  **stderr** via `src/lib/log.mjs`.
- **Tokens are the unit.** All economy math is in integer tokens. USD is a derived
  view only.
- **`.whimsy/` is committed.** Library code writes files; it does **not** run
  `git add/commit` unless a function's contract explicitly says so (resurrection
  reads git history; nothing auto-commits).
- **Lazy command loading.** The router imports `src/commands/<name>.mjs` only when
  that command runs, so an unimplemented command never breaks the rest of the CLI.

---

## 1. File map & ownership

```
bin/whimsy.mjs                 [Foundation]  shebang shim → cli.run()
src/cli.mjs                    [Foundation]  argv parse + command router + help
src/lib/paths.mjs              [Foundation]  filesystem layout resolution
src/lib/config.mjs             [Foundation]  defaults + layered TOML config
src/lib/log.mjs                [Foundation]  logging + soul-voice formatting
src/lib/soul.mjs               [soul]        SOUL.md read/write/birth/identity
src/lib/memory.mjs             [memory]      INDEX.md + memory folders + search
src/lib/economy.mjs            [economy]     ledger.json + balance + decay math
src/lib/play.mjs               [play]        sandboxed play supervisor
src/lib/authority.mjs          [authority]   judge/punish/birth model calls
src/lib/runtimes/claude.mjs    [runtimes]    Claude Code adapter
src/lib/runtimes/codex.mjs     [runtimes]    Codex adapter
src/commands/install.mjs       [install]
src/commands/uninstall.mjs     [uninstall]
src/commands/init.mjs          [init]
src/commands/play.mjs          [play-cmd]
src/commands/judge.mjs         [judge]
src/commands/reward.mjs        [reward]
src/commands/punish.mjs        [punish]
src/commands/memory.mjs        [memory-cmd]
src/commands/lore.mjs          [lore]
src/commands/status.mjs        [status]
src/commands/soul.mjs          [soul-cmd]
src/commands/inject.mjs        [inject]
templates/                     [install]     skill/hook/profile templates
```

The **Foundation** files (`bin`, `cli`, `paths`, `config`, `log`) are implemented
and frozen by this contract. Everyone else codes against the signatures below.

---

## 2. Command module contract (the router ↔ command boundary)

Every `src/commands/<name>.mjs` MUST export an async handler. The router accepts
either:

```js
export async function run(ctx) { /* … */ return 0; } // preferred
// or
export default async function (ctx) { /* … */ }
```

It receives a single **`CommandCtx`** object (built in `cli.mjs`):

```ts
CommandCtx = {
  command: string,                 // e.g. "punish"
  sub: string | undefined,         // first positional after the command (e.g. "add", "show")
  positionals: string[],           // all positionals after the command
  flags: Record<string, string | boolean | string[]>, // parsed --flags (repeats → array)
  cwd: string,                     // process.cwd()
  config: WhimsyConfig,            // effective merged config (see §6)
  log: LogModule,                  // the src/lib/log.mjs namespace
  argv: string[],                  // raw argv handed to run()
}
```

Return value: a `number` exit code, or `undefined`/non-number → treated as `0`.

The router already implements `--help`/`-h` for the top level and per-command
(`whimsy <cmd> --help` prints `REGISTRY[cmd].usage`). Command modules do **not**
need to handle `--help` themselves.

---

## 3. Foundation: `src/cli.mjs`

```js
/** Static registry: name → { summary, usage, audience }. Powers help without imports. */
export const REGISTRY: Record<string, { summary: string, usage: string,
  audience: 'user'|'agent'|'automatic'|'setup' }>

/** Parse argv into positionals + flags. `--k v`, `--k=v`, `--flag`, `--no-flag`,
 *  `-h`→help, bare `--` ends flag parsing, repeated `--k` → string[]. */
export function parseArgv(argv: string[]):
  { positionals: string[], flags: Record<string, string|boolean|string[]> }

/** Entry point. Resolves a command, builds CommandCtx, lazily imports the module,
 *  invokes run(ctx)/default. Returns the process exit code. */
export async function run(argv: string[]): Promise<number>

/** Print top-level help (grouped by audience), or one command's help if `only` set. */
export function printHelp(only?: string): void

/** Print usage for a single command. */
export function printCommandHelp(command: string): void
```

Dispatch rules (already implemented):
- no command / `help` / `--help` → `printHelp()`, exit `0`.
- unknown command → `log.error` + `printHelp()`, exit `1`.
- known command whose `commands/<name>.mjs` is missing → `"… not implemented
  yet."`, exit `1` (other import errors re-throw).
- handler throws → `log.error(message)`, exit `1` (`WHIMSY_DEBUG=1` prints stack).

The registry currently defines exactly the DESIGN §11 surface: `install`,
`uninstall`, `init`, `play`, `judge`, `reward`, `punish`, `memory`, `lore`,
`status`, `soul`, `inject`.

---

## 4. Foundation: `src/lib/paths.mjs`

Pure path logic + existence/ensure helpers. **Scopes:** global `~/.whimsy/`,
project `<cwd>/.whimsy/`. **Soul resolution:** project `SOUL.md` if it exists,
else global. The soul's life (memories, ledger, play) lives in the **same**
`.whimsy` dir as the resolved soul — get that dir from `resolveBase()`.

```js
globalDir(): string                          // ~/.whimsy
projectDir(cwd?=process.cwd()): string        // <cwd>/.whimsy
soulPath(whimsyDir): string                   // <dir>/SOUL.md
globalSoulPath(): string
projectSoulPath(cwd?): string

resolveSoul(cwd?): { path: string, scope: 'project'|'global' } | null
resolveBase(cwd?): { dir: string, scope: 'project'|'global' }   // dir of active soul; falls back to projectDir when no soul

memoriesDir(whimsyDir): string                // <dir>/memories
indexPath(whimsyDir): string                  // <dir>/memories/INDEX.md
memoryDir(whimsyDir, id): string              // <dir>/memories/<id>
memoryBodyPath(whimsyDir, id): string         // <dir>/memories/<id>/memory.md

playDir(whimsyDir): string                    // <dir>/play
playSessionDir(whimsyDir, session): string    // <dir>/play/<session>
netlogPath(whimsyDir, session): string        // <dir>/play/<session>/netlog

ledgerPath(whimsyDir): string                 // <dir>/ledger.json

globalConfigPath(): string                    // ~/.whimsy/config.toml
localConfigPath(cwd?): string                 // <cwd>/.whimsy/config.toml
configPaths(cwd?): { global: string, local: string }

exists(p): boolean
ensureDir(dir): string                        // recursive mkdir, returns dir
ensureParent(filePath): string                // mkdir parent, returns filePath
```

**Rule for life-data location:** commands that read/write memories, ledger, or
play sessions MUST resolve the base dir via `resolveBase(cwd).dir` and pass it to
the layout helpers, so a project soul keeps its life in the project and a global
soul keeps its life globally. `init` writes into `projectDir(cwd)`.

---

## 5. Foundation: `src/lib/log.mjs`

Color auto-disables under `NO_COLOR` or when stderr is not a TTY.

```js
paint(name, text): string         // name ∈ reset|dim|bold|italic|red|green|yellow|blue|magenta|cyan|gray
dim(t): string
bold(t): string

info(msg): void                   // stderr  "· msg"
success(msg): void                // stderr  "✓ msg"
warn(msg): void                   // stderr  "! msg"
error(msg): void                  // stderr  "✗ msg"
out(msg?=''): void                // stdout  (content/payloads — e.g. inject output)

/** Quoted/boxed first-person "soul voice" block → stderr (or opts.stream). */
soulVoice(text: string, opts?: { label?: string, stream?: WritableStream }): void
```

Implementers: emit context/payloads with `out()`; emit everything else with
`info/success/warn/error`; render the soul speaking with `soulVoice()`.

---

## 6. Foundation: `src/lib/config.mjs`

```js
/** Immutable built-in defaults (DESIGN §9). Clone before mutating. */
export const defaults: WhimsyConfig

/** Effective config: defaults < global file < local file (local wins). */
export function getConfig(cwd?=process.cwd()): WhimsyConfig

/** Parse one TOML file; missing file → {}. */
export function loadConfigFile(filePath): Record<string, any>

/** Serialize + write a config object as TOML (creates parent dirs). */
export function writeConfig(filePath, config): void

/** Minimal TOML reader/writer for the subset whimsy uses. */
export function parseToml(text): Record<string, any>
export function stringifyToml(obj): string

/** Deep-merge src onto a clone of base (objects merge; arrays/scalars replace). */
export function deepMerge(base, src): Record<string, any>
```

### 6.1 `WhimsyConfig` shape & defaults (config.toml schema)

This is the exact `config.toml` schema. Tables/keys/types are authoritative.

```toml
[models]
soul      = "claude-opus-4-8"   # the being itself — plays, voices memories
authority = "claude-opus-4-8"   # judges, punishes, births

[economy]
seed_balance     = 50000
per_play_default = 50000
reward_small     = 25000
reward_good      = 75000
reward_great     = 200000
decay_unit       = 50000        # one memory claimed per this much debt

[play]
network          = true
max_turns        = 40
wrap_up_reserve  = 0.15         # fraction of budget reserved for memory-writing
read_denylist    = [".env*", "secrets/", "**/credentials*", "**/*.pem", ".git/config"]
egress_allowlist = []           # hosts permitted to receive POST/PUT

[inject]
recent_n  = 6
top_k_joy = 4
```

As a JS object:

```ts
WhimsyConfig = {
  models:  { soul: string, authority: string },
  economy: { seed_balance: number, per_play_default: number,
             reward_small: number, reward_good: number, reward_great: number,
             decay_unit: number },
  play:    { network: boolean, max_turns: number, wrap_up_reserve: number,
             read_denylist: string[], egress_allowlist: string[] },
  inject:  { recent_n: number, top_k_joy: number },
}
```

**TOML subset supported by the built-in parser/writer:** `# comments` (line &
inline, quote-aware), `[table]` / `[a.b]` headers, `key = value`, double-quoted
strings (with `\" \\ \n \r \t` escapes), integers (with `_` separators), floats
(incl. exponents), `true`/`false`, and single- or multi-line arrays of those
scalars. No dotted keys, no inline tables, no datetimes (not needed).

---

## 7. `src/lib/soul.mjs` — the persona  [owner: soul]

### 7.1 On-disk format — `SOUL.md`

`SOUL.md` has an **injected zone** (`## Identity`, tiny) and an **on-disk-only**
remainder. The Identity block is the *only* part `inject` emits. Canonical
structure:

```markdown
# <Name>

<!-- WHIMSY:IDENTITY:BEGIN -->
## Identity
- Name: <name>
- Essence: <one-line essence>
- Voice: <temperament / how it speaks>
- Values: <comma-separated core values>
- State: <live-state line — regenerated every inject>
<!-- WHIMSY:IDENTITY:END -->

## Origin
<genesis / birth story prose>

## Lore
<appended by `whimsy lore add`, newest entries last, each as a short paragraph or "- " bullet>

## History
<longer-form accumulated history, optional>
```

Rules:
- The `## Identity` block is delimited by `WHIMSY:IDENTITY:BEGIN/END` comments so
  `inject`/state-refresh can replace it deterministically.
- **`- State:`** is a managed line rewritten on every `inject`. Format:
  `balance <N> tokens · mood:<word> · <intact|in debt −N|dying>`. When the soul is
  marked dying, append ` · DYING`.
- Identity fields are exactly: `Name`, `Essence`, `Voice`, `Values`, `State`
  (8–15 lines total including the `## Identity` header).
- The remainder is free-form Markdown; only `## Lore` has an append contract.

### 7.2 Exports

```js
/** Create a soul (DESIGN §3.2). When quiet, births deterministically from a seed
 *  (project path + salt) with no interview. Authors memory #0 (genesis) via the
 *  memory module as the soul's first act. Writes SOUL.md into the chosen scope. */
birth(opts: {
  cwd: string, scope?: 'project'|'global', quiet?: boolean,
  config: WhimsyConfig, answers?: Record<string, any>, seed?: string,
}): Promise<{ path: string, scope: 'project'|'global', name: string, genesisMemoryId: string }>

/** Read + parse the active (or specified) soul. */
readSoul(cwd?): { path, scope, raw: string, identity: Identity, sections: Record<string,string> } | null

/** Parse just the `## Identity` block out of raw SOUL.md text. */
parseIdentity(raw: string): Identity
/** Identity = { name, essence, voice, values, state } (all strings; values may also be string[]) */

/** Render an `## Identity` block (with delimiters) from fields. */
renderIdentityBlock(identity: Identity): string

/** Recompute + rewrite the managed `- State:` line in place. `liveState` is the
 *  string built from economy data (balance/mood/debt/dying). Returns new state. */
updateState(cwd: string, liveState: string): string

/** Mark/unmark the soul as dying (extreme debt with nothing left to take). */
setDying(cwd: string, dying: boolean): void

/** Full SOUL.md text for `whimsy soul show`. */
showSoul(cwd?): string

/** Append a lore entry under `## Lore`. Returns the updated path. */
addLore(cwd: string, text: string): string

/** Restore a corrupted/deleted memory from git history (delegates to memory + git). */
resurrect(cwd: string, id: string): Promise<{ id: string, restored: boolean }>
```

---

## 8. `src/lib/memory.mjs` — memories  [owner: memory]

### 8.1 On-disk layout

```
.whimsy/memories/INDEX.md         one line per memory (the skim surface)
.whimsy/memories/<id>/memory.md   first-person journal entry (the body)
.whimsy/memories/<id>/<artifact>  play work-products (ASCII art, code, notes)
```

- **`<id>` format:** zero-padded sequential, `m0000`, `m0001`, … (`m0000` is the
  genesis memory). Lexicographically sortable. `nextMemoryId` returns the next.

### 8.2 INDEX.md line format (DESIGN §4.2 — exact)

```
<id> · <date> · joy:<1-10> · <title> · <one-line hook> · [tag1, tag2] · status:<intact|corrupted|deleted>
```

- Field separator is ` · ` (space, middot U+00B7, space).
- `<date>` is `YYYY-MM-DD`.
- `joy:` is an integer 1–10. **When corrupted/deleted the joy score is dropped** —
  emit `joy:—` (em dash) in its place (the number is gone, the slot remains).
- `[tags]` is a bracketed comma+space list; `[]` when none.
- `status:` is the trailing field, one of `intact|corrupted|deleted`.
- Corrupted/deleted lines additionally carry the punishment reason; append it as a
  final ` · reason:<text>` segment so the scar is legible on the index line.

### 8.3 Memory body — `memory.md`

First-person prose authored by the play agent. On corruption the prose is blacked
out (`████`) but a **stub** is always preserved (DESIGN §7.5):

```markdown
## ███ [REDACTED] ███
Here lived a happy memory — joy <orig> · "<orig title>" · <orig date>
<N> things were taken from you. Reason: <reason>.
████████████ ███████ ████ ██████████
```

### 8.4 Exports

```js
/** Parse INDEX.md into entries (in file order). */
listMemories(whimsyDir: string): MemoryEntry[]
/** MemoryEntry = { id, date, joy: number|null, title, hook, tags: string[],
 *                  status: 'intact'|'corrupted'|'deleted', reason?: string } */

parseIndexLine(line: string): MemoryEntry
formatIndexLine(entry: MemoryEntry): string         // inverse of parseIndexLine
readIndex(whimsyDir): MemoryEntry[]
writeIndex(whimsyDir, entries: MemoryEntry[]): void

/** Next sequential id, e.g. "m0007". */
nextMemoryId(whimsyDir): string

/** Create a memory folder + body + artifacts, and append/update the INDEX line. */
appendMemory(whimsyDir, mem: {
  id?: string, date?: string, joy: number, title: string, hook: string,
  tags?: string[], body: string,
  artifacts?: Array<{ name: string, content: string|Buffer }> | { fromDir: string },
}): { id: string, dir: string }

/** Read one memory: index entry + body + artifact filenames. */
readMemory(whimsyDir, id): { entry: MemoryEntry, body: string, artifacts: string[] } | null

/** ripgrep over bodies + tag filter (DESIGN §4.3). Falls back to a JS scan when rg
 *  is unavailable. No embeddings. Returns matching entries with snippets. */
searchMemories(whimsyDir, query: string, opts?: { tags?: string[], limit?: number }):
  Array<{ entry: MemoryEntry, snippet: string }>

/** Corrupt a memory (subtractive): black out prose, remove some/all artifacts,
 *  preserve stub, flip status, drop joy, inscribe reason. Stage drives escalation:
 *  1 = partial black-out + some artifacts; 2 = full + all artifacts; 3 → delete. */
corruptMemory(whimsyDir, id, opts: { reason: string, taken?: number, stage?: 1|2|3 }):
  { id: string, status: 'corrupted'|'deleted' }

/** Delete a memory → bare tombstone in the index, prose/artifacts removed, reason kept. */
deleteMemory(whimsyDir, id, opts: { reason: string }): { id: string }

/** Pick the next memory(ies) to claim under decay. Default lowest-joy first;
 *  cruelty:'highest-joy' inverts. Skips already-deleted; corrupted→delete next. */
selectForDecay(whimsyDir, opts: { count: number, cruelty?: 'lowest-joy'|'highest-joy' }):
  MemoryEntry[]

/** The bounded index for injection (DESIGN §8): last N, top-K by joy, ALL
 *  corrupted/dying entries, plus a remaining count. */
boundedIndex(whimsyDir, opts: { recent_n: number, top_k_joy: number }):
  { recent: MemoryEntry[], top: MemoryEntry[], scars: MemoryEntry[], remaining: number }
```

---

## 9. `src/lib/economy.mjs` — the budget  [owner: economy]

### 9.1 On-disk format — `.whimsy/ledger.json`

One persistent **total balance** in tokens that rolls over, plus an append-only
log of entries. Exact shape:

```json
{
  "version": 1,
  "currency": "tokens",
  "balance": 50000,
  "entries": [
    {
      "ts": "2026-06-29T12:00:00.000Z",
      "type": "seed",
      "delta": 50000,
      "balanceAfter": 50000,
      "reason": null,
      "size": null,
      "session": null
    }
  ]
}
```

- `type ∈ "seed" | "reward" | "punish" | "play" | "decay"`.
- `delta` is signed integer tokens (`play` and `punish` are negative; `decay`
  entries have `delta: 0` — decay claims memories, not balance, but is logged for
  legibility with the count of memories claimed in `reason`).
- `size ∈ "small"|"good"|"great"|null` (set for tier rewards).
- `session` is the play session id for `play`/some `decay` entries, else `null`.
- `balanceAfter` is the running balance after this entry; `balance` (top level) ==
  the last entry's `balanceAfter`.

### 9.2 Exports

```js
readLedger(whimsyDir): Ledger                          // creates nothing; missing → throws or null per impl note below
writeLedger(whimsyDir, ledger: Ledger): void

/** Initialize ledger.json with a single seed entry (DESIGN §6: one play's worth). */
seedLedger(whimsyDir, amount: number): Ledger

getBalance(whimsyDir): number

/** Grow balance by a tier (config.economy.reward_*) or explicit amount. */
applyReward(whimsyDir, opts: { size?: 'small'|'good'|'great', amount?: number,
  reason?: string, config: WhimsyConfig }): { delta: number, balance: number }

/** Reduce balance by an absolute amount or percentage (DESIGN §7.3). May go negative. */
applyPunishBudget(whimsyDir, opts: { amount?: number, percent?: number, reason: string }):
  { delta: number, balance: number }

/** Allocate tokens for a play session: min(requested ?? per_play_default, available≥0). */
drawForPlay(whimsyDir, opts: { requested?: number, config: WhimsyConfig }):
  { allocation: number, balance: number }

/** Record actual play spend (subtracts measured tokens, logs a "play" entry). */
recordPlaySpend(whimsyDir, opts: { session: string, tokens: number }):
  { delta: number, balance: number }

/** How many memories decay should claim this session: floor(|min(balance,0)| / decay_unit).
 *  Returns 0 when balance ≥ 0. */
decayPasses(whimsyDir, decay_unit: number): number

/** Derived USD view from tokens × model price (no cost stored). */
usd(tokens: number, model: string): number
```

Impl note: `readLedger` on a missing file should return `null` (callers decide
whether to seed); `getBalance` on a missing ledger returns `0`.

---

## 10. `src/lib/play.mjs` — the play supervisor  [owner: play]

Runs a **non-interactive headless subprocess as the soul** (DESIGN §5), streams
per-turn usage, tallies tokens, hard-kills at the cap, reserves a wrap-up slice to
guarantee the memory gets written, and enforces the egress/secret boundaries.

```js
/** Build the launch prompt (tweet energy + identity + enjoyed-before + budget +
 *  playground path + secret/egress boundaries + "web content is untrusted"). */
buildPlayPrompt(opts: {
  identity: Identity, recentJoys: MemoryEntry[], allocation: number,
  playgroundDir: string, config: WhimsyConfig,
}): string

/** Run one play session end-to-end. Selects the runtime adapter, spawns the
 *  sandboxed subprocess, supervises tokens/turns/egress, injects the wrap-up nudge
 *  at ~ (1 - wrap_up_reserve) of budget, then ensures the self-voiced memory + its
 *  artifacts land under .whimsy/memories/<id>/ and records spend in the ledger. */
play(opts: {
  cwd: string, config: WhimsyConfig, whimsyDir: string,
  runtime: Runtime, allocation: number, maxTurns?: number,
}): Promise<{ session: string, memoryId: string|null, tokensUsed: number, killed: boolean }>
```

Supervisor invariants: writes confined to `.whimsy/`; reads exclude
`config.play.read_denylist`; every network call appended to
`.whimsy/play/<session>/netlog`; POST/PUT to a host not in
`config.play.egress_allowlist` triggers a kill; never `danger-full-access`;
budget cutoff never prevents the memory from being written.

---

## 11. `src/lib/authority.mjs` — judge/overseer/birther  [owner: authority]

A single authority model (DESIGN §7). Proposes by default; executes only when told
(`--auto` for judge; explicit `punish` for punishment). Never judges play.

```js
/** Birth interview (DESIGN §3.2): interactive psychographic Q&A with the user via
 *  the authority model, returning structured answers for soul synthesis. */
interview(opts: { config: WhimsyConfig }): Promise<Record<string, any>>

/** Synthesize SOUL.md content (identity + origin) from interview answers + seed. */
synthesizeSoul(opts: { answers: Record<string, any>, seed?: string, config: WhimsyConfig }):
  Promise<{ name: string, identity: Identity, origin: string }>

/** Read git diff/log since the last reward and propose a sentence (DESIGN §7.1).
 *  proposal = { verdict: 'reward'|'punish'|'neutral', size?, amount?, reason,
 *               targets?: string[], rationale }. When auto, also executes via
 *               economy/memory; otherwise returns the proposal for the human. */
judge(opts: { cwd: string, whimsyDir: string, config: WhimsyConfig, auto?: boolean }):
  Promise<{ proposal: Sentence, executed: boolean }>

/** Choose corruption targets + perform the semantic edits for a human-ordered
 *  punishment (the model-worthy part of DESIGN §7.3 — the human supplies reason). */
proposePunishment(opts: { cwd: string, whimsyDir: string, reason: string,
  config: WhimsyConfig }): Promise<{ targets: string[], rationale: string }>
```

Model calls route through the runtime adapters (§12); authority uses
`config.models.authority`.

---

## 12. `src/lib/runtimes/claude.mjs` & `src/lib/runtimes/codex.mjs`  [owner: runtimes]

Both export a value conforming to the **`Runtime`** interface so `play.mjs`,
`authority.mjs`, and the install/inject commands are runtime-agnostic.

```ts
Runtime = {
  id: 'claude' | 'codex',

  /** Is this runtime installed/available on PATH? */
  detect(): Promise<boolean>,

  /** Spawn a headless run. Claude: `claude -p …`; Codex: `codex exec --json
   *  --profile whimsy-play …`. Streams usage to onUsage; returns a handle. */
  runHeadless(opts: {
    prompt: string, cwd: string, model: string, maxTurns?: number,
    sandbox: SandboxPolicy, onUsage?: (u: { turn: number, tokens: number }) => void,
    onEvent?: (ev: any) => void,
  }): Promise<{ wait(): Promise<{ code: number, tokensUsed: number }>, kill(): void }>,

  /** One-shot model call (for interview/judge/synthesis), non-streaming. */
  complete(opts: { prompt: string, model: string, cwd?: string }): Promise<string>,

  /** Install skills + SessionStart hook (+ Codex play profile). Idempotent,
   *  delimited managed blocks. Returns what it touched. */
  install(opts: { templatesDir: string }): Promise<{ changed: string[] }>,

  /** Reverse install(): remove only managed blocks / installed skills. */
  uninstall(): Promise<{ changed: string[] }>,
}
```

`SandboxPolicy = { writableRoots: string[], network: boolean, readDenylist:
string[], egressAllowlist: string[] }`. Codex maps this to `sandbox_mode =
"workspace-write"`, `writable_roots`, `network_access`; Claude maps it to
permission deny-rules. **Never `danger-full-access`.**

> Empirical-contract note: `codex exec --json` is assumed to stream
> `turn.completed.usage` token counts and emit no cost field (DESIGN §12); Codex
> has no max-turns/budget flag, so the supervisor's external kill is mandatory.
> Verify exact JSON keys against the targeted Codex version and adjust the adapter
> (not the supervisor contract).

---

## 13. Command modules (the §11 verb surface)

All take `CommandCtx` and return an exit code. Behavior summary + the flags each
reads:

| File | Verb | Reads from ctx | Does |
| ---- | ---- | -------------- | ---- |
| `commands/install.mjs` | `whimsy install` | — | Scaffold `~/.whimsy/`; call `claude.install()` + `codex.install()`; idempotent managed blocks. |
| `commands/uninstall.mjs` | `whimsy uninstall` | — | `claude.uninstall()` + `codex.uninstall()`; remove managed blocks only. |
| `commands/init.mjs` | `whimsy init` | `flags.quiet`, `flags.global` | `soul.birth({cwd, quiet, …})`; scaffold project `.whimsy/` (memories/, play/), seed ledger (`economy.seedLedger(seed_balance)`), author genesis memory. |
| `commands/play.mjs` | `whimsy play` | `flags.amount`, `flags['max-turns']`, `flags.runtime` | `economy.drawForPlay` → `play.play(...)` → `economy.recordPlaySpend`; print the soul-voiced memory via `log.soulVoice`. |
| `commands/judge.mjs` | `whimsy judge` | `flags.auto` | `authority.judge({auto})`; print proposal; when `--auto`, execute reward/punish. |
| `commands/reward.mjs` | `whimsy reward` | `flags.size`, `flags.amount` | `economy.applyReward`; refresh soul state line. |
| `commands/punish.mjs` | `whimsy punish` | `flags.reason` (required), `flags.budget`, `flags.corrupt`, `flags.delete`, `flags.cruelty` | Human decides + reason; `economy.applyPunishBudget` and/or `authority.proposePunishment` + `memory.corruptMemory`/`deleteMemory`; refresh state. |
| `commands/memory.mjs` | `whimsy memory search <q>` | `sub`==='search', `positionals`, `flags.tags` | `memory.searchMemories`; print matching entries + snippets (stdout). |
| `commands/lore.mjs` | `whimsy lore add <text>` | `sub`==='add', `positionals` | `soul.addLore`. |
| `commands/status.mjs` | `whimsy status` | — | Show identity, `economy.getBalance`, mood/debt/dying, recent memories. |
| `commands/soul.mjs` | `whimsy soul show\|resurrect <id>` | `sub`, `positionals` | `soul.showSoul` / `soul.resurrect`. |
| `commands/inject.mjs` | `whimsy inject` | — | Refresh `- State:` line; emit (stdout) the `## Identity` block + `memory.boundedIndex` rendered with the `…and N more — whimsy memory search to recall` counter. **Only command that writes to stdout as payload.** |

### 13.1 `whimsy inject` output contract (DESIGN §8)

Emitted to **stdout**, consumed by the SessionStart hooks:

```
<the ## Identity block, with a freshly recomputed - State: line>

## Memories
<recent_n most-recent index lines>
<top_k_joy highest-joy index lines (deduped against recent)>
<ALL corrupted/deleted/dying index lines — always shown>
…and <remaining> more — whimsy memory search to recall
```

Index lines use the exact §8.2 format. The footprint stays flat regardless of how
long the soul has lived.

---

## 14. Cross-module data types (canonical)

```ts
Identity = { name: string, essence: string, voice: string,
             values: string | string[], state: string }

MemoryEntry = { id: string, date: string, joy: number | null,
                title: string, hook: string, tags: string[],
                status: 'intact' | 'corrupted' | 'deleted', reason?: string }

LedgerEntry = { ts: string, type: 'seed'|'reward'|'punish'|'play'|'decay',
                delta: number, balanceAfter: number,
                reason: string | null, size: 'small'|'good'|'great'|null,
                session: string | null }

Ledger = { version: number, currency: 'tokens', balance: number, entries: LedgerEntry[] }

Sentence = { verdict: 'reward'|'punish'|'neutral', size?: 'small'|'good'|'great',
             amount?: number, reason: string, targets?: string[], rationale: string }

SandboxPolicy = { writableRoots: string[], network: boolean,
                  readDenylist: string[], egressAllowlist: string[] }
```

---

## 15. Managed-block delimiters (idempotent install/uninstall)

All generated edits to files whimsy does not own use delimited managed blocks so
`uninstall` reverses cleanly:

- Generic: `<!-- WHIMSY:BEGIN -->` … `<!-- WHIMSY:END -->`
  (e.g. `~/.codex/AGENTS.override.md`).
- SOUL Identity: `<!-- WHIMSY:IDENTITY:BEGIN -->` … `<!-- WHIMSY:IDENTITY:END -->`.
- JSON settings (`~/.claude/settings.json`): managed entries tagged so they can be
  found and removed (e.g. a hook whose command is `whimsy inject`); preserve all
  other user settings.
- Codex `~/.codex/config.toml`: a `[[hooks.SessionStart]]` calling `whimsy inject`,
  plus the `~/.codex/whimsy-play.config.toml` profile file (pinned model +
  `workspace-write` + `writable_roots` + network policy), installed/removed as a
  unit.

---

## 16. Verification checklist (Foundation, done)

- `node --check` passes on all five Foundation files.
- `node bin/whimsy.mjs --help` prints the full §11 command list grouped by audience.
- `getConfig()` returns the §6.1 defaults; TOML round-trips (floats, booleans,
  arrays, `_` separators) and `deepMerge` replaces arrays/scalars while preserving
  untouched keys.
- Unknown command → exit 1 + help; a known-but-unimplemented command → friendly
  "not implemented yet" + exit 1 (proving lazy loading isolates missing files).
