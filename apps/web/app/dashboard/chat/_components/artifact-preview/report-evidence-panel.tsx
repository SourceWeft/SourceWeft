"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  CircleHelp,
  FileText,
  Globe,
  Library,
  type LucideIcon,
} from "lucide-react";
import type { FileReference } from "@sourceweft/contracts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@sourceweft/ui-web/components/ui/collapsible";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { CitationRecord } from "../chat-canvas/types";
import type { ArtifactListItem } from "../sources-hub/types";
import { loadReportEvidence } from "./report-evidence-loader";
import {
  chunkCitationRecord,
  type ReportEvidenceProvenance,
  type ReportEvidenceSource,
} from "./report-evidence";

// Both previews pull in the document viewer; defer them until a row is
// opened, the way thread-dialogs defers the chat citation preview.
const SourcePreviewPanel = dynamic(
  () => import("../source-preview-panel").then((mod) => mod.SourcePreviewPanel),
  { ssr: false },
);
const FileCitationPreview = dynamic(
  () =>
    import("../file-citation-preview").then((mod) => mod.FileCitationPreview),
  { ssr: false },
);

type EvidenceState = {
  key: string;
  sources: ReportEvidenceSource[] | null;
};

type ActivePreview =
  | { kind: "chunk"; citation: CitationRecord }
  | { kind: "file"; reference: FileReference; excerpt: string };

const KIND_ICONS: Record<ReportEvidenceProvenance["kind"], LucideIcon> = {
  chunk: Library,
  file: FileText,
  external: Globe,
  legacy: CircleHelp,
  missing: CircleHelp,
};

/**
 * Member-only evidence list for a published HTML report. Reads the private
 * `report.source.json` of the artifact's current version and lets a workspace
 * member jump from each `S<n>` row to the underlying source-library chunk,
 * working file or external page. Renders nothing for non-report artifacts,
 * while loading, when the version has no source file (404), or when the file
 * is not a report source. The public share page never mounts this.
 */

export function ReportEvidencePanel({
  artifact,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const t = useTranslations("dashboardChatFiles");
  const versionId = artifact.artifactVersionId;
  const eligible =
    artifact.artifactType === "html" &&
    artifact.status === "ready" &&
    Boolean(workspaceId) &&
    Boolean(versionId);
  const key =
    workspaceId && versionId
      ? `${workspaceId}:${artifact.id}:${versionId}`
      : null;
  const [state, setState] = useState<EvidenceState | null>(null);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState<ActivePreview | null>(null);

  useEffect(() => {
    setActive(null);
    if (!eligible || !workspaceId || !versionId || !key) {
      return;
    }
    let cancelled = false;
    // The loader dedupes concurrent panels and remembers settled answers, so
    // the Hub's inline panel and the expanded dialog share one request.
    void loadReportEvidence(workspaceId, artifact.id, versionId).then(
      (sources) => {
        if (!cancelled) setState({ key, sources });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifact.id, eligible, key, versionId, workspaceId]);

  const sources = eligible && state?.key === key ? state.sources : null;
  if (!sources || sources.length === 0) {
    return null;
  }

  const openSource = (source: ReportEvidenceSource) => {
    const provenance = source.provenance;
    switch (provenance.kind) {
      case "chunk":
        setActive({
          kind: "chunk",
          citation: chunkCitationRecord(source, provenance),
        });
        return;
      case "file":
        setActive({
          kind: "file",
          reference: provenance.reference,
          // The private source carries no quoted passage, so the viewer gets
          // the source title as its excerpt label; page/line/slide locators still
          // position the file, while paragraph locators cannot quote-match.
          excerpt: source.title,
        });
        return;
      case "external":
        window.open(provenance.url, "_blank", "noopener,noreferrer");
        return;
      default:
        return;
    }
  };

  const kindLabel = (kind: ReportEvidenceProvenance["kind"]) => {
    switch (kind) {
      case "chunk":
        return t("evidence.kind.chunk");
      case "file":
        return t("evidence.kind.file");
      case "external":
        return t("evidence.kind.external");
      default:
        return t("evidence.kind.unresolvable");
    }
  };

  return (
    <Collapsible
      className="mt-3 rounded-xl border bg-background/70"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        type="button"
      >
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {t("evidence.title", { count: sources.length })}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-180" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y border-t">
          {sources.map((source) => {
            const kind = source.provenance.kind;
            const actionable =
              kind === "chunk" || kind === "file" || kind === "external";
            const Icon = KIND_ICONS[kind];
            const body = (
              <>
                <span className="inline-flex shrink-0 items-center rounded-full border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground">
                  {source.id}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">
                    {source.title}
                  </span>
                  {source.locator ? (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {source.locator}
                    </span>
                  ) : null}
                  {source.url ? (
                    <span className="mt-0.5 block break-all text-[11px] text-muted-foreground">
                      {source.url}
                    </span>
                  ) : null}
                  {!actionable ? (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground/80">
                      {t("evidence.unresolvableHint")}
                    </span>
                  ) : null}
                </span>
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                  title={kindLabel(kind)}
                >
                  <Icon className="size-3" />
                  <span className="sr-only sm:not-sr-only">
                    {kindLabel(kind)}
                  </span>
                </span>
              </>
            );
            return (
              <li key={source.id} data-evidence-kind={kind}>
                {actionable ? (
                  <button
                    aria-label={t("evidence.open", { id: source.id })}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                    onClick={() => openSource(source)}
                    type="button"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex w-full items-start gap-2 px-3 py-2 opacity-80">
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>

      {active?.kind === "chunk" ? (
        <SourcePreviewPanel
          citation={active.citation}
          onOpenChange={(next) => {
            if (!next) setActive(null);
          }}
          open
          workspaceId={workspaceId}
        />
      ) : null}
      {active?.kind === "file" ? (
        <FileCitationPreview
          excerpt={active.excerpt}
          onOpenChange={(next) => {
            if (!next) setActive(null);
          }}
          open
          reference={active.reference}
        />
      ) : null}
    </Collapsible>
  );
}
