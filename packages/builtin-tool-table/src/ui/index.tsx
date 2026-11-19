import type {
  ArtifactPreviewContext,
  ArtifactPreviewResult,
  ArtifactUiModule,
} from "@sourceweft/contracts/artifact-ui";
import { TableArtifactView } from "./table-artifact-view";

function tablePreview(context: ArtifactPreviewContext): ArtifactPreviewResult {
  return {
    id: "table",
    // Exports (CSV, Markdown) live in the viewer; there is no stored file.
    blocksDefaultDownload: true,
    content: (
      <TableArtifactView
        artifact={context.artifact}
        // The public share page shows values only, never a source quote.
        interactive={context.surface === "share" ? false : undefined}
        payload={context.payload}
        title={context.title}
      />
    ),
  };
}

export const tableArtifactUi: ArtifactUiModule = {
  id: "table",
  artifactTypes: ["table"],
  preview: tablePreview,
};

export { TableArtifactView } from "./table-artifact-view";
export { TableViewer } from "./table-viewer";
export {
  browserDownload,
  configureTableHost,
  readOnlyTableHost,
  TABLE_TRANSLATION_KEYS,
  TableHostProvider,
  useTableHost,
  type TableHost,
  type TableTranslate,
  type TableVersionRef,
} from "./table-host";
