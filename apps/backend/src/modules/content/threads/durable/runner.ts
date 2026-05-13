import type {
  ThreadChatRunJobPayload,
  ThreadChatRunJobResult,
} from "../../queue";
import type { MeterConsumeResponse } from "@sourceweft/contracts";
import { ContentError } from "../../errors";
import type { PreparedThreadTurn } from "../turn/types";
import { createThreadStreamErrorMessage } from "../stream/error";
import { toSseData } from "../stream/helpers";
import { ContentThreadStreamService } from "../stream/service";
import { ContentThreadTurnService } from "../turn/service";
import {
  createMessageRecord,
  findMessageRecord,
  updateMessageRecord,
} from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import { billingService } from "../../../../modules/billing";
import { durableChatRunService } from "./service";
import {
  findChatThreadRunById,
  updateChatThreadRunProgress,
} from "./repository";
import type {
  ChatRunSnapshot,
  ChatThreadRunRecord,
  ChatThreadRunStatus,
  DurableRunRequestSnapshot,
} from "./types";

type TerminalRunStatus = Extract<
  ChatThreadRunStatus,
  "completed" | "failed" | "cancelled"
>;
type DurableChatRunServiceAppendRunEvent =
  typeof durableChatRunService.appendRunEvent;
type DurableChatRunServiceFinishRun = typeof durableChatRunService.finishRun;

const STREAM_APPEND_TEXT_DELTA_FLUSH_MS = 80;
const ASSISTANT_SNAPSHOT_FLUSH_MS = 500;

function asRequestSnapshot(value: Record<string, unknown>) {
  return value as unknown as DurableRunRequestSnapshot;
}

function createThreadRunStream(input: {
  streamService: ContentThreadStreamService;
  request: DurableRunRequestSnapshot;
  options: Parameters<ContentThreadStreamService["streamThreadEvents"]>[1];
}) {
  if (input.request.mode === "refresh") {
    return input.streamService.refreshThreadEvents(input.request, input.options);
  }
  if (input.request.mode === "edit") {
    return input.streamService.editThreadEvents(input.request, input.options);
  }
  return input.streamService.streamThreadEvents(input.request, input.options);
}

function parseSsePayload(payload: string): Record<string, unknown> | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("data: ")) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice("data: ".length)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function serializeSsePayload(payload: Record<string, unknown>) {
  return toSseData(payload);
}

function isClientCancelledRun(run: ChatThreadRunRecord | null) {
  return run?.status === "cancel_requested" || run?.status === "cancelled";
}

function isTextDeltaPayload(
  payload: Record<string, unknown> | null,
): payload is Record<string, unknown> & { type: "text-delta"; delta: string } {
  return payload?.type === "text-delta" && typeof payload.delta === "string";
}

function mergeToolCall(existing: unknown[], next: unknown) {
  const record =
    next && typeof next === "object" && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) {
    return existing;
  }

  return [
    ...existing.filter((item) => {
      const itemRecord =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      return itemRecord?.id !== id;
    }),
    record,
  ];
}

function mergeThinkingStep(existing: unknown[], next: unknown) {
  const record =
    next && typeof next === "object" && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) {
    return existing;
  }

  return [
    ...existing.filter((item) => {
      const itemRecord =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      return itemRecord?.id !== id;
    }),
    record,
  ];
}

