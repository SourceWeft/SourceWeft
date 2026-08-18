import { Loader2 } from "lucide-react";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import { groupConsecutiveToolItems } from "./assistant-activity-groups";
import type { AssistantActivityItem } from "./assistant-activity-items";
import {
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import { AssistantActivitySegment } from "./assistant-activity-segment";
import { AssistantToolCard } from "./assistant-tool-card";
import { WebToolResults } from "../web-tool-results";
import type {
  CitationRecord,
  ToolConfirmationResolution,
} from "./types";

export type AssistantActivityPlaceholderPhase = "thinking" | "responding";

function getPlaceholderLabel(phase: AssistantActivityPlaceholderPhase) {
  return phase === "responding" ? "Responding..." : "Working";
}

export function AssistantActivityPlaceholder({
  phase,
}: {
  phase: AssistantActivityPlaceholderPhase;
}) {
  return (
    <div
      className={`${ASSISTANT_ACTIVITY_ROW_CLASS} max-w-2xl text-muted-foreground text-sm`}
    >
      <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
      <span
        className={`${ASSISTANT_ACTIVITY_LABEL_CLASS} text-[13px] text-foreground/75`}
      >
        <Shimmer duration={1}>{getPlaceholderLabel(phase)}</Shimmer>
      </span>
    </div>
  );
}

function AssistantToolGroup({
  availableCitations,
  header,
  items,
  onCitationClick,
  onWorkfileClick,
  resolvedConfirmations,
}: {
  availableCitations?: CitationRecord[];
  header: Extract<AssistantActivityItem, { type: "tool" }>;
  isStreaming?: boolean;
  items: AssistantActivityItem[];
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
}) {
  const shouldDefaultOpen = [header, ...items].some((item) => {
    if (item.type === "step") {
      return item.status === "in_progress";
    }
    if (item.type === "reasoning") {
      return false;
    }
    return (
      item.toolCall.status === "running" ||
      item.toolCall.status === "approval_requested" ||
      item.toolCall.status === "error"
    );
  });

  return (
    <>
      <AssistantToolCard
        defaultOpen={shouldDefaultOpen}
        onWorkfileClick={onWorkfileClick}
        resolvedConfirmations={resolvedConfirmations}
        toolCall={header.toolCall}
        toolStep={header.toolStep}
      >
        {items.length > 0 ? (
          <div className="space-y-1">
            {items.map((item) => {
              if (item.type === "tool") {
                return (
                  <div key={item.key}>
                    <AssistantToolCard
                      onWorkfileClick={onWorkfileClick}
                      resolvedConfirmations={resolvedConfirmations}
                      toolCall={item.toolCall}
                      toolStep={item.toolStep}
                    />
                    <WebToolResults
                      availableCitations={availableCitations}
                      className="ml-7"
                      onCitationClick={onCitationClick}
                      toolCall={item.toolCall}
                      variant="activity-row"
                    />
                  </div>
                );
              }

              return (
                <AssistantActivitySegment
                  availableCitations={availableCitations}
                  item={item}
                  key={item.key}
                  nested
                  onCitationClick={onCitationClick}
                  onWorkfileClick={onWorkfileClick}
                  resolvedConfirmations={resolvedConfirmations}
                />
              );
            })}
          </div>
        ) : null}
      </AssistantToolCard>
      <WebToolResults
        availableCitations={availableCitations}
        onCitationClick={onCitationClick}
        toolCall={header.toolCall}
        variant="activity-row"
      />
    </>
  );
}

export function AssistantActivityRenderItems({
  availableCitations,
  isStreaming = false,
  items,
  onCitationClick,
  onWorkfileClick,
  resolvedConfirmations,
}: {
  availableCitations?: CitationRecord[];
  isStreaming?: boolean;
  items: AssistantActivityItem[];
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
}) {
  const renderItems = groupConsecutiveToolItems(items);
  const streamingReasoningKey = isStreaming
    ? (() => {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const candidate = items[i];
          if (candidate && candidate.type === "reasoning") {
            return candidate.key;
          }
        }
        return undefined;
      })()
    : undefined;

  return (
    <>
      {renderItems.map((item) => (
        <div key={item.key}>
          {item.type === "tool-group" ? (
            <AssistantToolGroup
              availableCitations={availableCitations}
              header={item.header}
              isStreaming={isStreaming}
              items={item.items}
              onCitationClick={onCitationClick}
              onWorkfileClick={onWorkfileClick}
              resolvedConfirmations={resolvedConfirmations}
            />
          ) : (
            <AssistantActivitySegment
              availableCitations={availableCitations}
              isStreaming={item.key === streamingReasoningKey}
              item={item}
              onCitationClick={onCitationClick}
              onWorkfileClick={onWorkfileClick}
              resolvedConfirmations={resolvedConfirmations}
            />
          )}
        </div>
      ))}
    </>
  );
}
