# Animation and FX

`runtime/catalog.json` is the authoritative inventory. Add `data-anim="name"` for one of its 27 entry/CSS animations; numeric counters may use `class="counter" data-to="2400" data-dur="1200"`. Supply a stable numeric target so reentry does not count toward a previously rendered intermediate value.

A `data-fx="name"` container needs a real, bounded design width and height. Effects are statically embedded. Keep important content outside decorative effects; visual effects must support the message. Use separate elements for an FX and a numeric entry counter.

The migrated FX helpers use unscaled canvas dimensions, actual DPR, embedded font families, seeded randomness, scoped timers/animation frames, and explicit cleanup. The adapter starts/stops work on Reveal lifecycle events. Unknown effects are errors. The old navigation/runtime and dynamic FX loader are not shipped.

QA captures use a fixed seed/time and visible fragments. Also test real navigation, repeated reentry, resize, overview, hidden-page recovery and disposal. A static screenshot cannot prove cleanup or interaction correctness. Mark purely decorative text with `data-text-role="decoration"` only when it conveys no required content.
