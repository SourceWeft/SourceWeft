import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";

const videoPresentationInputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    brief: {
      type: "string",
      description: "Short description of the video presentation to generate.",
    },
    title: { type: "string" },
    sourceDigest: {
      type: "string",
      description: "Optional source summary or source material.",
    },
    audience: { type: "string" },
    tone: { type: "string" },
    language: { type: "string" },
    durationTarget: { enum: ["short", "medium", "long"], type: "string" },
    stylePreset: {
      enum: ["cinematic", "editorial", "executive", "technical", "product"],
      type: "string",
    },
    renderProfile: {
      type: "object",
      additionalProperties: true,
      properties: {
        stylePreset: {
          enum: ["cinematic", "editorial", "executive", "technical", "product"],
          type: "string",
        },
        visualDensity: {
          enum: ["light", "balanced", "dense"],
          type: "string",
        },
        durationTarget: { enum: ["short", "medium", "long"], type: "string" },
        language: { type: "string" },
      },
    },
    slideCount: {
      type: "number",
      description: "Target number of planned scenes/slides, 1-12.",
    },
    visualDirection: {
      type: "string",
      description:
        "High-level visual art direction for the Remotion project.",
    },
    brand: {
      type: "object",
      additionalProperties: true,
      properties: {
        colors: {
          type: "array",
          items: { type: "string" },
        },
        typography: { type: "string" },
        logoAssetId: { type: "string" },
      },
    },
    motion: {
      type: "object",
      additionalProperties: true,
      properties: {
        pacing: { enum: ["calm", "dynamic", "energetic"], type: "string" },
        transitionStyle: { type: "string" },
        animationIntensity: {
          enum: ["subtle", "balanced", "bold"],
          type: "string",
        },
      },
    },
    canvas: {
      type: "object",
      additionalProperties: true,
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        fps: { type: "number" },
      },
    },
    narrationEnabled: { type: "boolean" },
    narration: {
      type: "object",
      additionalProperties: true,
      properties: { enabled: { type: "boolean" } },
    },
    assets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          assetId: { type: "string" },
          role: { type: "string" },
        },
      },
    },
    regeneration: {
      type: "object",
      additionalProperties: true,
      properties: {
        artifactId: { type: "string" },
        instruction: { type: "string" },
        slideNumbers: {
          type: "array",
          items: { type: "number" },
        },
      },
    },
  },
} as const;

export const builtinGenerateVideoPresentationCapabilityManifest: CapabilityManifestInput =
  {
    schemaVersion: 1,
    id: "sourceweft/video-presentation-tool",
    kind: "tool",
    name: "Generate Video Presentation",
    version: "0.1.0",
    entry: "./src/index.ts",
    tools: [
        {
          id: "generate_video_presentation",
          title: "Generate Video Presentation",
          description:
            "Generate a persisted SourceWeft narrated video presentation artifact.",
          inputSchema: videoPresentationInputSchema,
          outputSchema: { type: "object" },
          risk: "write",
          options: [
            {
              id: "narrationEnabled",
              title: "Narration",
              description:
                "Generate narration audio for the video presentation by default.",
              valueType: "boolean",
              defaultValue: true,
              target: { path: "narration.enabled" },
              values: [],
            },
          ],
          runtime: {
            execution: "agent",
            promptIntro:
              "Create a narrated video presentation artifact from the user's request. Call generate_video_presentation with a concise brief-first payload and optional slideCount/visualDirection/brand/motion/canvas constraints; do not pass a storyboard, blueprint, slide list, scene code, TSX, or HTML. The worker plans and builds the Remotion project internally. The command is complete only when the worker-built video_presentation project is ready; do not describe it as server-side MP4 rendering or a completed MP4.",
            tools: ["generate_video_presentation"],
            permissionOverrides: { generate_video_presentation: "allow" },
            output: {
              kind: "artifact",
              artifactType: "video_presentation",
              publisherTool: "generate_video_presentation",
            },
            pipeline: {
              jobName: "video-presentation-generate",
              queue: "deliverables",
            },
          },
        },
    ],
  };
