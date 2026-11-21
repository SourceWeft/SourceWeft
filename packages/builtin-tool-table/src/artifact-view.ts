import type {
  ArtifactViewHandler,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";
import {
  parseTableContent,
  type TableCell,
  type TableContent,
} from "@sourceweft/contracts/table";
import { toPublicGroundedEvidenceList } from "@sourceweft/grounded-generation";

/**
 * Read-side takeover for data tables.
 *
 * A table is rendered client-side from its content JSON: there is no stored
 * file, no media and no sub-asset, so deleting one leaves no storage object
 * behind. Registering the handler is what tells the host the type renders
 * client-side.
 */

/** A file name stem from a title: path- and control-safe, never empty. */
function fileStem(title: string | null | undefined, fallback: string) {
  const stem = (title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return stem || fallback;
}

function publicCell(cell: TableCell) {
  return cell.status === "found"
    ? { ...cell, evidence: toPublicGroundedEvidenceList(cell.evidence) }
    : cell;
}

/**
 * What a public share hands an anonymous browser: only what the share viewer
 * renders. Column ids, names and types (with the fingerprints the schema
 * requires), and rows with their source titles, statuses, values and
 * normalized values; every cell's evidence is reduced to where it was cited
 * from. Built from the validated content field by field, so nothing else
 * travels: not the quotes, their offsets or digests, not the column
 * descriptions, and not `generation` (the owner's instruction and the rest of
 * the recipe, the model and the stats, none of which the viewer shows). The
 * share viewer parses this with placeholders in place of what was dropped.
 */
export function publicTableContent(content: TableContent): Record<string, unknown> {
  return {
    schemaVersion: content.schemaVersion,
    kind: content.kind,
    language: content.language,
    columns: content.columns.map(({ id, name, type, fingerprint }) => ({
      id,
      name,
      type,
      fingerprint,
    })),
    rows: content.rows.map((row) => ({
      ...row,
      cells: Object.fromEntries(
        Object.entries(row.cells).map(([columnId, cell]) => [columnId, publicCell(cell)]),
      ),
    })),
  };
}

export const tableArtifactViewHandler: ArtifactViewHandler = {
  artifactType: "table",
  listOwnedStorageObjects: () => [],
  buildSourceJson: ({ artifact }) => {
    try {
      const content = parseTableContent(artifact.payloadJson);
      return {
        payload: content as unknown as Record<string, unknown>,
        fileName: `${fileStem(artifact.title, "table")}.table.json`,
      };
    } catch {
      return null;
    }
  },
  buildPublicPayload: ({ artifact }) => {
    try {
      return publicTableContent(parseTableContent(artifact.payloadJson));
    } catch {
      return null;
    }
  },
};

export const tableArtifactViewHandlers: readonly ArtifactViewHandler[] = [
  tableArtifactViewHandler,
];

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () =>
  tableArtifactViewHandlers;
