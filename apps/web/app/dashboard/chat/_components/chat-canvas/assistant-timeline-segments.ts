import type { AssistantActivityItem } from "./assistant-activity-items";

export type AssistantTimelineSegment =
  | {
      key: string;
      order: number;
      text: string;
      type: "assistant_text";
    }
  | {
      items: AssistantActivityItem[];
      key: string;
      order: number;
      type: "workflow";
    };

function normalizeText(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isDuplicateText(input: { candidate: string; text: string }) {
  const candidate = normalizeText(input.candidate);
  const text = normalizeText(input.text);
  if (candidate.length === 0 || text.length === 0) {
    return false;
  }
  if (candidate === text) {
    return true;
  }
  return text.includes(candidate);
}

function appendAssistantTextSegment(
  segments: AssistantTimelineSegment[],
  input: { key: string; mergeWithPrevious?: boolean; order: number; text: string },
) {
  const text = input.text.trim();
  if (!text) {
    return;
  }

  const previous = segments.at(-1);
  if (input.mergeWithPrevious !== false && previous?.type === "assistant_text") {
    previous.text = `${previous.text}\n\n${text}`;
    return;
  }

  segments.push({
    key: input.key,
    order: input.order,
    text,
    type: "assistant_text",
  });
}

function appendWorkflowSegment(
  segments: AssistantTimelineSegment[],
  input: { items: AssistantActivityItem[]; key: string; order: number },
) {
  if (input.items.length === 0) {
    return;
  }
  segments.push({
    items: input.items,
    key: input.key,
    order: input.order,
    type: "workflow",
  });
}

export function buildAssistantTimelineSegments(input: {
  assistantText?: string;
  isTextInterrupted?: boolean;
  items: AssistantActivityItem[];
}): AssistantTimelineSegment[] {
  const segments: AssistantTimelineSegment[] = [];
  const finalAssistantText = input.assistantText?.trim() ?? "";
  let pendingWorkflowItems: AssistantActivityItem[] = [];

  const flushWorkflow = () => {
    if (pendingWorkflowItems.length === 0) {
      return;
    }
    appendWorkflowSegment(segments, {
      items: pendingWorkflowItems,
      key: `workflow:${pendingWorkflowItems.map((item) => item.key).join(":")}`,
      order: pendingWorkflowItems[0]?.order ?? 0,
    });
    pendingWorkflowItems = [];
  };

  for (const item of input.items) {
    if (item.type === "reasoning") {
      flushWorkflow();
      if (!isDuplicateText({ candidate: item.text, text: finalAssistantText })) {
        appendAssistantTextSegment(segments, {
          key: item.key,
          order: item.order,
          text: item.text,
        });
      }
      continue;
    }

    pendingWorkflowItems.push(item);
  }

  flushWorkflow();

  if (finalAssistantText) {
    const finalTextSegment: AssistantTimelineSegment = {
      key: "assistant-final-text",
      order: Number.MAX_SAFE_INTEGER,
      text: finalAssistantText,
      type: "assistant_text",
    };
    const lastSegment = segments.at(-1);
    if (input.isTextInterrupted === true && lastSegment?.type === "workflow") {
      segments.splice(segments.length - 1, 0, finalTextSegment);
    } else {
      appendAssistantTextSegment(segments, {
        key: finalTextSegment.key,
        mergeWithPrevious: false,
        order: finalTextSegment.order,
        text: finalTextSegment.text,
      });
    }
  }

  return segments;
}
