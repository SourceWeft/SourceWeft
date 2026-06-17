import type { ToolApprovalResume } from "@sourceweft/sdk";
import type { ActiveThreadRun } from "../../[threadId]/chat-stream-runner-control";
import {
  combineToolApprovalResumes,
  getPendingToolConfirmationItems,
  orderToolConfirmationResolutions,
  updateToolConfirmationOrder,
  type ToolConfirmationItem,
} from "./tool-confirmation-state";
import type { ToolConfirmationResolution } from "./types";

export type ToolConfirmationIntervention = {
  id: string;
  messageId: string;
  toolCallId?: string;
};

export type ToolConfirmationDecision = "approve" | "reject";

export type ToolConfirmationControllerState = {
  activeIntervention: ToolConfirmationIntervention | null;
  order: string[];
  resolutions: ToolConfirmationResolution[];
  runKey: string | null;
};

export type ToolConfirmationResumeEffect = {
  approvalThreadRunId: string | null;
  assistantMessageId: string;
  resolvedConfirmationIds: string[];
  toolApprovalResume: ToolApprovalResume;
};

export const initialToolConfirmationControllerState: ToolConfirmationControllerState =
  {
    activeIntervention: null,
    order: [],
    resolutions: [],
    runKey: null,
  };

export function getToolConfirmationRunKey(
  activeThreadRun: ActiveThreadRun | null | undefined,
) {
  if (activeThreadRun?.status !== "waiting_for_approval") {
    return null;
  }
  return activeThreadRun.idempotencyKey ?? activeThreadRun.id ?? null;
}

export function toolConfirmationInterventionFromItem(
  item: ToolConfirmationItem,
): ToolConfirmationIntervention {
  return {
    id: item.confirmation.id,
    messageId: item.messageId,
    toolCallId: item.toolCall.id,
  };
}

function upsertResolution(
  resolutions: ToolConfirmationResolution[],
  nextResolution: ToolConfirmationResolution,
) {
  return [
    ...resolutions.filter(
      (resolution) =>
        resolution.confirmationId !== nextResolution.confirmationId,
    ),
    nextResolution,
  ];
}

function getNextActiveIntervention(input: {
  items: ToolConfirmationItem[];
  resolutions: ToolConfirmationResolution[];
}) {
  const nextItem = getPendingToolConfirmationItems(
    input.items,
    input.resolutions,
  )[0];
  return nextItem ? toolConfirmationInterventionFromItem(nextItem) : null;
}

export function syncToolConfirmationRun(input: {
  items: ToolConfirmationItem[];
  runKey: string | null;
  state: ToolConfirmationControllerState;
}): ToolConfirmationControllerState {
  const sameRun = input.state.runKey === input.runKey;
  const resolutions = sameRun ? input.state.resolutions : [];
  const order = sameRun
    ? updateToolConfirmationOrder(input.state.order, input.items)
    : updateToolConfirmationOrder([], input.items);
  const pendingItems = getPendingToolConfirmationItems(
    input.items,
    resolutions,
  );
  const activeIntervention =
    input.state.activeIntervention &&
    pendingItems.some(
      (item) => item.confirmation.id === input.state.activeIntervention?.id,
    )
      ? input.state.activeIntervention
      : null;

  return {
    ...input.state,
    activeIntervention,
    order,
    resolutions,
    runKey: input.runKey,
  };
}

export function activateFirstPendingToolConfirmation(input: {
  items: ToolConfirmationItem[];
  state: ToolConfirmationControllerState;
}): ToolConfirmationControllerState {
  return {
    ...input.state,
    activeIntervention:
      getNextActiveIntervention({
        items: input.items,
        resolutions: input.state.resolutions,
      }) ?? input.state.activeIntervention,
  };
}

function scopedResolutions(input: {
  confirmationIds: string[];
  resolutions: ToolConfirmationResolution[];
}) {
  const confirmationIdSet = new Set(input.confirmationIds);
  return input.resolutions.filter((resolution) =>
    confirmationIdSet.has(resolution.confirmationId),
  );
}

export function settleToolConfirmationDecision(input: {
  decision: ToolConfirmationDecision;
  item: ToolConfirmationItem;
  items: ToolConfirmationItem[];
  resume: ToolApprovalResume | null | undefined;
  state: ToolConfirmationControllerState;
}): {
  missingResume: boolean;
  resumeEffect: ToolConfirmationResumeEffect | null;
  state: ToolConfirmationControllerState;
} {
  const nextResolution: ToolConfirmationResolution = {
    confirmationId: input.item.confirmation.id,
    decision: input.decision,
    resume: input.resume ?? null,
  };
  const resolutions = upsertResolution(input.state.resolutions, nextResolution);
  const nextActiveIntervention = getNextActiveIntervention({
    items: input.items,
    resolutions,
  });

  const nextState = {
    ...input.state,
    activeIntervention: nextActiveIntervention,
    resolutions,
  };

  if (nextActiveIntervention) {
    return {
      missingResume: false,
      resumeEffect: null,
      state: nextState,
    };
  }

  const confirmationIds = input.items.map((item) => item.confirmation.id);
  const orderedResolutions = orderToolConfirmationResolutions({
    confirmationIds,
    resolutions: scopedResolutions({
      confirmationIds,
      resolutions,
    }),
  });
  const toolApprovalResume = combineToolApprovalResumes(orderedResolutions);
  if (!toolApprovalResume) {
    return {
      missingResume: true,
      resumeEffect: null,
      state: nextState,
    };
  }

  return {
    missingResume: false,
    resumeEffect: {
      approvalThreadRunId: input.item.threadRunId,
      assistantMessageId: input.item.assistantMessageId,
      resolvedConfirmationIds: orderedResolutions.map(
        (resolution) => resolution.confirmationId,
      ),
      toolApprovalResume,
    },
    state: nextState,
  };
}

export function markToolConfirmationTerminal(input: {
  item: ToolConfirmationItem;
  items: ToolConfirmationItem[];
  reason: "expired" | "stale";
  state: ToolConfirmationControllerState;
}): ToolConfirmationControllerState {
  const nextResolution: ToolConfirmationResolution = {
    confirmationId: input.item.confirmation.id,
    decision: "reject",
    expired: input.reason === "expired" || undefined,
    resume: null,
    stale: input.reason === "stale" || undefined,
  };
  const resolutions = upsertResolution(input.state.resolutions, nextResolution);
  return {
    ...input.state,
    activeIntervention: getNextActiveIntervention({
      items: input.items,
      resolutions,
    }),
    resolutions,
  };
}

export function stopToolConfirmationRun(input: {
  items: ToolConfirmationItem[];
  state: ToolConfirmationControllerState;
}): ToolConfirmationControllerState {
  let resolutions = input.state.resolutions;
  for (const item of input.items) {
    resolutions = upsertResolution(resolutions, {
      confirmationId: item.confirmation.id,
      decision: "reject",
      resume: null,
      stopped: true,
    });
  }

  return {
    ...input.state,
    activeIntervention: null,
    resolutions,
  };
}
