---
name: image-generate
description: Generate persisted image artifacts from text prompts. Use when the user asks to create, render, draw, illustrate, design, or generate a bitmap image, poster visual, product mockup, concept art, or other standalone raster visual artifact through SourceWeft image generation.
---

# Image Generate

Use SourceWeft's built-in `generate_image` tool to create persisted image artifacts.

## Tool

Call `generate_image` with a concise visual prompt. The callable arguments are `prompt` and optional `title`; aspect ratio, quality, and style are configured by SourceWeft options.

## Workflow

1. Treat the user request as an image brief.
2. Preserve the requested subject, style, composition, visible text, and constraints.
3. Expand vague requests only enough to make the image prompt clear.
4. Call `generate_image` once for each distinct image.

## Boundaries

- Do not use a sandbox or filesystem workflow for this skill.
- Use a code-native or vector workflow when the user explicitly asks for SVG, HTML/CSS/canvas, charts, technical diagrams, or changes to an existing logo/icon system.

## Output

- Return a generated image artifact, not only a text description.
- Do not return raw file paths, raw artifact URLs, or image markdown; SourceWeft displays the artifact.
- If generation succeeds, respond with at most one short sentence.
- If `generate_image` is unavailable or fails, report the failure briefly.
