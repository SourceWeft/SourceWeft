import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  WorkfileCodeBlock,
  WorkfilePathSnippet,
} from "../workfile-content-viewer";
import {
  WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT,
  type WorkfileMutationPreviewModel,
} from "./workfile-mutation-state";
import { basename } from "../workfile-content-preview";

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  }
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

export function WorkfileMutationPreview({
  onWorkfileClick,
  preview,
}: {
  onWorkfileClick?: (path: string) => void;
  preview: WorkfileMutationPreviewModel;
}) {
  const fileName = basename(preview.path);
  const metadata =
    preview.kind === "write"
      ? [
          `${preview.lineCount} ${preview.lineCount === 1 ? "line" : "lines"}`,
          formatBytes(preview.sizeBytes),
        ]
      : [
          preview.occurrences !== null
            ? `${preview.occurrences} ${
                preview.occurrences === 1 ? "replacement" : "replacements"
              }`
            : null,
          preview.replaceAll !== null
            ? `replace_all=${preview.replaceAll ? "true" : "false"}`
            : null,
        ].filter((item): item is string => item !== null);

  return (
    <div className="space-y-2.5">
      <WorkfilePathSnippet
        action={
          <Button
            className="h-8 shrink-0 px-2 text-xs"
            disabled={!onWorkfileClick}
            onClick={() => onWorkfileClick?.(preview.path)}
            size="sm"
            type="button"
            variant="outline"
          >
            Open Workfile
          </Button>
        }
        path={preview.path}
      />
      {metadata.length > 0 ? (
        <p className="text-muted-foreground/70 text-xs">
          {metadata.join(" · ")}
        </p>
      ) : null}
      {preview.kind === "write" ? (
        <WorkfileCodeBlock
          className="max-h-72 overflow-auto"
          code={preview.previewContent}
          fileName={fileName}
          language={preview.language}
        />
      ) : preview.diffPreview ? (
        <WorkfileCodeBlock
          className="max-h-72 overflow-auto"
          code={preview.diffPreview}
          fileName={`${fileName} diff`}
          language="diff"
        />
      ) : null}
      {preview.previewTruncated ? (
        <p className="text-muted-foreground/65 text-xs">
          Preview truncated to{" "}
          {WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT.toLocaleString()} characters.
        </p>
      ) : null}
    </div>
  );
}
