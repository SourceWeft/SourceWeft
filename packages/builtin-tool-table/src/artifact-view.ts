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
 * What a public share hands an anonymous browser: the validated content (so
 * nothing outside the table's schema travels, such as a generation checkpoint)
 * with every cell's evidence reduced to where it was cited from. Values,
 * normalized values, column names and types, and source titles stay; the
 * quotes, their offsets and digests do not. The share viewer never shows
 * evidence and parses this with placeholders in its place.
 */
export function publicTableContent(content: TableContent): Record<string, unknown> {
  return {
    ...content,
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
