"use client";

import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ArtifactPreviewArtifactView } from "@sourceweft/contracts/artifact-ui";
import { groundedErrorCodeSchema } from "@sourceweft/contracts/grounded-generation";
import { readRegenerationFailure } from "@sourceweft/grounded-generation/ui";
import {
  parseTableContent,
  type TableContent,
  type TableFreshness,
} from "@sourceweft/contracts/table";
import { type TableVersionRef, useTableHost } from "./table-host";
import { withoutEvidence } from "./table-model";
import { TableViewer } from "./table-viewer";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `payload.table.progress` (`{ stage, done, total }`, written by the
 * generation job) while generating; tolerant of anything else.
 */
function readProgress(payload: Record<string, unknown>) {
  const progress = record(record(payload.table)?.progress);
  const completed = progress?.done;
  const total = progress?.total;
  return typeof completed === "number" && typeof total === "number" && total > 0
    ? { completed: Math.min(completed, total), total }
    : null;
}

function parseContent(payload: unknown, showEvidence: boolean): TableContent | null {
  try {
    return parseTableContent(showEvidence ? payload : withoutEvidence(payload));
  } catch {
    return null;
  }
}

function TableCannotDisplay() {
  const t = useTableHost().useTranslate();
  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
      role="alert"
    >
      <CircleAlert aria-hidden className="size-5" />
      <p>{t("table.error.cannotDisplay")}</p>
    </div>
  );
}

/** Keeps a render error from blanking the panel: it shows the message instead. */
class TableErrorBoundary extends Component<
  { children?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <TableCannotDisplay /> : this.props.children;
  }
}

/**
 * Everything a table artifact shows in the preview panel or share page:
 * generation progress, a worded failure with retry, or the viewer behind an
 * error boundary. An invalid payload shows "cannot display" rather than
 * blanking the panel.
 */
export function TableArtifactView({
  artifact,
  payload,
  title,
  interactive,
}: {
  artifact: ArtifactPreviewArtifactView;
  payload: Record<string, unknown>;
  title?: string | null;
  /** False narrows the host (the share page shows values only). */
  interactive?: boolean;
}) {
  const host = useTableHost();
  const t = host.useTranslate();
  const surfaceInteractive = interactive !== false;
  const { workspaceId, id: artifactId } = artifact;
  const artifactVersionId = artifact.artifactVersionId ?? null;
  const version: TableVersionRef = useMemo(
    () => ({ workspaceId, artifactId, artifactVersionId }),
    [workspaceId, artifactId, artifactVersionId],
  );
  const [freshness, setFreshness] = useState<TableFreshness | undefined>();
  const ready = artifact.status === "ready" || artifact.status === "archived";
  const getFreshness = host.getFreshness;
  const checkFreshness = surfaceInteractive && host.interactive && ready;

  useEffect(() => {
    if (!checkFreshness || !getFreshness) return;
    let cancelled = false;
    getFreshness
      .call(host, version)
      .then((result) => {
        if (!cancelled) setFreshness(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [checkFreshness, getFreshness, host, version]);

  if (artifact.status === "pending" || artifact.status === "running") {
    const progress = readProgress(payload);
    return (
      <div
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle aria-hidden className="size-5 animate-spin" />
        <p>
          {progress ? t("table.status.generating", progress) : t("table.status.queued")}
        </p>
      </div>
    );
  }

  if (artifact.status === "failed") {
    // A first generation that failed has no recipe to regenerate from, so
    // the way to try again is a new table from the source hub.
    const code = groundedErrorCodeSchema.safeParse(artifact.errorCode);
    return (
      <div
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        role="alert"
      >
        <TriangleAlert aria-hidden className="size-5 text-destructive" />
        <p>{t(`table.error.code.${code.success ? code.data : "UNKNOWN"}`)}</p>
        {surfaceInteractive && host.interactive ? (
          <p className="text-muted-foreground">{t("table.error.generateAgain")}</p>
        ) : null}
      </div>
    );
  }

  const content = parseContent(payload, surfaceInteractive);
  if (!content) return <TableCannotDisplay />;

  return (
    <TableErrorBoundary>
      <TableViewer
        content={content}
        freshness={freshness}
        interactive={interactive}
        regenerationFailure={readRegenerationFailure(payload, "table")}
        title={title}
        version={version}
      />
    </TableErrorBoundary>
  );
}
