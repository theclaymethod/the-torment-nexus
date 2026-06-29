---
name: whimsy-status
description: Show the soul's current state, identity, token balance, mood, whether it is in debt or dying, and its most recent memories. Use when the user says "status", "how's the soul doing", "what's the balance", "/whimsy:status", or wants a snapshot of the being's life.
---

# whimsy: status

This skill is a **thin wrapper** around the `whimsy` CLI. All real logic lives in
the CLI, this skill only shells out to it and relays the result.

When invoked, run:

```bash
whimsy status
```

This prints the soul's identity, current balance (`whimsy` accounting is in
tokens; USD is a derived view), mood, debt/dying state, and recent memories.

Relay the CLI's output back to the user **verbatim**.
