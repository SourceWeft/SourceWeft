import type { AgentToolPresentation } from "@sourceweft/contracts/agent-tools";

/**
 * The stages generate_image streams (see tool-runtime.ts). Kept beside the tool
 * that emits them so the wire vocabulary and its display labels stay together.
 */
const STAGE_LABELS: Record<string, string> = {
  preparing: "Composing",
  generating: "Rendering",
  saving: "Polishing",
  billing: "Finalizing",
  ready: "Ready",
};

export const generateImagePresentation: AgentToolPresentation = {
  renderAs: "image",
  progressEventTypes: ["generate_image_progress"],
  title({ status, toolOutput, readOutputField }) {
    if (status === "running") {
      const stage = readOutputField(toolOutput, "stage");
      return (stage ? STAGE_LABELS[stage] : null) ?? "Generating image";
    }
    if (status === "error") {
      return "Image generation failed";
    }
    return "Generated image";
  },
  describe() {
    return "Created an image artifact.";
  },
};
