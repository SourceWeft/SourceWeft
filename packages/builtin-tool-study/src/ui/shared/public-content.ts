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
 * Study content on a public share: the server keeps only what the share
 * viewer renders (`publicStudyContent`), and the share viewer opens that with
 * placeholders where things were dropped and no evidence at all
 * (`parsePublicStudyContent`). Pure and React-free, so the server-side
 * handler and the browser viewer share it.
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
 * Evidence as a public study share carries it: only the source an item was
 * cited from. The shared grounded allow-list is narrowed further, so no
 * document or chunk identifier leaves the workspace with a study set.
 */
export type PublicStudyEvidence = Pick<PublicGroundedEvidence, "kind" | "sourceId">;

function toPublicStudyEvidence(evidence: readonly StudyEvidence[]): PublicStudyEvidence[] {
  return toPublicGroundedEvidenceList(evidence).map(({ kind, sourceId }) => ({
    kind,
    sourceId,
  }));
}

/**
 * What a public share hands an anonymous browser: only what the share viewer
 * renders. The schema version, kind and language, and the cards, questions or
 * mind map nodes, each with its evidence reduced to the source it was cited
 * from. Built from the validated content, so nothing else travels: not the
 * quotes, their offsets, digests or chunk ids, not `inputs` (the sources'
 * documents and content hashes), and not `generation` (the owner's focus and
 * the rest of the recipe, the model and the stats). The share viewer parses
 * this with placeholders in place of what was dropped.
 */
export function publicStudyContent(content: StudyContent): Record<string, unknown> {
  const mapped = mapEvidence<PublicStudyEvidence>(content, toPublicStudyEvidence);
  const base = {
    schemaVersion: content.schemaVersion,
    kind: content.kind,
    language: content.language,
  };
  return "root" in mapped ? { ...base, root: mapped.root } : { ...base, items: mapped.items };
}

/**
 * Stands in for the `inputs` and `generation` a public payload no longer
 * has, so the share viewer can parse it with the strict content schema. Only
 * a viewer that shows neither may use them.
 */
const PUBLIC_INPUTS_PLACEHOLDER = {
  selection: "sources",
  sources: [{ sourceId: "-", documentId: "-", contentHash: "-" }],
} as const;

const PUBLIC_GENERATION_PLACEHOLDER = {
  promptVersion: "-",
  modelAlias: "-",
  mode: "single",
  stats: { requested: 0, kept: 0, dropped: {}, groups: 0, tokensEstimated: 0 },
  recipe: { options: {}, sourceIds: ["-"] },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Puts a placeholder where evidence, `inputs` and `generation` were, so the
 * strict schema accepts the payload.
 */
function withPlaceholders(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const payload: Record<string, unknown> = {
    ...input,
    inputs: PUBLIC_INPUTS_PLACEHOLDER,
    generation: PUBLIC_GENERATION_PLACEHOLDER,
  };
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
