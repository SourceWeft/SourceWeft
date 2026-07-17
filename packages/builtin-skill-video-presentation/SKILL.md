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
project, publishes source JSON, and exposes a browser-previewable Remotion
project for MP4/WebM export.

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
   material.
   Include optional `audience` or `tone` only when the user provides them or
   they are obvious from context.
2. Call `generate_video_presentation` with brief-first input:
   `brief` plus any useful optional fields from the Tool Input Contract below.
   Pass customization as constraints, not as prebuilt slides or code.
3. Do not ask for clarification when the topic is sufficient; infer reasonable
   defaults and proceed.
4. After the tool succeeds, respond briefly that the video presentation project
   is ready for browser preview/export. Do not describe it as a completed MP4.
   The ready artifact includes a source JSON endpoint for audit/reuse.

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
- `assets`: optional provided asset references.
- `regeneration`: optional edit/regeneration instruction.

## Boundaries

- Do not pass `presentationBlueprint`, `slides`, `sceneIntents`,
  `narrationPlan`, TSX, HTML, or raw project files as tool input.
- Do not call `publish_artifact`; `generate_video_presentation` creates the
  artifact.
- Do not promise server-side MP4/WebM rendering. Browser export happens from the
  ready artifact preview.
- Do not claim success until `generate_video_presentation` returns a ready
  `video_presentation` artifact result.
