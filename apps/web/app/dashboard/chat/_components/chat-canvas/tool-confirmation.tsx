"use client";

import { useMemo, useState } from "react";
import {
  CheckIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@sourceweft/ui-web/components/ai-elements/confirmation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  toolConfirmationRequestSchema,
  type ToolConfirmationRequest,
} from "@sourceweft/contracts";
import { connectorsClient } from "../../../../../lib/sdk";
import { compactText } from "./message-assets";
import type { ToolCallRecord, VersionedMessageGroup } from "./types";

type ConfirmationState =
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

type ConfirmationApproval =
  | {
      id: string;
      approved?: never;
      reason?: never;
    }
  | {
      id: string;
      approved: boolean;
      reason?: string;
    };

type ToolConfirmationDecision = "approve" | "reject";

export type ToolConfirmationRequestOutput = ToolConfirmationRequest;

type ToolConfirmationItem = {
  confirmation: ToolConfirmationRequestOutput;
  messageId: string;
  toolCall: ToolCallRecord;
};

export type ToolConfirmationIntervention = {
  id: string;
  messageId: string;
  toolCallId: string;
};

function getActiveAssistantVersion(
  group: VersionedMessageGroup,
  activeVersionByGroup: Record<string, number>,
) {
  const activeIndex =
    activeVersionByGroup[group.groupId] ?? group.versions.length - 1;
  return group.versions[Math.max(0, activeIndex)];
}

function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getStringRecordValue(
  record: Record<string, unknown> | null,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    const record = getObjectRecord(output);
    const content = getStringRecordValue(record, "content");
    return content ? parseJsonOutput(content) : output;
  }
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) {
    return output;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return output;
  }
}

export function getToolConfirmationOutput(
  output: unknown,
): ToolConfirmationRequestOutput | null {
  const parsed = parseJsonOutput(output);
  const record = getObjectRecord(parsed);
  if (!record) {
    return null;
  }
  if (record.type !== "tool_confirmation_request") {
    return null;
  }
  const parsedConfirmation = toolConfirmationRequestSchema.safeParse(record);
  return parsedConfirmation.success ? parsedConfirmation.data : null;
}

export function getToolConfirmationItems(
  messageGroups: VersionedMessageGroup[] | undefined,
  activeVersionByGroup: Record<string, number> = {},
) {
  return (messageGroups ?? []).flatMap((group) => {
    if (group.role !== "assistant") {
      return [];
    }
    const version = getActiveAssistantVersion(group, activeVersionByGroup);
    if (!version) {
      return [];
    }
    return (version.toolCalls ?? [])
      .map((toolCall) => {
        const confirmation = getToolConfirmationOutput(toolCall.output);
        return confirmation
          ? { confirmation, messageId: version.id, toolCall }
          : null;
      })
      .filter((item): item is ToolConfirmationItem => item !== null);
  });
}

export function getActiveToolConfirmationItems(
  messageGroups: VersionedMessageGroup[] | undefined,
  activeVersionByGroup: Record<string, number> = {},
) {
  const groups = messageGroups ?? [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group?.role !== "assistant") {
      continue;
    }
    const version = getActiveAssistantVersion(group, activeVersionByGroup);
    if (version?.finishReason !== "tool_confirmation_requested") {
      return [];
    }
    return (version.toolCalls ?? [])
      .map((toolCall) => {
        const confirmation = getToolConfirmationOutput(toolCall.output);
        return confirmation
          ? { confirmation, messageId: version.id, toolCall }
          : null;
      })
      .filter((item): item is ToolConfirmationItem => item !== null);
  }
  return [];
}

function confirmationStatusToState(status: string | undefined): ConfirmationState {
  if (status === "failed") {
    return "output-error";
  }
  if (status === "rejected" || status === "canceled") {
    return "output-denied";
  }
  if (status === "approved" || status === "running") {
    return "approval-responded";
  }
  if (status === "succeeded") {
    return "output-available";
  }
  return "approval-requested";
}

