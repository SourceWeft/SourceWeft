import { describe, expect, test } from "vitest";
import { DEFAULT_IMAGE_ARTIFACT_CONFIG } from "../../artifacts/types";
import { AGENT_TOOL_NAMES } from "../tool-registry";
import { imageRuntimePromptProvider } from "../tools/generate-image-tool";
import { pptxRuntimePromptProvider } from "../tools/generate-pptx-tool";
import { videoPresentationRuntimePromptProvider } from "../tools/generate-video-presentation-tool";
import { buildAgentRuntimePrompt } from "./runtime-prompt";
import type { RuntimePromptContext } from "./tool-prompt-provider";

const baseRuntimePromptContext: RuntimePromptContext = {
  availableArtifactTools: [],
  availableWebTools: [],
  availableMcpTools: [],
  currentDate: "2026-05-30",
};

function normalizeRuntimePromptDates(prompt: string) {
  return prompt.replace(/^Current date: .+\.$/m, "Current date: <date>.");
}

describe("artifact tool runtime prompt providers", () => {
  test("image provider output stays stable", () => {
    const lines = imageRuntimePromptProvider.buildLines({
      ...baseRuntimePromptContext,
      artifactIntent: {
        kind: "image",
        shouldInjectTool: true,
        source: "skill",
        confidence: 1,
        reason: "test image intent",
        config: {
          ...DEFAULT_IMAGE_ARTIFACT_CONFIG,
          aspectRatio: "16:9",
          quality: "highest",
          style: "pixel",
        },
        warnings: [],
      },
    });

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "Image generation defaults: aspect_ratio=16:9, quality=highest, style=pixel.
      generate_image is available in auto mode. Use it when the user asks you to create a new visual artifact or deliverable; otherwise answer normally.
      For ambiguous requests, decide semantically from the user's goal rather than matching literal keywords. If the user expects a kept visual output, call generate_image.
      If the prompt is missing essential visual details for a requested image, make a reasonable concise prompt instead of asking a separate confirmation.
      Never claim an image was created unless generate_image completed successfully.
      After generate_image succeeds, decide whether a short natural-language wrap-up is useful. The application displays the generated image automatically; do not include image markdown or raw artifact URLs."
    `);
  });

  test("pptx provider output stays stable", () => {
    const lines = pptxRuntimePromptProvider.buildLines({
      ...baseRuntimePromptContext,
      availableArtifactTools: [AGENT_TOOL_NAMES.generatePptx],
      generatePptxTool: {
        generationMode: "editable_native",
        design: {
          aspectRatio: "16:10",
          language: "zh",
          stylePreset: "technical",
        },
      },
    });

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "generate_pptx is available for presentation artifacts. Use it when the user asks to create a PPT, PPTX, slide deck, or presentation artifact.
      Deck generation route: high_quality_editable_pptx. SourceWeft creates native editable PPTX by default through the composer/high-quality PPTX route. Legacy generationMode inputs are accepted only for backward compatibility and normalized internally.
      Legacy generation mode requested: editable_native.
      PPTX design defaults: style_preset=technical, aspect_ratio=16:10, language=zh.
      Before calling generate_pptx, create a complete DeckSpec-style plan with controlled safety constraints: audience goal, narrative arc, claim spine, slide mix, each slide intent, content density, visible content slots, proof objects, and resolved design system. Do not use a fixed slide sequence unless the user asks for one. Treat custom style as design intent only; map it to safe registered layouts instead of inventing arbitrary geometry.
      Native PPTX output should favor clean PowerPoint-native editable text, shapes, tables, and charts. For each slide, create only objects consumed by visible content; do not leave blank cards, unused placeholders, empty media frames, overlay-only faux layouts, or repeated empty layout geometry.
      Choose a style preset that fits the audience: executive, technical, editorial, data-heavy, or custom. For custom, provide design.customBrief and design.visualSystem so the model controls the visual direction instead of relying on a coded theme label.
      For custom decks, separate customStyle from resolvedDesignSystem mentally: customBrief can describe mood, brand, tone, density, palette, and typography, but visible slide structure must still use safe content shapes such as section, paragraph, steps, cards, quote, comparison, chart, table, image, or closing.
      For education, teaching, study, classroom, course, training, or Feynman-style decks, default the resolved design family to education/instructional layouts. Do not set styleFamily=editorial or magazine for education content unless the user explicitly requests a magazine/editorial treatment.
      Treat generationMode, style_preset, customBrief, templateArtifactId, aspect_ratio, language, and file format labels as internal tool configuration only; do not use them as visible slide titles, subtitles, eyebrow text, headers, footers, captions, placeholders, or body copy unless the user explicitly wrote that wording as content.
      Provide visible text explicitly through content.cover fields and slide title/kicker/caption/footer/body fields. Keep each text slot concise; never concatenate serialized JSON, sibling fields, arrays, internal planning notes, or tool configuration into a visible text field such as content.cover.subtitle.
      For Chinese decks, all visible title, body, caption, footer, and cover text must be Chinese unless the user supplied a specific English term. Do not leak planning fragments such as opener, layout, audience, or four-step method into visible copy.
      Use 2-4 short bullets for step pages, 3-6 short bullets for card grids, and a paragraph slide for one long explanation. Do not map card grids to longform layouts, and do not create a content slide with an empty body or a single short bullet unless it is intentionally a section or quote slide.
      The presentation tool blocks saving on layout QA failures such as repeated macro layouts, empty render blocks, single-card grid holes, cards mapped into longform, unrequested cover decoration, and language pollution; fix those in the tool arguments before retrying.
      The renderer does not invent missing subtitles, captions, chart data, table rows, quote text, or placeholders.
      When templateArtifactId is present, use it only as a visual_reference or layout_reference in v1. Generate fresh cover title/subtitle and slide copy from the user's content; do not preserve template sample text.
      Never claim a deck artifact was created unless generate_pptx completed successfully.
      After generate_pptx succeeds, decide whether a short natural-language wrap-up is useful. The application displays the deck card automatically; do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas."
    `);
  });

  test("video presentation provider output stays stable", () => {
    const lines = videoPresentationRuntimePromptProvider.buildLines({
      ...baseRuntimePromptContext,
      availableArtifactTools: [AGENT_TOOL_NAMES.generateVideoPresentation],
      generateVideoPresentationTool: {
        narration: {
          enabled: false,
        },
      },
    });

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "generate_video_presentation is available for narrated video presentation artifacts. Use it when the user asks to create a video presentation, narrated deck, or slides-to-video deliverable.
      This tool creates a trusted Remotion video project with structured scenes and narration audio; the browser previews the project and renders the final video only when the user downloads it. Do not describe this as server-side MP4 rendering, background video rendering, or a completed MP4.
      Before calling generate_video_presentation, gather the factual source content, choose a concise video title, and pass any requested audience, tone, pacing, or visual style as user_prompt. Do not expose PPTX style presets or deck configuration.
      The video renderer uses trusted Remotion scene components from structured project data; never provide raw TSX or executable code.
      Use source_content for the factual material to present. Use user_prompt for natural-language style direction such as technical, executive, cinematic, energetic, or calm.
      Never write the internal video schema, schemaVersion JSON, slides array, scenes array, narrationEnabled object, or planner output in the chat. The user should only see the generated artifact card and a short status.
      Narration defaults to off.
      Never claim a video presentation artifact was created unless generate_video_presentation completed successfully.
      After generate_video_presentation succeeds, say the video presentation project has been created and is preparing assets if status is pending or running. Say it is ready only if the tool result status is ready. Do not say \"the video has been generated\" or imply the final video/MP4 has already been rendered. Do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas."
    `);
  });
});

describe("buildAgentRuntimePrompt", () => {
  test("includes provider-neutral sandbox rules only for available sandbox capabilities", () => {
    const prompt = buildAgentRuntimePrompt({
      timezone: "UTC",
      sandboxRuntime: {
        prepareToolAvailable: true,
        executeAvailable: true,
        collectToolAvailable: false,
      },
    });

    expect(prompt).toContain("<sandbox_rules>");
    expect(prompt).toContain("Sandbox /workspace is an isolated temporary execution environment.");
    expect(prompt).toContain("Do not pass /work or /kb paths directly to execute");
    expect(prompt).toContain("they are SourceWeft virtual filesystem paths, not sandbox filesystem paths");
    expect(prompt).toContain("Enabled sandbox skills may be staged under /skills/<skill-name>");
    expect(prompt).toContain(AGENT_TOOL_NAMES.prepareSandboxWorkspace);
    expect(prompt).toContain(AGENT_TOOL_NAMES.execute);
    expect(prompt).not.toContain(AGENT_TOOL_NAMES.collectSandboxOutputs);
    expect(prompt).not.toContain("Daytona");
  });

  test("omits prepare sandbox instructions when prepare tool is unavailable", () => {
    const prompt = buildAgentRuntimePrompt({
      timezone: "UTC",
      sandboxRuntime: {
        prepareToolAvailable: false,
        executeAvailable: true,
        collectToolAvailable: true,
      },
    });

    expect(prompt).toContain("<sandbox_rules>");
    expect(prompt).not.toContain(AGENT_TOOL_NAMES.prepareSandboxWorkspace);
    expect(prompt).toContain(AGENT_TOOL_NAMES.execute);
    expect(prompt).toContain(AGENT_TOOL_NAMES.collectSandboxOutputs);
  });

  test("omits sandbox rules when execute is unavailable", () => {
    const prompt = buildAgentRuntimePrompt({
      timezone: "UTC",
      sandboxRuntime: {
        prepareToolAvailable: true,
        executeAvailable: false,
        collectToolAvailable: true,
      },
    });

    expect(prompt).not.toContain("<sandbox_rules>");
    expect(prompt).not.toContain(AGENT_TOOL_NAMES.prepareSandboxWorkspace);
    expect(prompt).not.toContain(AGENT_TOOL_NAMES.collectSandboxOutputs);
  });

  test("assembles artifact provider output through the registry", () => {
    const prompt = buildAgentRuntimePrompt({
      timezone: "UTC",
      availableArtifactTools: [
        AGENT_TOOL_NAMES.generatePptx,
        AGENT_TOOL_NAMES.generateVideoPresentation,
      ],
      artifactIntent: {
        kind: "image",
        shouldInjectTool: true,
        source: "explicit_tool",
        confidence: 1,
        reason: "test combined artifact prompt",
        config: DEFAULT_IMAGE_ARTIFACT_CONFIG,
        warnings: [],
      },
      generatePptxTool: {
        generationMode: "visual_html",
      },
      generateVideoPresentationTool: {
        narration: {
          enabled: true,
        },
      },
    });

    expect(normalizeRuntimePromptDates(prompt)).toMatchInlineSnapshot(`
      "Current date: <date>.
      Current timezone: UTC.
      Available artifact tools this turn: generate_pptx, generate_video_presentation.
      Image generation defaults: aspect_ratio=auto, quality=auto, style=auto.
      generate_image is available in auto mode. Use it when the user asks you to create a new visual artifact or deliverable; otherwise answer normally.
      For ambiguous requests, decide semantically from the user's goal rather than matching literal keywords. If the user expects a kept visual output, call generate_image.
      If the prompt is missing essential visual details for a requested image, make a reasonable concise prompt instead of asking a separate confirmation.
      Never claim an image was created unless generate_image completed successfully.
      After generate_image succeeds, decide whether a short natural-language wrap-up is useful. The application displays the generated image automatically; do not include image markdown or raw artifact URLs.
      generate_pptx is available for presentation artifacts. Use it when the user asks to create a PPT, PPTX, slide deck, or presentation artifact.
      Deck generation route: high_quality_editable_pptx. SourceWeft creates native editable PPTX by default through the composer/high-quality PPTX route. Legacy generationMode inputs are accepted only for backward compatibility and normalized internally.
      Legacy generation mode requested: visual_html.
      PPTX design defaults: style_preset=custom, aspect_ratio=16:9, language=auto.
      Before calling generate_pptx, create a complete DeckSpec-style plan with controlled safety constraints: audience goal, narrative arc, claim spine, slide mix, each slide intent, content density, visible content slots, proof objects, and resolved design system. Do not use a fixed slide sequence unless the user asks for one. Treat custom style as design intent only; map it to safe registered layouts instead of inventing arbitrary geometry.
      Native PPTX output should favor clean PowerPoint-native editable text, shapes, tables, and charts. For each slide, create only objects consumed by visible content; do not leave blank cards, unused placeholders, empty media frames, overlay-only faux layouts, or repeated empty layout geometry.
      Choose a style preset that fits the audience: executive, technical, editorial, data-heavy, or custom. For custom, provide design.customBrief and design.visualSystem so the model controls the visual direction instead of relying on a coded theme label.
      For custom decks, separate customStyle from resolvedDesignSystem mentally: customBrief can describe mood, brand, tone, density, palette, and typography, but visible slide structure must still use safe content shapes such as section, paragraph, steps, cards, quote, comparison, chart, table, image, or closing.
      For education, teaching, study, classroom, course, training, or Feynman-style decks, default the resolved design family to education/instructional layouts. Do not set styleFamily=editorial or magazine for education content unless the user explicitly requests a magazine/editorial treatment.
      Treat generationMode, style_preset, customBrief, templateArtifactId, aspect_ratio, language, and file format labels as internal tool configuration only; do not use them as visible slide titles, subtitles, eyebrow text, headers, footers, captions, placeholders, or body copy unless the user explicitly wrote that wording as content.
      Provide visible text explicitly through content.cover fields and slide title/kicker/caption/footer/body fields. Keep each text slot concise; never concatenate serialized JSON, sibling fields, arrays, internal planning notes, or tool configuration into a visible text field such as content.cover.subtitle.
      For Chinese decks, all visible title, body, caption, footer, and cover text must be Chinese unless the user supplied a specific English term. Do not leak planning fragments such as opener, layout, audience, or four-step method into visible copy.
      Use 2-4 short bullets for step pages, 3-6 short bullets for card grids, and a paragraph slide for one long explanation. Do not map card grids to longform layouts, and do not create a content slide with an empty body or a single short bullet unless it is intentionally a section or quote slide.
      The presentation tool blocks saving on layout QA failures such as repeated macro layouts, empty render blocks, single-card grid holes, cards mapped into longform, unrequested cover decoration, and language pollution; fix those in the tool arguments before retrying.
      The renderer does not invent missing subtitles, captions, chart data, table rows, quote text, or placeholders.
      When templateArtifactId is present, use it only as a visual_reference or layout_reference in v1. Generate fresh cover title/subtitle and slide copy from the user's content; do not preserve template sample text.
      Never claim a deck artifact was created unless generate_pptx completed successfully.
      After generate_pptx succeeds, decide whether a short natural-language wrap-up is useful. The application displays the deck card automatically; do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas.
      generate_video_presentation is available for narrated video presentation artifacts. Use it when the user asks to create a video presentation, narrated deck, or slides-to-video deliverable.
      This tool creates a trusted Remotion video project with structured scenes and narration audio; the browser previews the project and renders the final video only when the user downloads it. Do not describe this as server-side MP4 rendering, background video rendering, or a completed MP4.
      Before calling generate_video_presentation, gather the factual source content, choose a concise video title, and pass any requested audience, tone, pacing, or visual style as user_prompt. Do not expose PPTX style presets or deck configuration.
      The video renderer uses trusted Remotion scene components from structured project data; never provide raw TSX or executable code.
      Use source_content for the factual material to present. Use user_prompt for natural-language style direction such as technical, executive, cinematic, energetic, or calm.
      Never write the internal video schema, schemaVersion JSON, slides array, scenes array, narrationEnabled object, or planner output in the chat. The user should only see the generated artifact card and a short status.
      Narration defaults to on.
      Never claim a video presentation artifact was created unless generate_video_presentation completed successfully.
      After generate_video_presentation succeeds, say the video presentation project has been created and is preparing assets if status is pending or running. Say it is ready only if the tool result status is ready. Do not say \"the video has been generated\" or imply the final video/MP4 has already been rendered. Do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas."
    `);
  });
});
