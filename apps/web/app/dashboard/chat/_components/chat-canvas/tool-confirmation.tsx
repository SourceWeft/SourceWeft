"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CircleStopIcon,
  ShieldAlertIcon,
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
import { connectorsClient } from "../../../../../lib/sdk";
import type { ActiveThreadRun } from "../../[threadId]/chat-stream-runner-control";
import { compactText } from "./message-assets";
import {
  confirmationTitle,
  requestDetailLines,
} from "./tool-confirmation-display";
import {
  getVisibleToolConfirmationItems,
  isExpiredToolConfirmationResponse,
  isStaleToolConfirmationResponse,
  type ToolConfirmationItem,
  type ToolConfirmationRequestOutput,
} from "./tool-confirmation-state";
import type { ToolConfirmationResolution } from "./types";
import type {
  ToolConfirmationDecision,
  ToolConfirmationIntervention,
} from "./tool-confirmation-controller";

type ConfirmationState =
  | "input-streaming"
  | "input-available"
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

function confirmationStatusToState(
  status: string | undefined,
): ConfirmationState {
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
  threadRunId?: string | null,
) {
  return (
    Boolean(workspaceId) &&
    Boolean(threadRunId) &&
    state === "approval-requested" &&
    !isBusy
  );
}

function ToolConfirmationPanel({
  activeThreadRun,
  item,
  onSettled,
  onExpired,
  onStale,
  workspaceId,
}: {
  activeThreadRun?: ActiveThreadRun | null;
  item: ToolConfirmationItem;
  onSettled?: (input: {
    decision: ToolConfirmationDecision;
    item: ToolConfirmationItem;
    result: Awaited<ReturnType<typeof connectorsClient.respondToConfirmation>>;
  }) => void;
  onExpired?: (input: { item: ToolConfirmationItem }) => void;
  onStale?: (input: { item: ToolConfirmationItem }) => void;
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
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const submittedConfirmationIdRef = useRef<string | null>(null);

  useEffect(() => {
    submittedConfirmationIdRef.current = null;
    setHasSubmitted(false);
  }, [confirmation.id]);

  const title = confirmationTitle(confirmation);
  const requestLines = requestDetailLines(confirmation);
  const threadRunId = item.threadRunId ?? activeThreadRun?.id ?? null;
  const respondable = canDecide(
    confirmation,
    state,
    isBusy || hasSubmitted,
    workspaceId,
    threadRunId,
  );

  async function respond(decision: ToolConfirmationDecision) {
    if (submittedConfirmationIdRef.current === confirmation.id) {
      return;
    }
    if (!workspaceId) {
      toast.error("SourceWeft confirmation is missing workspace context.");
      return;
    }
    if (!threadRunId) {
      toast.error("This confirmation is no longer attached to an active run.");
      return;
    }
    submittedConfirmationIdRef.current = confirmation.id;
    setHasSubmitted(true);
    const isRejectDecision = decision === "reject";
    setIsBusy(true);
    setState("approval-responded");
    setApproval({
      id: confirmation.id,
      approved: !isRejectDecision,
      reason: isRejectDecision
        ? "Rejected in SourceWeft."
        : "Approved in SourceWeft.",
    });
    setMessage(
      isRejectDecision
        ? "Rejected in SourceWeft. The action was not run."
        : "Approved in SourceWeft.",
    );
    try {
      const result = await connectorsClient.respondToConfirmation(
        workspaceId,
        confirmation.id,
        {
          decision,
          confirmation,
          threadRunId,
          assistantMessageId: item.assistantMessageId,
        },
      );
      const status = result.confirmation.status;
      if (isRejectDecision || status === "rejected") {
        setState("output-denied");
        setMessage("Rejected in SourceWeft. The action was not run.");
        onSettled?.({ decision, item, result });
      } else if (status === "failed") {
        setState("output-error");
        setMessage("Action failed.");
        toast.error("Action failed.");
      } else {
        setState(confirmationStatusToState(status));
        setApproval({
          id: confirmation.id,
          approved: !isRejectDecision,
          reason: "Approved in SourceWeft.",
        });
        setMessage(
          isRejectDecision
            ? "Rejected in SourceWeft. The action was not run."
            : "Approved in SourceWeft.",
        );
        onSettled?.({ decision, item, result });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Confirmation failed.";
      if (isExpiredToolConfirmationResponse(error)) {
        onExpired?.({ item });
        return;
      }
      if (isStaleToolConfirmationResponse(error)) {
        onStale?.({ item });
        return;
      }
      submittedConfirmationIdRef.current = null;
      setHasSubmitted(false);
      setState("approval-requested");
      setApproval({ id: confirmation.id });
      setMessage(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Confirmation approval={approval} state={state}>
      <ConfirmationRequest>
        <ConfirmationTitle className="block">
          <span className="flex items-start gap-2">
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {title}
              </span>
              {requestLines.length > 0 ? (
                <span className="mt-1 block space-y-0.5">
                  {requestLines.map((line) => (
                    <span
                      className="block text-xs leading-5 text-muted-foreground"
                      key={line}
                    >
                      {line}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          </span>
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
          variant="destructive"
        >
          Reject
        </ConfirmationAction>
        <ConfirmationAction
          disabled={!respondable}
          onClick={() => void respond("approve")}
        >
          {isBusy ? "Approving..." : "Approve"}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

export function ToolInterventionBar({
  activeThreadRun = null,
  activeIntervention = null,
  className,
  items,
  onInterventionSettled,
  onInterventionExpired,
  onInterventionStale,
  onStopWaiting,
  resolvedConfirmations = [],
  workspaceId,
}: {
  activeThreadRun?: ActiveThreadRun | null;
  activeIntervention?: ToolConfirmationIntervention | null;
  className?: string;
  items?: ToolConfirmationItem[];
  onInterventionSettled?: (input: {
    decision: ToolConfirmationDecision;
    item: ToolConfirmationItem;
    result: Awaited<ReturnType<typeof connectorsClient.respondToConfirmation>>;
  }) => void;
  onInterventionExpired?: (input: { item: ToolConfirmationItem }) => void;
  onInterventionStale?: (input: { item: ToolConfirmationItem }) => void;
  onStopWaiting?: () => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  workspaceId?: string | null;
}) {
  const visibleItems = getVisibleToolConfirmationItems(
    items ?? [],
    resolvedConfirmations,
  );
  const defaultVisibleId = visibleItems[0]?.confirmation.id;
  const activeVisibleId = visibleItems.some(
    (item) => item.confirmation.id === activeIntervention?.id,
  )
    ? activeIntervention?.id
    : defaultVisibleId;
  const [selectedConfirmationId, setSelectedConfirmationId] =
    useState(activeVisibleId);

  useEffect(() => {
    setSelectedConfirmationId(activeVisibleId);
  }, [activeVisibleId]);

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
        <Tabs
          value={selectedConfirmationId}
          onValueChange={setSelectedConfirmationId}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              {visibleItems.length > 1 ? (
                <>
                  <TabsList className="max-w-[50vw] overflow-x-auto">
                    {visibleItems.map((item, index) => (
                      <TabsTrigger
                        className="min-w-0 max-w-40 truncate"
                        key={item.confirmation.id}
                        value={item.confirmation.id}
                      >
                        {index + 1}.{" "}
                        {compactText(confirmationTitle(item.confirmation), 32)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <span className="text-muted-foreground text-xs">
                    {visibleItems.length} pending
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Waiting for approval
                </span>
              )}
            </div>
            {onStopWaiting ? (
              <button
                aria-label="End approval wait"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/20 disabled:opacity-60"
                onClick={onStopWaiting}
                title="End approval wait"
                type="button"
              >
                <CircleStopIcon className="size-3.5" />
                End
              </button>
            ) : null}
          </div>
          {visibleItems.map((item) => (
            <TabsContent
              key={item.confirmation.id}
              value={item.confirmation.id}
            >
              <ToolConfirmationPanel
                activeThreadRun={activeThreadRun}
                item={item}
                onExpired={onInterventionExpired}
                onSettled={onInterventionSettled}
                onStale={onInterventionStale}
                workspaceId={workspaceId}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