function updateSnapshotFromPayload(
  snapshot: ChatRunSnapshot,
  payload: Record<string, unknown> | null,
) {
  if (!payload || typeof payload.type !== "string") {
    return snapshot;
  }

  const next: ChatRunSnapshot = {
    ...snapshot,
    lastEventType: payload.type,
  };
  if (payload.type === "text-delta" && typeof payload.delta === "string") {
    next.assistantContent = `${next.assistantContent ?? ""}${payload.delta}`;
  }
  if (payload.type === "text-replace" && typeof payload.text === "string") {
    next.assistantContent = payload.text;
  }
  if (payload.type === "reasoning" && typeof payload.reasoning === "string") {
    next.reasoning = `${next.reasoning ?? ""}${payload.reasoning}`;
    if (payload.segment) {
      const segment = payload.segment;
      const id =
        segment && typeof segment === "object" && !Array.isArray(segment)
          ? (segment as Record<string, unknown>).id
          : null;
      next.reasoningSegments = [
        ...(next.reasoningSegments ?? []).filter((item) => {
          const itemRecord =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : null;
          return !id || itemRecord?.id !== id;
        }),
        segment,
      ];
    }
  }
  if (payload.type === "thinking-step" && payload.step) {
    next.thinkingSteps = mergeThinkingStep(
      next.thinkingSteps ?? [],
      payload.step,
    );
  }
  if (String(payload.type).startsWith("tool-call-") && payload.toolCall) {
    next.toolCalls = mergeToolCall(next.toolCalls ?? [], payload.toolCall);
  }
  if (payload.type === "citations") {
    if (Array.isArray(payload.citations)) {
      next.citations = payload.citations;
    }
    if (Array.isArray(payload.availableCitations)) {
      next.availableCitations = payload.availableCitations;
    } else if (Array.isArray(payload.citations)) {
      next.availableCitations = payload.citations;
    }
  }
  return next;
}

function buildThreadRunMetadata(run: ChatThreadRunRecord) {
  return {
    threadRun: {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      mode: run.mode,
      streamKey: run.streamKey,
    },
  };
}

async function createAssistantPlaceholder(input: {
  run: ChatThreadRunRecord;
  prepared: PreparedThreadTurn;
}) {
  const assistantMessage = await createMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    parentMessageId: input.prepared.assistantMessageParentId,
    role: "assistant",
    content: "",
    createdBy: null,
    model: input.prepared.modelAlias,
    creditsConsumed: null,
    metadata: {
      userMessageId: input.prepared.userMessage.id,
      sourceUserMessageId: input.prepared.userMessage.id,
      traceId: input.prepared.traceContext?.traceId ?? input.prepared.runTraceId,
      modelAlias: input.prepared.modelAlias,
      profileAlias: input.prepared.profileAlias,
      versionOf: input.prepared.assistantMessageParentId,
      toolCalls: [],
      thinkingSteps: input.prepared.preflightThinkingSteps,
      renderBlocks: [],
      ...buildThreadRunMetadata(input.run),
    },
  });

  return assistantMessage;
}

async function updateAssistantSnapshot(input: {
  run: ChatThreadRunRecord;
  assistantMessageId: string;
  snapshot: ChatRunSnapshot;
}) {
  const currentMessage = await findMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    messageId: input.assistantMessageId,
  });
  await updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.assistantMessageId,
    content: input.snapshot.assistantContent ?? "",
    metadata: {
      ...(currentMessage?.metadata ?? {}),
      userMessageId: input.run.userMessageId,
      sourceUserMessageId: input.run.userMessageId,
      toolCalls: input.snapshot.toolCalls ?? [],
      thinkingSteps: input.snapshot.thinkingSteps ?? [],
      reasoning: input.snapshot.reasoning,
      reasoningSegments: input.snapshot.reasoningSegments ?? [],
      renderBlocks: input.snapshot.renderBlocks ?? [],
      retrieval: {
        citations: input.snapshot.citations ?? [],
        availableCitations:
          input.snapshot.availableCitations ?? input.snapshot.citations ?? [],
      },
      ...buildThreadRunMetadata(input.run),
    },
  });
}

