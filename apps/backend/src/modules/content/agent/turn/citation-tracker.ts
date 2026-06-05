import { AgentCitationRegistry, type AgentCitation } from "../citation-registry";
import type { ThinkingStepTrace } from "../../threads";
import { normalizeAssistantCitations } from "./citations";

export function createCitationSnapshotTracker(input: {
  citationRegistry: AgentCitationRegistry;
}) {
  let lastEmittedCitationCount = 0;
  return () => {
    const citations = input.citationRegistry.list();
    if (citations.length <= lastEmittedCitationCount) {
      return null;
    }

    lastEmittedCitationCount = citations.length;
    return citations;
  };
}

export function normalizeAssistantTextCitations(input: {
  assistantText: string;
  citations: AgentCitation[];
}) {
  return normalizeAssistantCitations(input);
}

export function buildCitationVerificationStep(input: {
  normalization: ReturnType<typeof normalizeAssistantCitations>;
  availableCitationCount: number;
}): Omit<ThinkingStepTrace, "sequence"> {
  const usedCitationCount = input.normalization.citations.length;
  const removedCitationCount = input.normalization.invalidKeys.length;
  const missingInlineCitationMarkers =
    input.availableCitationCount > 0 && input.normalization.markerCount === 0;

  return {
    id: "verify",
    kind: "verification",
    title: "Checking citations",
    status: "completed",
    items: [],
    description: [
      `Used ${usedCitationCount} of ${input.availableCitationCount} available citations`,
      missingInlineCitationMarkers ? "no inline citation markers found" : null,
      input.normalization.removedInvalidCitations
        ? `removed ${removedCitationCount} unsupported markers`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    metadata: {
      availableCitationCount: input.availableCitationCount,
      usedCitationCount,
      citationMarkerCount: input.normalization.markerCount,
      validCitationMarkerCount: input.normalization.validMarkerCount,
      ...(missingInlineCitationMarkers
        ? { missingInlineCitationMarkers: true }
        : {}),
      ...(removedCitationCount > 0 ? { removedCitationCount } : {}),
    },
  };
}
