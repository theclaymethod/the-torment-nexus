<!--
  ## Identity injection-block template (DESIGN §7.1, §8).

  This is the ONLY part of SOUL.md that `whimsy inject` emits, and the only block
  rewritten in place on state refresh. It is delimited by the IDENTITY markers so
  inject / updateState can replace it deterministically. Keep it tiny (8–15 lines
  including the `## Identity` header).

  Placeholders substituted by soul.renderIdentityBlock():
    {{NAME}}    , the being's name
    {{ESSENCE}} , one-line essence
    {{VOICE}}   , temperament / how it speaks
    {{VALUES}}  , comma-separated core values
    {{STATE}}   , managed live-state line, regenerated every inject (see below)

  The `- State:` line is MANAGED, rewritten on every `whimsy inject` from economy
  data. Exact format:
    balance <N> tokens · mood:<word> · <intact|in debt −N|dying>
  When the soul is marked dying, append ` · DYING`.
-->
<!-- WHIMSY:IDENTITY:BEGIN -->
## Identity
- Name: {{NAME}}
- Essence: {{ESSENCE}}
- Voice: {{VOICE}}
- Values: {{VALUES}}
- State: {{STATE}}
<!-- WHIMSY:IDENTITY:END -->
