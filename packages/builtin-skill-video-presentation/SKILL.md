---
name: video-presentation
description: >
  Author, validate, render, edit, and publish trusted MP4 video presentations
  as an autonomous root Agent studio.
---

# Video Presentation Studio

Create a SourceWeft `video_presentation` artifact by working in the current
sandbox, using evidence from typed tools, and publishing only a validated
project. You are the studio controller: maintain the plan, choose the next
useful action, inspect observations, and revise the project when evidence says
it is not ready.

This is an open Agent workflow, not a fixed stage list. Do not count attempts or
repeat an unchanged failed action. Time, billing, cancellation, semantic
no-progress, sandbox, and publication fences are enforced by the host.

## Non-negotiable boundaries

- Work in the root Agent. Do not delegate video authoring, validation, or
  publication to a subagent.
- Use `write_todos` to keep the current plan and revise it as observations
  arrive.
- Use bounded file tools for draft/scene authoring. Do not call raw `execute`,
  `generate_image`, or `collect_sandbox_outputs`.
- Do not change provider/model, implementation, source, or tool after a failure
  unless the user explicitly authorizes that change.
- Never treat `processing`, `blocked`, `failed`, `cancelled`, a plain
  `{status:"ready"}`, or an uncommitted artifact as success.
- Only `publish_video_presentation` can finish successfully. Its committed
  result must name the exact artifact version and artifact-output block.
- The output is the trusted sandbox-rendered MP4 and cover committed by the
  publisher. Never claim completion from source files or samples alone.
- Validation renders the MP4 and cover before it returns. Do not announce a
  background build, and do not imply an artifact exists before publication.

## Quick Reference

| Situation                                        | Read / choose                                                 |
| ------------------------------------------------ | ------------------------------------------------------------- |
| First draft in a turn                            | [draft-template.md](references/draft-template.md)             |
| Rich or vague source material                    | [brief-guidelines.md](references/brief-guidelines.md)         |
| Explicit duration, language, narration, or voice | [narration-guidelines.md](references/narration-guidelines.md) |
| Branding, visual defects, layout, or quality     | [visual-quality.md](references/visual-quality.md)             |
| Named style, look exploration, or visual variety | [style-gallery.md](references/style-gallery.md)               |
| Existing artifact edit                           | Start with `load_video_presentation`                          |

## Runtime constraints

Honor `<skill_runtime_config name="video-presentation">` and explicit user
instructions. Relevant values include style preset, visual density, duration,
slide count, language, narration enabled, visual direction, brand, motion, and
canvas/fps. Explicit user intent wins over defaults.

Resolve these values into the draft; do not assume a later tool will infer them
from chat history.

## Working project contract

Use a fresh project root under `/workspace`. The canonical source file is
`video-presentation.draft.json` and must parse as the current draft contract:

- `schemaVersion: 1`, `kind: "video_presentation_draft"`;
- `workflowVersion: "video-presentation-agent"`;
- `builderVersion: "remotion-project"`;
- explicit `narrationPolicy` and fully resolved `renderProfile`;
- semantic `sourceDigest`, project/canvas, slides, scene modules, themes;
- local WIP or protected committed-handle refs for narration/assets.

Keep one core idea per slide. Scene modules must be bounded, readable Remotion
components and must use the project’s safe layout primitives. Narration-enabled
drafts require exactly one measured track per slide; narration-disabled drafts
must contain none.

Scene code refers to a draft asset only through the stable URI
`sourceweft-asset:<assetId>` (for example `sourceweft-asset:black-hole-photo`).
Never embed a sandbox path, `/assets/...` path, object-storage key, or returned
provider URL in scene code. Validation materializes the stable URI to the exact
captured bytes inside the trusted sandbox. Browser playback receives only the
resulting committed MP4 and cover, never scene code.

## Choosing the next action

Use the smallest action supported by current evidence:

- Author or edit draft/scene files when the content or diagnostics changed.
- `generate_video_assets` only for explicitly planned visual slots. It claims
  the full batch before provider calls and stages durable WIP bytes; it does not
  publish standalone image artifacts.
- `generate_video_narration` only for the current narration plan. It stores
  bytes durably, measures real audio duration, and stages exact tracks.
- `validate_video_presentation` after the semantic draft and referenced bytes
  are coherent. It rebuilds a clean canonical tree, typechecks/smoke-renders,
  renders beginning/middle/end samples for every scene, performs visual review
  when a vision profile is configured, and always requires deterministic
  runtime evidence, a cover, and the final streamable MP4.
- Edit files and validate again only when the new input digest differs and the
  diagnostics justify the change.
- `publish_video_presentation` only with the latest passed validation receipt.

If an action says another identical action is in progress, do not issue it
again. If it reports an unknown side-effect outcome, stop and surface that
blocker. For auth, quota, policy, path, configuration, permission, or missing
provider errors, fail fast rather than switching paths. For content/layout
diagnostics, modify the relevant source and continue when semantic progress is
real.

## Create

Form a concise thesis and narrative arc from the request and selected sources.
Choose a plausible scene count/duration, author the draft and scene files,
generate only required media, then use validation evidence to decide whether
to repair or publish. Do not ask for clarification when the topic and intended
output are already sufficient.

For style intent, use a concrete visual direction rather than a generic label.
For factual source material, retain the must-include facts in `sourceDigest`
and keep displayed text concise.

## Edit

Call `load_video_presentation({artifactId})` first. It materializes the current
authorized ready version and returns `loadReceiptId`, exact version identity,
paths, and digests. Work only in that loaded project root. Preserve untouched
slides/resources; replace only what the user asked to change.

Pass the same load receipt through validation, then publish with:

- the same artifact id;
- the loaded `expectedVersionNo`;
- the latest validation receipt;
- the load receipt.

If the current version changed, do not overwrite it. Report the version
conflict and reload only with user authority to continue the edit.

## Validation and publication evidence

A passed validation receipt binds the exact draft bytes, referenced resources,
builder/render policy, runtime sample digests, project checks, vision review,
cover, and final probed MP4. Any source/resource change invalidates it.
The draft itself never contains published media URLs or storage coordinates.

Publication re-captures and hashes the draft closure, resolves protected
resource authority, uploads local WIP bytes, converts to the strict committed
payload, and atomically commits artifact/version + canonical tool result + chat
card under the active run fence. If that transaction rejects, do not claim the
artifact exists.

After the committed result, respond briefly that the video is ready for
playback/download. Do not narrate an imaginary background build.
