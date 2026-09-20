"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CircleStopIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useLocalOperationStatus } from "../local-conversation-status";
import type { ToolConfirmationDecision as ToolConfirmationWireDecision } from "@sourceweft/sdk";
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
  sandboxExecuteCommandText,
} from "./tool-confirmation-display";
import {
  getVisibleToolConfirmationItems,
  isExpiredToolConfirmationResponse,
  isStaleToolConfirmationResponse,
  type ToolConfirmationItem,
  type ToolConfirmationRequestOutput,
} from "./tool-confirmation-state";
import {
  buildTrustPayload,
  defaultTrustDurationChoiceId,
  describeDecisionOutcome,
  getConfirmationDecisionOptions,
  getTrustDurationChoices,
  hasAlwaysAllowOption,
  type ToolConfirmationDecisionOption,
} from "./tool-confirmation-trust";
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

function decisionButtonVariant(
  decision: ToolConfirmationDecisionOption["decision"],
) {
  if (decision === "reject") {
    return "destructive" as const;
  }
  // "Always allow" is the wider grant, so it is the quieter button: the
  // one-off approve stays the visually default choice.
  if (decision === "approve_always") {
    return "outline" as const;
  }
  return "default" as const;
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
  const t = useTranslations("dashboardChatCanvas");
  const localStatus = useLocalOperationStatus();
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
  const [trustDurationId, setTrustDurationId] = useState(
    defaultTrustDurationChoiceId,
  );
  const submittedConfirmationIdRef = useRef<string | null>(null);

  useEffect(() => {
    submittedConfirmationIdRef.current = null;
    setHasSubmitted(false);
  }, [confirmation.id]);

  const title = confirmationTitle(confirmation, t);
  const toolCallInput = item.toolCall.input as
    Record<string, unknown> | undefined;
  const requestLines = requestDetailLines(confirmation, toolCallInput, t);
  const commandText = sandboxExecuteCommandText({
    confirmation,
    toolCallInput,
  });
  const threadRunId = item.threadRunId ?? activeThreadRun?.id ?? null;
  // Decisions are whatever the server offered for this confirmation. The card
  // has no list of its own, so a producer that never offers `approve_always`
  // can never grow an "Always allow" button by accident.
  const decisionOptions = getConfirmationDecisionOptions(confirmation, t);
  const durationChoices = getTrustDurationChoices(t);
  const offersAlwaysAllow = hasAlwaysAllowOption(confirmation);
  const respondable = canDecide(
    confirmation,
    state,
    isBusy || hasSubmitted,
    workspaceId,
    threadRunId,
  );

  async function respond(decision: ToolConfirmationWireDecision) {
    if (localStatus.blocked && decision !== "reject") return;
    if (submittedConfirmationIdRef.current === confirmation.id) {
      return;
    }
    if (!workspaceId) {
      toast.error(t("toolConfirmation.missingWorkspace"));
      return;
    }
    if (!threadRunId) {
      toast.error(t("toolConfirmation.notAttached"));
      return;
    }
    submittedConfirmationIdRef.current = confirmation.id;
    setHasSubmitted(true);
    const isRejectDecision = decision === "reject";
    // Everything downstream of the card only distinguishes "it ran" from "it
    // did not"; `approve_always` is a wire decision, not a third outcome.
    const settledDecision: ToolConfirmationDecision = isRejectDecision
      ? "reject"
      : "approve";
    setIsBusy(true);
    setState("approval-responded");
    setApproval({
      id: confirmation.id,
      approved: !isRejectDecision,
      reason: isRejectDecision
        ? t("toolConfirmation.rejectedInSourceweft")
        : t("toolConfirmation.approvedInSourceweft"),
    });
    // Optimistic copy never mentions remembering: only the server's response
    // can say whether a standing approval was actually created.
    setMessage(
      isRejectDecision
        ? t("toolConfirmation.rejectedNotRun")
        : t("toolConfirmation.approvedInSourceweft"),
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
          ...(decision === "approve_always"
            ? { trust: buildTrustPayload(trustDurationId) }
            : {}),
        },
      );
      const status = result.confirmation.status;
      // `trustRule` is the only truthful signal that anything was remembered.
      // It is absent whenever the server degraded `approve_always` to a plain
      // approve, and the copy has to follow it rather than the button pressed.
      const outcomeMessage = describeDecisionOutcome(
        {
          decision,
          trustRule: result.trustRule ?? null,
        },
        t,
      );
      if (isRejectDecision || status === "rejected") {
        setState("output-denied");
        setMessage(t("toolConfirmation.rejectedNotRun"));
        onSettled?.({ decision: settledDecision, item, result });
      } else if (status === "failed") {
        setState("output-error");
        setMessage(t("toolConfirmation.actionFailed"));
        toast.error(t("toolConfirmation.actionFailed"));
      } else {
        setState(confirmationStatusToState(status));
        setApproval({
          id: confirmation.id,
          approved: !isRejectDecision,
          reason: t("toolConfirmation.approvedInSourceweft"),
        });
        setMessage(outcomeMessage);
        onSettled?.({ decision: settledDecision, item, result });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : t("toolConfirmation.confirmationFailed");
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
    <Confirmation
      approval={approval}
      state={state}
      className="min-h-0 max-h-[min(420px,calc(45svh-3.5rem))] overflow-hidden"
    >
      <ConfirmationRequest>
        <ConfirmationTitle className="block min-h-0 overflow-y-auto overscroll-contain pr-1 [overflow-wrap:anywhere]">
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
              {commandText ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                    {t("toolConfirmation.viewCommand", {
                      lines: commandText.split("\n").length,
                      characters: commandText.length,
                    })}
                  </summary>
                  <pre className="mt-1 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs leading-5">
                    {commandText}
                  </pre>
                </details>
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
            {message ?? t("toolConfirmation.approvedInSourceweft")}
          </ConfirmationTitle>
        </div>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <div className="flex items-start gap-2">
          <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <ConfirmationTitle className="block">
            {message ?? t("toolConfirmation.rejectedInSourceweft")}
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
            {message ?? t("toolConfirmation.actionFailed")}
          </ConfirmationTitle>
        </div>
      ) : null}
      <ConfirmationActions className="shrink-0 flex-wrap border-t border-border/50 bg-background pt-2">
        {offersAlwaysAllow ? (
          <label className="mr-auto flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {t("toolConfirmation.rememberFor")}
            <select
              aria-label={t("toolConfirmation.rememberAria")}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              disabled={!respondable}
              onChange={(event) => setTrustDurationId(event.target.value)}
              value={trustDurationId}
            >
              {durationChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {decisionOptions.map((option) => (
          <ConfirmationAction
            disabled={
              !respondable ||
              (localStatus.blocked && option.decision !== "reject")
            }
            key={option.decision}
            onClick={() => void respond(option.decision)}
            {...(option.description ? { title: option.description } : {})}
            variant={decisionButtonVariant(option.decision)}
          >
            {isBusy && option.decision !== "reject"
              ? t("toolConfirmation.approving")
              : option.label}
          </ConfirmationAction>
        ))}
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
  const t = useTranslations("dashboardChatCanvas");
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
        "min-h-0 max-h-[min(480px,45svh)] shrink-0 border-t border-border/70 bg-background/95 px-3 py-2 shadow-[0_-8px_24px_hsl(var(--background)/0.9)] backdrop-blur sm:px-4",
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
                  <TabsList className="max-w-full overflow-x-auto">
                    {visibleItems.map((item, index) => (
                      <TabsTrigger
                        className="min-w-0 max-w-40 truncate"
                        key={item.confirmation.id}
                        value={item.confirmation.id}
                      >
                        {index + 1}.{" "}
                        {compactText(
                          confirmationTitle(item.confirmation, t),
                          32,
                        )}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <span className="text-muted-foreground text-xs">
                    {t("toolConfirmation.pending", {
                      count: visibleItems.length,
                    })}
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("toolConfirmation.waitingForApproval")}
                </span>
              )}
            </div>
            {onStopWaiting ? (
              <button
                aria-label={t("toolConfirmation.endApprovalWait")}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/20 disabled:opacity-60"
                onClick={onStopWaiting}
                title={t("toolConfirmation.endApprovalWait")}
                type="button"
              >
                <CircleStopIcon className="size-3.5" />
                {t("toolConfirmation.end")}
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
