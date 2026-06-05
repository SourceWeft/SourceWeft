import { Loader2 } from "lucide-react";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import { groupConsecutiveToolItems } from "./assistant-activity-groups";
import { buildAssistantActivityItems } from "./assistant-activity-items";
import type { AssistantActivityItem } from "./assistant-activity-items";
import { AssistantActivitySegment } from "./assistant-activity-segment";
import { AssistantToolCard } from "./assistant-tool-card";
import type { MessageVersion, ToolConfirmationResolution } from "./types";

export type AssistantActivityPlaceholderPhase = "thinking" | "responding";

function getPlaceholderLabel(phase: AssistantActivityPlaceholderPhase) {
  return phase === "responding" ? "Responding..." : "Thinking...";
}

function AssistantActivityPlaceholder({
  phase,
}: {
  phase: AssistantActivityPlaceholderPhase;
}) {
  return (
    <div className="flex min-h-8 max-w-2xl items-center gap-1 rounded-md px-1 py-1 text-muted-foreground text-sm">
      <span className="grid size-6 shrink-0 place-items-center">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
      <span className="text-[13px] text-foreground/75">
        <Shimmer duration={1}>{getPlaceholderLabel(phase)}</Shimmer>
      </span>
    </div>
  );
}

function AssistantToolGroup({
  header,
  items,
  onWorkfileClick,
  resolvedConfirmations,
}: {
  header: Extract<AssistantActivityItem, { type: "tool" }>;
  items: AssistantActivityItem[];
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
    <AssistantToolCard
      contentClassName="ml-0 px-0"
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
                <AssistantToolCard
                  key={item.key}
                  onWorkfileClick={onWorkfileClick}
                  resolvedConfirmations={resolvedConfirmations}
                  toolCall={item.toolCall}
                  toolStep={item.toolStep}
                />
              );
            }

            return (
              <AssistantActivitySegment
                item={item}
                key={item.key}
                onWorkfileClick={onWorkfileClick}
                resolvedConfirmations={resolvedConfirmations}
              />
            );
          })}
        </div>
      ) : null}
    </AssistantToolCard>
  );
}

export function AssistantActivityRenderItems({
  items,
  onWorkfileClick,
  resolvedConfirmations,
}: {
  items: AssistantActivityItem[];
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
}) {
  const renderItems = groupConsecutiveToolItems(items);

  return (
    <>
      {renderItems.map((item) => (
        <div key={item.key}>
          {item.type === "tool-group" ? (
            <AssistantToolGroup
              header={item.header}
              items={item.items}
              onWorkfileClick={onWorkfileClick}
              resolvedConfirmations={resolvedConfirmations}
            />
          ) : (
            <AssistantActivitySegment
              item={item}
              onWorkfileClick={onWorkfileClick}
              resolvedConfirmations={resolvedConfirmations}
            />
          )}
        </div>
      ))}
    </>
  );
}

export function AssistantActivityStack({
  assistantText,
  onWorkfileClick,
  placeholderPhase,
  isCancelled = false,
  resolvedConfirmations = [],
  version,
}: {
  assistantText?: string;
  onWorkfileClick?: (path: string) => void;
  placeholderPhase?: AssistantActivityPlaceholderPhase | null;
  isCancelled?: boolean;
  isStreaming: boolean;
  resolvedConfirmations?: ToolConfirmationResolution[];
  version: MessageVersion;
}) {
  const items = buildAssistantActivityItems({
    assistantText,
    steps: version.thinkingSteps,
    toolCalls: version.toolCalls,
    traceParts: version.traceParts,
  });
  const shouldShowPlaceholder = Boolean(placeholderPhase) && !isCancelled;

  if (items.length === 0) {
    if (shouldShowPlaceholder) {
      return (
        <div className="my-1.5">
          <AssistantActivityPlaceholder phase={placeholderPhase!} />
        </div>
      );
    }
    return null;
  }

  return (
    <div
      className="my-1.5 max-w-2xl space-y-1 text-sm"
      data-assistant-activity-stack="true"
    >
      {shouldShowPlaceholder ? (
        <AssistantActivityPlaceholder phase={placeholderPhase!} />
      ) : null}
      <AssistantActivityRenderItems
        items={items}
        onWorkfileClick={onWorkfileClick}
        resolvedConfirmations={resolvedConfirmations}
      />
    </div>
  );
}
