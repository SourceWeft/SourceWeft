import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import {
  GENERATE_VIDEO_ASSETS_TOOL_NAME,
  GENERATE_VIDEO_NARRATION_TOOL_NAME,
  LOAD_VIDEO_PRESENTATION_TOOL_NAME,
  PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
  VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
} from "./agent/tool-names";

const toolContributions = [
  {
    id: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
    title: "Load Video Presentation",
    description: "Load an authorized current video project for an exact edit.",
  },
  {
    id: GENERATE_VIDEO_ASSETS_TOOL_NAME,
    title: "Generate Video Assets",
    description: "Generate and stage a bounded batch of video visual assets.",
  },
  {
    id: GENERATE_VIDEO_NARRATION_TOOL_NAME,
    title: "Generate Video Narration",
    description: "Generate, measure, persist, and stage narration tracks.",
  },
  {
    id: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
    title: "Validate Video Presentation",
    description:
      "Validate the exact draft and render its required cover and final MP4 in the trusted sandbox.",
  },
  {
    id: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
    title: "Publish Video Presentation",
    description:
      "Atomically publish a protected, validated video presentation version.",
  },
].map((entry) => ({
  ...entry,
  inputSchema: { type: "object" as const, additionalProperties: true },
  outputSchema: { type: "object" as const },
  risk: "write" as const,
}));

export const builtinVideoPresentationCapabilityManifest: CapabilityManifestInput =
  {
    schemaVersion: 1,
    id: "sourceweft/video-presentation-tool",
    kind: "tool",
    name: "Video Presentation",
    version: "1.0.0",
    entry: "./src/index.ts",
    tools: toolContributions,
  };
