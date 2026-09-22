import { useTranslations } from "next-intl";
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

function buildMetadata(
  t: ReturnType<typeof useTranslations<"dashboardChatCanvas.workfile.mutationPreview">>,
  preview: WorkfileMutationPreviewModel,
) {
  return preview.kind === "write"
    ? [t("lineCount", { count: preview.lineCount }), formatBytes(preview.sizeBytes)]
    : [
        preview.occurrences !== null
          ? t("replacementCount", { count: preview.occurrences })
          : null,
        preview.replaceAll !== null
          ? `replace_all=${preview.replaceAll ? "true" : "false"}`
          : null,
      ].filter((item): item is string => item !== null);
}

export function WorkfileMutationPreview({
  onWorkfileClick,
  preview,
}: {
  onWorkfileClick?: (path: string) => void;
  preview: WorkfileMutationPreviewModel;
}) {
  const t = useTranslations("dashboardChatCanvas.workfile.mutationPreview");
  const fileName = basename(preview.path);
  const metadata = buildMetadata(t, preview);

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
            {t("openWorkfile")}
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
          fileName={t("diffLabel", { name: fileName })}
          language="diff"
        />
      ) : null}
      {preview.previewTruncated ? (
        <p className="text-muted-foreground/65 text-xs">
          {t("previewTruncated", {
            count: WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT,
          })}
        </p>
      ) : null}
    </div>
  );
}
