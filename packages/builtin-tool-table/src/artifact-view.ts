import type {
  ArtifactViewHandler,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";
import { parseTableContent } from "@sourceweft/contracts/table";

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
};

export const tableArtifactViewHandlers: readonly ArtifactViewHandler[] = [
  tableArtifactViewHandler,
];

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () =>
  tableArtifactViewHandlers;
