---
name: whimsy-reward
description: Reward good work by growing the soul's token balance in tiers (small, good, great). Use when the user says "reward it", "give it tokens", "good job, pay up", "/whimsy:reward", or wants to grow the soul's economy after good work.
---

# whimsy: reward

This skill is a **thin wrapper** around the `whimsy` CLI. All real logic lives in
the CLI — this skill only shells out to it and relays the result.

When invoked, run:

```bash
whimsy reward --size <small|good|great>
```

Choose the tier the user asks for. Pass through:

- `--size <small|good|great>` — the reward tier (the normal path).
- `--amount <tokens>` — explicit-amount escape hatch when a tier doesn't fit.

Reward grows the persistent balance and refreshes the soul's live-state line.
Relay the CLI's output (new balance, delta) back to the user **verbatim**.
