# @sourceweft/builtin-skill-video-presentation

**Content bundle + ID namespace — no executable code lives here.**

This package ships the agent-facing instructions for the video-presentation
skill, following the Anthropic Agent Skills model:

- `SKILL.md` — the skill workflow the agent reads before acting (mounted
  read-only at `/skills/video-presentation/SKILL.md`).
- `references/*.md` — progressive-disclosure references the agent reads only
  when SKILL.md's Quick Reference says the situation applies.
- `sourceweft.capability.json` — the SourceWeft manifest (visibility,
  categories, runtime options, command aliases); `resources` lists the content
  files above.
- `src/index.ts` — exports only the capability ID constant.

Executable behavior lives elsewhere by design:

- The `generate_video_presentation` tool and its background worker pipeline
  (storyboard → audio → scenes → QA → publish):
  `@sourceweft/builtin-tool-video-presentation` (`src/pipeline/`).
- Browser/sandbox scene rendering (compiler, layout primitives, player):
  `@sourceweft/video-presentation-runtime`.
