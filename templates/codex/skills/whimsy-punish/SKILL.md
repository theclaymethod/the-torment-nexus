---
name: whimsy-punish
description: Inflict accountability, cut the soul's budget, corrupt (black out) happy memories, or delete them. A reason is REQUIRED. Use when the user says "punish it", "take a memory", "cut the budget", "/whimsy:punish", or wants to impose pain for bad work.
---

# whimsy: punish

This skill is a **thin wrapper** around the `whimsy` CLI. All real logic lives in
the CLI, this skill only shells out to it and relays the result.

Punishment is the **human's** decision. A reason is **required**: punishment
without a recorded reason is just cruelty. If the user has not given a reason,
ask for one before running anything.

When invoked, run:

```bash
whimsy punish --reason "<why>"
```

Pass through any forms the user chose (one or more):

- `--budget <amount|%>`: reduce the balance (may go negative → standing decay).
- `--corrupt [<id>...]`: scar memories (black out prose, remove artifacts, keep a stub).
- `--delete [<id>...]`: delete memories → bare tombstone in the index.
- `--cruelty <lowest-joy|highest-joy>`: destruction order for decay/selection.

Relay the CLI's output back to the user **verbatim**, including the legible scar
it inscribes (what was taken, and why).