async function createDurableErrorMessage(input: {
  run: ChatThreadRunRecord;
  assistantMessageId: string | null;
  snapshot: ChatRunSnapshot;
  createErrorInput: Parameters<typeof createThreadStreamErrorMessage>[0];
}) {
  if (!input.assistantMessageId) {
    return createThreadStreamErrorMessage(input.createErrorInput);
  }

  const isClientCancelled =
    input.createErrorInput.contentError.code === "CLIENT_CANCELLED";
  const message = await updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.assistantMessageId,
    content:
      input.createErrorInput.partialAssistantContent?.trimEnd() ??
      input.createErrorInput.contentError.message,
    model: input.createErrorInput.prepared.modelAlias,
    creditsConsumed: input.createErrorInput.prepared.preflightBilling.reduce(
      (sum, item) => sum + item.consumedCredits,
      0,
    ),
    metadata: {
      isError: !isClientCancelled,
      isCancelled: isClientCancelled,
      excludeFromContext: true,
      error: input.createErrorInput.contentError.message,
      errorCode: input.createErrorInput.contentError.code,
      userMessageId: input.createErrorInput.prepared.userMessage.id,
      sourceUserMessageId: input.createErrorInput.prepared.userMessage.id,
      traceId:
        input.createErrorInput.prepared.traceContext?.traceId ??
        input.createErrorInput.prepared.userMessage.id,
      modelAlias: input.createErrorInput.prepared.modelAlias,
      profileAlias: input.createErrorInput.prepared.profileAlias,
      agentMode: input.createErrorInput.prepared.agentMode,
      versionOf: input.createErrorInput.prepared.assistantMessageParentId,
      billingSkipped: true,
      billingSkipReason: "model_error",
      preflightBilling: input.createErrorInput.prepared.preflightBilling,
      preflightCreditsConsumed:
        input.createErrorInput.prepared.preflightBilling.reduce(
          (sum, item) => sum + item.consumedCredits,
          0,
        ),
      reasoning: input.snapshot.reasoning,
      reasoningSegments: input.snapshot.reasoningSegments ?? [],
      toolCalls: input.snapshot.toolCalls ?? [],
      renderBlocks: input.snapshot.renderBlocks ?? [],
      thinkingSteps: input.snapshot.thinkingSteps ?? [],
      retrieval: {
        citations: input.snapshot.citations ?? [],
        availableCitations:
          input.snapshot.availableCitations ?? input.snapshot.citations ?? [],
      },
      ...buildThreadRunMetadata({
        ...input.run,
        status:
          input.createErrorInput.contentError.code === "CLIENT_CANCELLED"
            ? "cancelled"
            : "failed",
      }),
    },
  });

  return message;
}

export async function persistTerminalFailure(input: {
  run: ChatThreadRunRecord;
  status: Extract<TerminalRunStatus, "failed" | "cancelled">;
  assistantMessageId: string | null;
  snapshot: ChatRunSnapshot;
  contentError: ContentError;
  appendRunEvent: DurableChatRunServiceAppendRunEvent;
  finishRun: DurableChatRunServiceFinishRun;
}) {
  const errorPayload = toSseData({
    type: "error",
    code: input.contentError.code,
    error: input.contentError.message,
    ...(input.run.userMessageId ? { userMessageId: input.run.userMessageId } : {}),
    ...(input.assistantMessageId ? { messageId: input.assistantMessageId } : {}),
  });
  await input.appendRunEvent({
    run: input.run,
    payload: errorPayload,
    snapshot: input.snapshot,
  });
  await input.appendRunEvent({
    run: input.run,
    payload: toSseData({ type: "finish" }),
    snapshot: input.snapshot,
  });
  return (
    (await input.finishRun({
      run: input.run,
      status: input.status,
      assistantMessageId: input.assistantMessageId,
      snapshot: input.snapshot,
      errorCode: input.contentError.code,
      errorMessage: input.contentError.message,
    })) ?? input.run
  );
}