function confirmationStatusToApproval(
  id: string,
  status: string | undefined,
  reason?: string,
): ConfirmationApproval {
  if (status === "approved" || status === "running" || status === "succeeded") {
    return { id, approved: true, ...(reason ? { reason } : {}) };
  }
  if (status === "rejected" || status === "canceled") {
    return { id, approved: false, ...(reason ? { reason } : {}) };
  }
  return { id };
}

function canDecide(
  confirmation: ToolConfirmationRequestOutput,
  state: ConfirmationState,
  isBusy: boolean,
  workspaceId?: string | null,
) {
  return Boolean(workspaceId) && state === "approval-requested" && !isBusy;
}

function confirmationTitle(confirmation: ToolConfirmationRequestOutput) {
  return (
    confirmation.preview.title ??
    confirmation.preview.summary ??
    confirmation.action.label ??
    "Tool action"
  );
}

function ToolConfirmationPanel({
  item,
  onSettled,
  workspaceId,
}: {
  item: ToolConfirmationItem;
  onSettled?: (input: {
    decision: ToolConfirmationDecision;
    item: ToolConfirmationItem;
    result: Awaited<ReturnType<typeof connectorsClient.respondToConfirmation>>;
  }) => void;
  workspaceId?: string | null;
}) {
  const { confirmation } = item;
  const initialStatus = confirmation.status ?? confirmation.action.status;
  const [state, setState] = useState<ConfirmationState>(
    confirmationStatusToState(initialStatus),
  );
  const [approval, setApproval] = useState<ConfirmationApproval>(
    confirmationStatusToApproval(confirmation.id, initialStatus),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const title = confirmationTitle(confirmation);
  const requestSummary = compactText(
    confirmation.preview.summary ?? confirmation.preview.title ?? title,
    120,
  );
  const targetLabel = confirmation.preview.target?.label;
  const respondable = canDecide(confirmation, state, isBusy, workspaceId);

  async function respond(decision: ToolConfirmationDecision) {
    if (!workspaceId) {
      toast.error("SourceWeft confirmation is missing workspace context.");
      return;
    }
    setIsBusy(true);
    setState("approval-responded");
    setApproval({
      id: confirmation.id,
      approved: decision !== "reject",
      reason:
        decision === "reject"
          ? "Rejected in SourceWeft."
          : "Approved in SourceWeft.",
    });
    setMessage(
      decision === "reject"
        ? "Rejected in SourceWeft. The action was not run."
        : "Approved in SourceWeft. Resuming now...",
    );
    try {
      const result = await connectorsClient.respondToConfirmation(
        workspaceId,
        confirmation.id,
        {
          decision,
          confirmation,
        },
      );
      const status = result.confirmation.status;
      if (status === "rejected") {
        setState("output-denied");
        setMessage("Rejected in SourceWeft. The action was not run.");
        toast.info("Action rejected.");
        onSettled?.({ decision, item, result });
      } else if (status === "failed") {
        setState("output-error");
        setMessage("Action failed.");
        toast.error("Action failed.");
      } else {
        setState(confirmationStatusToState(status));
        setApproval({
          id: confirmation.id,
          approved: decision !== "reject",
          reason: "Approved in SourceWeft.",
        });
        setMessage(
          decision === "reject"
            ? "Rejected in SourceWeft. The action was not run."
            : "Approved in SourceWeft. Resuming now...",
        );
        onSettled?.({ decision, item, result });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Confirmation failed.";
      setState("output-error");
      setApproval({
        id: confirmation.id,
        approved: decision !== "reject",
        reason: errorMessage,
      });
      setMessage(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Confirmation
      approval={approval}
      state={state}
    >
      <ConfirmationRequest>
        <ConfirmationTitle>
          {title}
          {targetLabel ? (
            <>
              <br />
              <span className="text-xs">Target: {targetLabel}</span>
            </>
          ) : null}
          {requestSummary && requestSummary !== title ? (
            <>
              <br />
              <span className="text-xs">{requestSummary}</span>
            </>
          ) : null}
        </ConfirmationTitle>
      </ConfirmationRequest>
      <ConfirmationAccepted>
        <div className="flex items-start gap-2">
          {state === "output-error" ? (
            <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          ) : (
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-green-600" />
          )}
          <ConfirmationTitle className="block">
            {message ?? "Approved in SourceWeft."}
          </ConfirmationTitle>
        </div>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <div className="flex items-start gap-2">
          <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <ConfirmationTitle className="block">
            {message ?? "Rejected in SourceWeft."}
          </ConfirmationTitle>
        </div>
      </ConfirmationRejected>
      {state === "output-error" ? (
        <div
          className={cn(
            "flex items-start gap-2",
            approval && "approved" in approval && approval.approved
              ? "hidden"
              : undefined,
          )}
        >
          <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <ConfirmationTitle className="block">
            {message ?? "Action failed."}
          </ConfirmationTitle>
        </div>
      ) : null}
      <ConfirmationActions>
        <ConfirmationAction
          disabled={!respondable}
          onClick={() => void respond("reject")}
          variant="outline"
        >
          Reject
        </ConfirmationAction>
        <ConfirmationAction
          disabled={!respondable}
          onClick={() => void respond("approve")}
          variant="default"
        >
          {isBusy ? "Approving..." : "Approve"}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

export function ToolInterventionBar({
  activeVersionByGroup = {},
  activeIntervention = null,
  className,
  messageGroups,
  onInterventionSettled,
  workspaceId,
}: {
  activeVersionByGroup?: Record<string, number>;
  activeIntervention?: ToolConfirmationIntervention | null;
  className?: string;
  messageGroups?: VersionedMessageGroup[];
  onInterventionSettled?: (input: {
    decision: ToolConfirmationDecision;
    item: ToolConfirmationItem;
    result: Awaited<ReturnType<typeof connectorsClient.respondToConfirmation>>;
  }) => void;
  workspaceId?: string | null;
}) {
  const items = useMemo(
    () => getActiveToolConfirmationItems(messageGroups, activeVersionByGroup),
    [activeVersionByGroup, messageGroups],
  );
  const activeItems = activeIntervention
    ? items.filter(
        (item) =>
          item.confirmation.id === activeIntervention.id &&
          item.messageId === activeIntervention.messageId &&
          item.toolCall.id === activeIntervention.toolCallId,
      )
    : [];
  const visibleItems = activeItems.filter((item) => {
    const status = item.confirmation.status ?? item.confirmation.action.status;
    return (
      !status ||
      status === "proposed" ||
      status === "approved" ||
      status === "running" ||
      status === "failed"
    );
  });

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "border-t border-border/70 bg-background/95 px-4 py-3 shadow-[0_-8px_24px_hsl(var(--background)/0.9)] backdrop-blur",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-4xl">
        <Tabs defaultValue={visibleItems[0]?.confirmation.id}>
          {visibleItems.length > 1 ? (
            <div className="mb-2 flex items-center justify-between gap-3">
              <TabsList className="max-w-[50vw] overflow-x-auto">
                {visibleItems.map((item, index) => (
                  <TabsTrigger
                    className="min-w-0 max-w-40 truncate"
                    key={item.confirmation.id}
                    value={item.confirmation.id}
                  >
                    {index + 1}. {compactText(confirmationTitle(item.confirmation), 32)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <span className="text-muted-foreground text-xs">
                {visibleItems.length} pending
              </span>
            </div>
          ) : null}
          {visibleItems.map((item) => (
            <TabsContent key={item.confirmation.id} value={item.confirmation.id}>
              <ToolConfirmationPanel
                item={item}
                onSettled={onInterventionSettled}
                workspaceId={workspaceId}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
