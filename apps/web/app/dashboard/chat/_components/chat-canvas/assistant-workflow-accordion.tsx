import { useEffect, useState } from "react";
import { ChevronRight, Clock3, Loader2 } from "lucide-react";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import { LoadingDots } from "@sourceweft/ui-web/components/ui/loading-dots";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { CitationAwareMessageResponse } from "./message-response";
import {
  getWorkflowHeaderLabel,
  inferWorkflowDurationMs,
  type AssistantWorkflowBlock,
} from "./assistant-render-segments";
import { shouldWorkflowAccordionDefaultOpen } from "./assistant-workflow-state";
import {
  GeneratedImageArtifactBlock,
  GeneratedPresentationArtifactBlock,
} from "./reasoning-trace";
import { AssistantToolCard } from "./assistant-tool-card";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  CitationRecord,
  MessageVersion,
  ToolConfirmationResolution,
} from "./types";

function WorkflowStatusIcon({ isRunning }: { isRunning: boolean }) {
  if (isRunning) {
    return (
      <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
    );
  }
  return <Clock3 className="size-3.5 text-muted-foreground/70" />;
}

export function AssistantWorkflowAccordion({
  artifactStatuses,
  blocks,
  durationMs,
  isRunning,
  onArtifactPreview,
  onCitationClick,
  onWorkfileClick,
  resolvedConfirmations,
  version,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  blocks: AssistantWorkflowBlock[];
  durationMs?: number | null;
  isRunning: boolean;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  version: MessageVersion;
  workspaceId?: string | null;
}) {
  const inferredDurationMs = inferWorkflowDurationMs({ blocks, version });
  const resolvedDurationMs =
    typeof durationMs === "number" && Number.isFinite(durationMs)
      ? durationMs
      : inferredDurationMs;
  const shouldDefaultOpen = shouldWorkflowAccordionDefaultOpen({
    blocks,
    isRunning,
    version,
  });
  const [isOpen, setIsOpen] = useState(shouldDefaultOpen);
  const label = getWorkflowHeaderLabel({
    durationMs: resolvedDurationMs,
    isRunning,
  });
  const showRunningTextLoading =
    isRunning &&
    blocks.some(
      (block) =>
        (block.type === "text" || block.type === "reasoning") &&
        block.text.trim().length > 0,
    );

  useEffect(() => {
    setIsOpen(shouldDefaultOpen);
  }, [shouldDefaultOpen]);

  return (
    <div className="my-1.5 max-w-3xl text-sm text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={isOpen}
        className="flex min-h-8 w-full items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/30"
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className="grid size-6 shrink-0 place-items-center">
          <WorkflowStatusIcon isRunning={isRunning} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
          {isRunning ? <Shimmer duration={1}>{label}</Shimmer> : label}
        </span>
        <span className="grid size-4 shrink-0 place-items-center">
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/50 transition-transform",
              isOpen && "rotate-90",
            )}
          />
        </span>
      </button>
      {isOpen ? (
        <div className="space-y-3 rounded-md px-1 py-1 text-foreground">
          {blocks.map((block) => {
            if (block.type === "reasoning" || block.type === "text") {
              return (
                <CitationAwareMessageResponse
                  availableCitations={version.availableCitations}
                  citations={version.citations}
                  key={block.id}
                  onCitationClick={onCitationClick}
                  onWorkfileClick={onWorkfileClick}
                >
                  {block.text}
                </CitationAwareMessageResponse>
              );
            }

            const toolCall = version.toolCalls?.find(
              (item) => item.id === block.toolCallId,
            );
            if (!toolCall) {
              return null;
            }

            if (block.type === "generated_image") {
              return (
                <GeneratedImageArtifactBlock
                  key={block.id}
                  onArtifactPreview={onArtifactPreview}
                  toolCall={toolCall}
                  workspaceId={workspaceId}
                />
              );
            }

            if (block.type === "generated_presentation") {
              return (
                <GeneratedPresentationArtifactBlock
                  artifactStatuses={artifactStatuses}
                  key={block.id}
                  onArtifactPreview={onArtifactPreview}
                  toolCall={toolCall}
                  workspaceId={workspaceId}
                />
              );
            }

            return (
              <AssistantToolCard
                key={block.id}
                onWorkfileClick={onWorkfileClick}
                resolvedConfirmations={resolvedConfirmations}
                toolCall={toolCall}
              />
            );
          })}
          {showRunningTextLoading ? <LoadingDots /> : null}
        </div>
      ) : null}
    </div>
  );
}
