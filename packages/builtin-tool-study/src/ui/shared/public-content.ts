import {
  parseStudyContentForArtifact,
  type MindmapNode,
  type StudyContent,
  type StudyEvidence,
} from "@sourceweft/contracts/study";
import {
  GROUNDED_EVIDENCE_PLACEHOLDER,
  toPublicGroundedEvidenceList,
  type PublicGroundedEvidence,
} from "@sourceweft/grounded-generation/public-evidence";

/**
 * Study content on a public share: the server strips the source text out of
 * every evidence entry (`publicStudyContent`), and the share viewer opens what
 * is left with no evidence at all (`parsePublicStudyContent`). Pure and
 * React-free, so the server-side handler and the browser viewer share it.
 */

function mapEvidence<E>(
  content: StudyContent,
  map: (evidence: StudyEvidence[]) => E[],
) {
  const mapNode = (node: MindmapNode): Omit<MindmapNode, "evidence" | "children"> & {
    evidence: E[];
    children: unknown[];
  } => ({
    ...node,
    evidence: map(node.evidence),
    children: node.children.map(mapNode),
  });
  return content.kind === "mindmap"
    ? { ...content, root: mapNode(content.root) }
    : {
        ...content,
        items: content.items.map((item) => ({ ...item, evidence: map(item.evidence) })),
      };
}

/**
 * The payload a public share hands an anonymous browser: the validated
 * content, each item's evidence reduced to where it was cited from.
 */
export function publicStudyContent(content: StudyContent): Record<string, unknown> {
  return mapEvidence<PublicGroundedEvidence>(content, toPublicGroundedEvidenceList);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Puts a placeholder where evidence was, so the strict schema accepts it. */
function withPlaceholders(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const placeholderNode = (node: unknown): unknown =>
    isRecord(node)
      ? {
          ...node,
          evidence: [],
          children: Array.isArray(node.children)
            ? node.children.map(placeholderNode)
            : node.children,
        }
      : node;
  if (payload.kind === "mindmap") {
    return { ...payload, root: placeholderNode(payload.root) };
  }
  if (!Array.isArray(payload.items)) return payload;
  return {
    ...payload,
    items: payload.items.map((item: unknown) =>
      isRecord(item) ? { ...item, evidence: [GROUNDED_EVIDENCE_PLACEHOLDER] } : item,
    ),
  };
}

/**
 * Opens a study payload for the share page: whatever evidence it carries is
 * replaced before parsing and emptied after, so the viewers render no evidence
 * control and no quote that was left in by mistake. Null when the payload is
 * not valid content of `artifactType`.
 */
export function parsePublicStudyContent(
  artifactType: string,
  payload: unknown,
): StudyContent | null {
  try {
    const content = parseStudyContentForArtifact(artifactType, withPlaceholders(payload));
    return mapEvidence<StudyEvidence>(content, () => []) as StudyContent;
  } catch {
    return null;
  }
}
