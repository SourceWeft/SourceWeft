# Writing an Effective Brief

The root studio Agent turns the request into a concrete draft, so source quality
still decides presentation quality. Extract the topic, narrative arc, facts, and
constraints before authoring scenes; do not invent a second hidden worker plan.

## Structure of a good brief

One to four sentences covering:

1. **Topic and thesis** — what the video argues or teaches, not just a subject
   area. "Explain how the Feynman technique exposes gaps in understanding" beats
   "a video about learning".
2. **Narrative arc** — the intended progression (problem → mechanism → payoff,
   or overview → deep dives → recap). Keep one core idea per slide and split an
   overloaded arc before writing scene code.
3. **Audience and register** — who watches, and pass `audience`/`tone` fields
   when the user provides them instead of burying them in the brief.

## Good vs bad

Bad (vague, no arc):

> Make a video about our Q3 results.

Good:

> Walk sales leadership through Q3 results: revenue beat plan by 12% driven by
> the enterprise tier, churn ticked up in SMB, and the ask is headcount for two
> more account managers. Confident, numbers-forward.

Bad (mechanically copies a requested layout without resolving the thesis):

> Slide 1 shows a title card, slide 2 has three bullets about..., slide 3...

Good (constraints, not slides):

> Product walkthrough of the new import wizard for existing admins; emphasize
> the three-step flow and the validation safety net. `slideCount: 5`,
> `stylePreset: "product"`.

## Facts belong in sourceDigest

Must-include numbers, quotes, or source facts go into `sourceDigest`, not the
brief. The brief says what the video is; the digest carries the material the
storyboard should stay faithful to.

## Density and options

- `visualDensity` scales how much each slide carries: `light` for keynote-style
  single phrases, `dense` for technical audiences that expect supporting
  points. When in doubt keep `balanced`.
- Pick `slideCount` from the target length: total seconds ÷ per-slide seconds
  (short ≈ 6s, medium ≈ 10s, long ≈ 14s per slide). A "2-minute medium" video
  is ~12 slides at most; fewer, denser slides usually read better than many
  thin ones.
- For edits, call `load_video_presentation` first and modify only the requested
  slides/resources in the loaded draft; keep the protected load receipt through
  validation and publication.
