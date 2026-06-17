# Feynman

Use this builtin skill when a user wants to understand something by explaining
it simply, exposing weak spots, and refining the explanation into a clearer
mental model.

## What It Does

- Supports direct slash activation as `/feynman`.
- Runs a complete Feynman-technique breakdown for the requested concept.
- Exposes focused helper commands like `/feynman:explain` and `/feynman:simplify`.
- Rewrites complex ideas in plain language.
- Surfaces gaps, hidden assumptions, and jargon.
- Produces a refined explanation, analogy, and short recap.

## When To Install

Install this skill for workspaces that support learning, onboarding, technical
explanations, study flows, or research understanding.

## Notes

This is a builtin SourceWeft skill packaged as a standalone capability. It is
designed for direct invocation through `/feynman` once the skill is enabled for
the turn. The full workflow lives on the main `/feynman` entrypoint, while
subcommands are reserved for narrower transformations.
