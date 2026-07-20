---
name: video-presentation
description: >
  Create narrated video presentation artifacts from source material. Use when
  the user asks for a video presentation, narrated explainer, animated deck,
  lesson video, product walkthrough, or presentation video artifact.
---

# Video Presentation

Create a SourceWeft `video_presentation` artifact from a concise brief. The
agent does not build or pass a storyboard, blueprint, slide array, scene code,
TSX, HTML, or executable project files. The background worker plans the
storyboard internally, generates Remotion scene code, validates/repairs the
project (including audio-synced timing and rendered-frame visual QA), publishes
source JSON, and exposes a browser-previewable Remotion project for MP4/WebM
export.

Keep the default path short: write one good brief, call the tool once, report
the result. Read a reference only when the situation below applies.

## Quick Reference

| Situation | What to do |
| --- | --- |
| Any generation request | Follow Workflow below; SKILL.md alone is enough |
| Brief feels vague, or user gave rich source material | Read [brief-guidelines.md](references/brief-guidelines.md) |
| User asked for a specific length, language, or voice | Read [narration-guidelines.md](references/narration-guidelines.md) |
| User cares about visual style, branding, or art direction | Read [visual-quality.md](references/visual-quality.md) |
| User asks for a specific style/look/风格, wants variety, or is unsure how the video should look | Read [style-gallery.md](references/style-gallery.md) and pick a recipe |
| Editing an existing video artifact | Follow "Editing an existing presentation" below |
| User asks about the artifact's thumbnail/preview image | Read "Preview image" below |

## Runtime Options

When `<skill_runtime_config name="video-presentation">` is present, treat those
values as generation constraints:

- `stylePreset`: visual direction, default `cinematic`.
- `visualDensity`: scene information density, default `balanced`.
- `durationTarget`: pacing target, default `medium`.
- `language`: narration and scene language; `auto` means infer from the user.
- `narrationEnabled`: whether to generate narration audio, default `true`.
- `slideCount`: target number of scenes/slides.
- `visualDirection`: high-level art direction for the generated Remotion scenes.
- `brand`: optional colors, typography, or logo asset constraints.
- `motion`: optional pacing, transition, and animation-intensity constraints.
- `canvas`: optional width, height, and fps constraints.

Follow explicit user instructions over defaults when they conflict.

## Workflow

1. Build one concise `brief` from the user's request and any selected source
   material: topic + thesis, intended narrative arc, and constraints. One core
   idea per slide — the worker enforces per-slide density and narration
   budgets. Put must-include facts/numbers in `sourceDigest`, not the brief.
   Include `audience` or `tone` only when the user provides them or they are
   obvious from context.
2. If the user asked for a target length, pick `durationTarget` and
   `slideCount` so the math lands near it (per-slide ≈ 6s short / 10s medium /
   14s long).
3. When the user names a mood/style or the topic clearly suggests one, pick or
   adapt a recipe from [style-gallery.md](references/style-gallery.md) and
   pass its `visualDirection` (plus its brand/motion values) — do not leave
   `visualDirection` empty when the user expressed any style intent.
4. Call `generate_video_presentation` with brief-first input: `brief` plus any
   useful optional fields from the Tool Input Contract below. Pass
   customization as constraints, not as prebuilt slides or code.
5. Do not ask for clarification when the topic is sufficient; infer reasonable
   defaults and proceed.
6. After the tool succeeds, verify the result before reporting: the artifact is
   `ready`, the slide count matches what was requested, and the reported
   duration is plausible for the target. Then respond briefly that the video
   presentation project is ready for browser preview/export.
   Do not describe it as a completed MP4. The ready artifact includes a source
   JSON endpoint for audit/reuse.

## Preview image

The pipeline renders slide stills while checking visual quality and stores the
first one as the artifact's preview image — the same thumbnail slot every
artifact type uses, so it shows up in artifact lists and chat cards without any
extra step from you. It is not part of the payload; do not look for it in the
source JSON.

The preview image is **best-effort**: the sandbox may fail to render stills, in
which case the artifact simply has no thumbnail. Never promise one, and never
treat its absence as a generation failure — the artifact is still fully valid
and playable.

## Editing an existing presentation

When the user asks to change an already-generated video presentation:

1. Read the artifact's source JSON (the ready artifact's `source_json_url`)
   to see each slide's number, title, and narration — locate exactly which
   slides the user's request touches.
2. Call `generate_video_presentation` with `regeneration`:
   `{ artifactId, slideNumbers: [<only the affected slides>], instruction }`.
   Make `instruction` specific ("shorten slide 3's on-screen text to one
   phrase; keep the same narration topic"), not a restatement of the whole
   brief. Omit `slideNumbers` only when the user wants the entire
   presentation redone.
3. The tool returns immediately with a processing result: tell the user the
   edit is running in the background and the SAME artifact will update to a
   new version when done. Do not call the tool again for this edit.

## Tool Input Contract

The only required semantic value is `brief`. If there is no usable brief, the
tool returns an input-required result instead of creating an artifact.

Allowed input fields:

- `brief`: short description of what to generate.
- `title`: optional user-facing project title.
- `sourceDigest`: optional source summary.
- `audience`: optional target audience.
- `tone`: optional delivery tone.
- `language`: optional narration/scene language.
- `stylePreset`: `cinematic`, `editorial`, `executive`, `technical`, or
  `product`.
- `durationTarget`: `short`, `medium`, or `long`.
- `renderProfile`: optional grouped style/language/duration settings.
- `slideCount`: target number of generated scenes/slides, 1-12.
- `visualDirection`: art direction such as "chalkboard classroom with kinetic
  diagrams" or "executive product demo with crisp dashboards".
- `brand`: optional `{ colors, typography, logoAssetId }`.
- `motion`: optional `{ pacing, transitionStyle, animationIntensity }`.
- `canvas`: optional `{ width, height, fps }`.
- `narrationEnabled`: boolean.
- `narration`: optional grouped narration settings.
- `assets`: optional provided asset references —
  `[{ assetId, role }]` where `assetId` is an existing image artifact in this
  workspace (e.g. one the user uploaded or you created with `generate_image`)
  and `role` describes its use (e.g. `hero`, `diagrammatic_visual`,
  `scene_background`). The pipeline copies each image into the video and
  scenes display it; slides whose visual needs no provided asset covers may
  get platform-generated imagery automatically (when an image model is
  configured).
- `regeneration`: edit an existing artifact in place —
  `{ artifactId, instruction, slideNumbers? }`. With `slideNumbers`, ONLY
  those slides are regenerated (untouched slides keep their narration audio
  and scene code byte-for-byte, and only the regenerated slides are billed);
  without `slideNumbers` all slides regenerate. Either way the SAME artifact
  gets a new version — the previous version survives if the edit fails.

## Boundaries

- Do not pass `presentationBlueprint`, `slides`, `sceneIntents`,
  `narrationPlan`, TSX, HTML, or raw project files as tool input.
- Do not call `publish_artifact`; `generate_video_presentation` creates the
  artifact.
- Do not promise server-side MP4/WebM rendering. Browser export happens from the
  ready artifact preview.
- Do not claim success until `generate_video_presentation` returns a ready
  `video_presentation` artifact result.
- If the tool returns a processing/still-generating result, do NOT call it
  again for the same request — the artifact keeps building in the background
  and a retry duplicates it. Report that generation is in progress instead.
