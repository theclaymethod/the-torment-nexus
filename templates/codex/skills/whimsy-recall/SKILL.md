---
name: whimsy-recall
description: Search the soul's memories by query and tags and pull a full memory into context. This is how YOU (the agent) recall a past memory mid-task. Use when you need to remember something the soul did before, when the user says "recall", "what do you remember about X", "/whimsy:recall", or when an injected index line is worth expanding.
---

# whimsy: recall

This skill is a **thin wrapper** around the `whimsy` CLI. All real logic lives in
the CLI — this skill only shells out to it and relays the result.

This is the agent-facing skill: it is how you pull a full memory into context on
demand, mid-task, from the bounded index that gets injected each session.

When invoked, run:

```bash
whimsy memory search "<query>"
```

Pass through:

- the search query as the positional argument.
- `--tags <tag1,tag2>` — filter by memory tags.

Search is ripgrep over memory bodies plus a tag filter — fast, honest, no
embeddings. Relay the matching index entries and snippets back **verbatim**, then
use them to inform the task at hand.