export async function processThreadChatRunJob(
  payload: ThreadChatRunJobPayload,
): Promise<ThreadChatRunJobResult> {
  const preparedRun = await durableChatRunService.processRunJob(payload);
  if (preparedRun && "runId" in preparedRun) {
    return preparedRun as ThreadChatRunJobResult;
  }

  const activeRun = preparedRun;
  if (!activeRun) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }

  let run: ChatThreadRunRecord = activeRun;
  const request = asRequestSnapshot(run.requestJson);
  const streamService = new ContentThreadStreamService(
    new ContentThreadTurnService(billingService),
    undefined,
    undefined,
    undefined,
    billingService,
  );
  let snapshot: ChatRunSnapshot = {};
  let assistantMessageId: string | null = run.assistantMessageId;
  let finalRun = run;
  let runBilling: MeterConsumeResponse | null = null;
  let terminalStatus: TerminalRunStatus = "completed";
  let terminalErrorCode: string | null = null;
  let terminalErrorMessage: string | null = null;
  let assistantMessagePersisted = false;
  let lastAssistantSnapshotFlushAt = 0;
  let pendingTextDeltaPayload: Record<string, unknown> | null = null;
  let pendingTextDeltaStartedAt = 0;

  const maybeFlushAssistantSnapshot = async (force = false) => {
    if (
      !assistantMessageId ||
      assistantMessagePersisted ||
      terminalStatus !== "completed" ||
      snapshot.assistantContent === undefined
    ) {
      return;
    }

    const now = Date.now();
    if (
      !force &&
      now - lastAssistantSnapshotFlushAt < ASSISTANT_SNAPSHOT_FLUSH_MS
    ) {
      return;
    }

    lastAssistantSnapshotFlushAt = now;
    await updateAssistantSnapshot({
      run,
      assistantMessageId,
      snapshot,
    });
  };

  const heartbeat = async () => {
    run = (await durableChatRunService.heartbeat(run)) ?? run;
  };

  const flushPendingTextDelta = async () => {
    if (!pendingTextDeltaPayload) {
      return;
    }

    await durableChatRunService.appendRunEvent({
      run,
      payload: serializeSsePayload(pendingTextDeltaPayload),
      snapshot,
    });
    await heartbeat();
    pendingTextDeltaPayload = null;
    pendingTextDeltaStartedAt = 0;
  };

  const appendEventWithTextDeltaCoalescing = async (
    event: string,
    payload: Record<string, unknown> | null,
  ) => {
    if (isTextDeltaPayload(payload)) {
      const now = Date.now();
      const delta = payload.delta;
      if (!pendingTextDeltaPayload) {
        pendingTextDeltaPayload = { ...payload };
        pendingTextDeltaStartedAt = now;
        return;
      }

      pendingTextDeltaPayload = {
        ...pendingTextDeltaPayload,
        delta: `${pendingTextDeltaPayload.delta ?? ""}${delta}`,
      };
      if (
        now - pendingTextDeltaStartedAt < STREAM_APPEND_TEXT_DELTA_FLUSH_MS
      ) {
        return;
      }
      await flushPendingTextDelta();
      return;
    }

    await flushPendingTextDelta();
    await durableChatRunService.appendRunEvent({
      run,
      payload: event,
      snapshot,
    });
    await heartbeat();
  };

  try {
    const stream = createThreadRunStream({
      streamService,
      request,
      options: {
        shouldCancel: () => durableChatRunService.shouldCancel(run),
        onPrepared: async (prepared) => {
          run =
            (await updateChatThreadRunProgress({
              runId: run.id,
              teamId: run.teamId,
              workspaceId: run.workspaceId,
              userMessageId: prepared.userMessage.id,
            })) ?? run;
          const placeholder = await createAssistantPlaceholder({
            run,
            prepared,
          });
          assistantMessageId = placeholder.id;
          snapshot = {
            ...snapshot,
            thread: prepared.thread,
            userMessage: prepared.userMessage,
            assistantMessage: placeholder,
          };
          run =
            (await updateChatThreadRunProgress({
              runId: run.id,
              teamId: run.teamId,
              workspaceId: run.workspaceId,
              userMessageId: prepared.userMessage.id,
              assistantMessageId: placeholder.id,
              snapshotJson: snapshot,
            })) ?? run;
          return {
            assistantMessageId: placeholder.id,
            assistantMetadata: buildThreadRunMetadata(run),
          };
        },
        createErrorMessage: async (input) => {
          const errorMessage = await createDurableErrorMessage({
            run,
            assistantMessageId,
            snapshot,
            createErrorInput: input,
          });
          if (errorMessage) {
            assistantMessageId = errorMessage.id;
            assistantMessagePersisted = true;
            snapshot = {
              ...snapshot,
              assistantMessage: errorMessage,
            };
          }
          return errorMessage;
        },
        onFinalized: async (result) => {
          runBilling = result.billing;
          snapshot = {
            ...snapshot,
            assistantMessage: result.assistantMessage,
            billing: result.billing,
            retrieval: result.retrieval,
          };
        },
      },
    });

    for await (const event of stream) {
      const payload = parseSsePayload(event);
      snapshot = updateSnapshotFromPayload(snapshot, payload);
      if (payload?.type === "error") {
        terminalErrorCode =
          typeof payload.code === "string" ? payload.code : "CHAT_RUN_FAILED";
        terminalErrorMessage =
          typeof payload.error === "string"
            ? payload.error
            : "Chat run failed";
        terminalStatus =
          terminalErrorCode === "CLIENT_CANCELLED" ? "cancelled" : "failed";
      }
      if (payload?.type === "assistant-message") {
        await maybeFlushAssistantSnapshot(true);
        assistantMessagePersisted = true;
      }
      await appendEventWithTextDeltaCoalescing(event, payload);
      await maybeFlushAssistantSnapshot(false);
    }
    await flushPendingTextDelta();
    await maybeFlushAssistantSnapshot(true);

    const thread =
      snapshot.thread ??
      (await findThreadRecord({
        threadId: run.threadId,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ??
      undefined;
    const assistantMessage = assistantMessageId
      ? await findMessageRecord({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          messageId: assistantMessageId,
        })
      : null;
    snapshot = {
      ...snapshot,
      ...(thread ? { thread } : {}),
      ...(assistantMessage ? { assistantMessage } : {}),
      ...(runBilling ? { billing: runBilling } : {}),
    };
    const finished = await durableChatRunService.finishRun({
      run,
      status: terminalStatus,
      assistantMessageId,
      snapshot: {
        ...snapshot,
        ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
        ...(terminalErrorMessage
          ? { errorMessage: terminalErrorMessage }
          : {}),
      },
      errorCode: terminalErrorCode,
      errorMessage: terminalErrorMessage,
    });
    if (!finished && terminalStatus === "completed") {
      const latest = await findChatThreadRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      });
      if (isClientCancelledRun(latest)) {
        const contentError = new ContentError(
          499,
          "CLIENT_CANCELLED",
          "Chat run was cancelled",
        );
        finalRun = await persistTerminalFailure({
          run: latest ?? run,
          status: "cancelled",
          assistantMessageId,
          snapshot: {
            ...snapshot,
            errorCode: contentError.code,
            errorMessage: contentError.message,
          },
          contentError,
          appendRunEvent: durableChatRunService.appendRunEvent.bind(
            durableChatRunService,
          ),
          finishRun: durableChatRunService.finishRun.bind(durableChatRunService),
        });
        terminalStatus = "cancelled";
        terminalErrorCode = contentError.code;
        terminalErrorMessage = contentError.message;
      } else {
        finalRun = latest ?? run;
      }
    } else {
      finalRun = finished ?? run;
    }

    if (assistantMessageId) {
      const finalMessage = await findMessageRecord({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        messageId: assistantMessageId,
      });
      await updateMessageRecord({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        messageId: assistantMessageId,
        metadata: {
          ...(finalMessage?.metadata ?? snapshot.assistantMessage?.metadata ?? {}),
          ...buildThreadRunMetadata(finalRun),
        },
      });
    }

    return {
      status: terminalStatus,
      runId: run.id,
      assistantMessageId: assistantMessageId ?? "",
      ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
      ...(terminalErrorMessage ? { errorMessage: terminalErrorMessage } : {}),
    };
  } catch (error) {
    await flushPendingTextDelta();
    await maybeFlushAssistantSnapshot(true);
    const contentError =
      error instanceof ContentError
        ? error
        : new ContentError(
            500,
            "CHAT_RUN_FAILED",
            error instanceof Error ? error.message : String(error),
          );
    const status =
      contentError.code === "CLIENT_CANCELLED" ? "cancelled" : "failed";
    snapshot = {
      ...snapshot,
      errorCode: contentError.code,
      errorMessage: contentError.message,
    };
    finalRun =
      await persistTerminalFailure({
        run,
        status,
        assistantMessageId,
        snapshot,
        contentError,
        appendRunEvent: durableChatRunService.appendRunEvent.bind(
          durableChatRunService,
        ),
        finishRun: durableChatRunService.finishRun.bind(durableChatRunService),
      });
    return {
      status,
      runId: run.id,
      assistantMessageId,
      errorCode: contentError.code,
      errorMessage: contentError.message,
    };
  }
}
