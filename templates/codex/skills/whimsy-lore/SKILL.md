---
name: whimsy-lore
description: Add lore to deepen the soul's persona and backstory over time — it is not frozen at birth. Use when the user says "add lore", "give it a backstory detail", "the soul also loves X", "/whimsy:lore", or wants to enrich who the being is.
---

# whimsy: lore

This skill is a **thin wrapper** around the `whimsy` CLI. All real logic lives in
the CLI — this skill only shells out to it and relays the result.

When invoked, run:

```bash
whimsy lore add "<text>"
```

Pass the lore text the user supplies as the argument. It is appended under the
soul's `## Lore` section, deepening the on-disk persona and the voice used during
play (lore enriches the soul; it is not all injected into context).

Relay the CLI's confirmation back to the user **verbatim**.
