/**
 * Collecting the image artifacts a completed tool call produced, deduplicated
 * across the tool calls of one turn.
 */
import { hasAgentToolCapability } from "@sourceweft/agent-tool-registry";
import { extractToolOutputField } from "./json";
import type { ToolCallTrace } from "../../..";

export const GENERATED_IMAGE_ALT = "Generated image";

export function extractGeneratedImageArtifacts(
  toolCalls: ToolCallTrace[],
): GeneratedImageArtifactReference[] {
  const seen = new Set<string>();
  return toolCalls
    .filter(
      (call) =>
        hasAgentToolCapability(call.tool, "generated_image_artifact") &&
        call.status === "completed" &&
        !call.error,
    )
    .map((call): GeneratedImageArtifactReference | null => {
      const artifactId =
        extractToolOutputField(call.output, "artifact_id") ?? "";
      const artifactUrl = extractToolOutputField(call.output, "artifact_url");
      const title =
        extractToolOutputField(call.output, "title") || GENERATED_IMAGE_ALT;

      return artifactUrl
        ? {
            artifactId: artifactId || null,
            artifactUrl,
            title,
            toolCallId: call.id,
          }
        : null;
    })
    .filter((artifact): artifact is GeneratedImageArtifactReference =>
      Boolean(artifact),
    )
    .filter((artifact) => {
      const key = artifact.artifactId ?? artifact.artifactUrl;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

type GeneratedImageArtifactReference = {
  artifactId: string | null;
  title: string;
  artifactUrl: string;
  toolCallId?: string;
};
