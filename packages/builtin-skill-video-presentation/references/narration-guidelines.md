# Narration and Pacing

Narration audio drives slide timing: each slide stays on screen for its real
spoken duration (measured from the generated audio) plus a short settle
padding. The worker enforces per-slide narration budgets at storyboard time,
so a brief that fights these numbers gets rewritten toward them.

## Pacing math

TTS speaks roughly **2.45 English words/second** or **5.2 Chinese
characters/second**. Per-slide narration budgets by `durationTarget`:

| durationTarget | per-slide speech | English words | Chinese characters |
| -------------- | ---------------- | ------------- | ------------------ |
| `short`        | ~4-9s            | ~7-19         | ~14-40             |
| `medium`       | ~5-14s           | ~9-31         | ~20-66             |
| `long`         | ~8-19s           | ~17-43        | ~35-92             |

Estimated total runtime ≈ slideCount × per-slide seconds. Use this when the
user asks for "a 3-minute video": pick `durationTarget` and `slideCount` so the
math lands near their ask, and say what you chose.

## Language

- `language: "auto"` infers from the user's request — a Chinese brief produces
  Chinese narration. Pass an explicit tag (`zh-CN`, `en-US`) when the user's
  request and desired output language differ (e.g. English source material,
  Chinese narration).
- Narration and on-screen text follow the same language unless the user asks
  otherwise.

## Register

- Narration is written for the ear: short sentences, spoken rhythm, no
  citations or URLs read aloud.
- `tone` shifts the voice ("confident and numbers-forward", "warm, for
  first-time users"); pass it when the user signals one.
- `narrationEnabled: false` produces a silent, visually-timed presentation —
  offer it when the user wants an autoplaying loop or will present live over
  the video.
