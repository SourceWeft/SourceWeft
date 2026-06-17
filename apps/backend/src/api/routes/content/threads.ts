import type { Hono } from "hono";
import {
  createThreadRequestSchema,
  listThreadMessagesRequestSchema,
  listThreadsRequestSchema,
  startThreadTurnRequestSchema,
  streamThreadRequestSchema,
  type StreamThreadRequest,
  type ThreadRunSummary,
  updateThreadChatPreferencesRequestSchema,
  updateThreadModelSettingsRequestSchema,
} from "@sourceweft/contracts";
import {
  contentThreadService,
  durableChatRunService,
  contentThreadStreamService,
  parseDurableChatRunKey,
  getRunApprovalPauseState,
} from "../../../modules/threads";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
  StreamThreadEventInput,
} from "../../../modules/threads";
import { THREAD_TITLE_GENERATE_JOB } from "../../../modules/content/queue";
import { presentJobState } from "../../../shared/job-status";
import { jobsQueue } from "../../../shared/queue";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import {
  createSseResponse,
  ensureObjectBody,
  requireRouteParam,
} from "./helpers";

type DurableThreadRequestInput =
  | StreamThreadEventInput
  | RefreshThreadInput
  | ResumeThreadInput
  | EditThreadInput;
type StreamThreadRequestData = StreamThreadRequest;
type ResumeRequestData = StreamThreadRequestData & {
  assistantMessageId: string;
  toolApprovalResume: ResumeThreadInput["toolApprovalResume"];
};

function assertResumeRequestData(
  data: StreamThreadRequestData,
): asserts data is ResumeRequestData {
  if (!data.assistantMessageId || !data.toolApprovalResume) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "resume mode requires assistantMessageId and toolApprovalResume",
    );
  }
}

function buildResumeThreadInput(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  data: StreamThreadRequestData;
  idempotencyKey?: string;
}): ResumeThreadInput {
  assertResumeRequestData(input.data);
  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    mentionedSourceIds: input.data.mentionedSourceIds,
    sourceIds: input.data.sourceIds,
    tools: input.data.tools,
    command: input.data.command,
    invocation: input.data.invocation,
    timezone: input.data.timezone,
    userMessageId: input.data.userMessageId,
    assistantMessageId: input.data.assistantMessageId,
    idempotencyKey: input.idempotencyKey ?? input.data.idempotencyKey,
    llm: input.data.llm,
    image: input.data.image,
    vision: input.data.vision,
    visionProfileAlias:
      input.data.modelSettings?.visionProfileAlias ?? undefined,
    toolApprovalResume: input.data.toolApprovalResume,
    mcpInstallIds: input.data.mcpInstallIds,
  };
}

function presentThreadRunSummary(run: {
  id: string;
  idempotencyKey: string;
  status: string;
  mode: "send" | "refresh" | "edit" | "resume";
  userMessageId: string | null;
  assistantMessageId: string | null;
  snapshotJson?: Record<string, unknown>;
}): ThreadRunSummary {
  const approval = getRunApprovalPauseState({
    snapshotJson: run.snapshotJson ?? {},
  });
  const status =
    run.status === "running" ||
    run.status === "cancel_requested" ||
    run.status === "waiting_for_approval"
      ? run.status
      : "queued";
  return {
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    status,
    mode: run.mode,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    ...(status === "waiting_for_approval"
      ? {
          approvalRequestedAt: approval.requestedAt,
          approvalExpiresAt: approval.expiresAt,
        }
      : {}),
  };
}

function assertJobStringField(data: unknown, field: string, expected: string) {
  const actual =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)[field]
      : undefined;
  if (actual !== expected) {
    throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
  }
}

export function registerThreadRoutes(app: Hono) {
  app.get("/threads", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsedQuery = listThreadsRequestSchema.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit")
        ? Number.parseInt(c.req.query("limit") as string, 10)
        : undefined,
    });
    if (!parsedQuery.success) {
      throw ApiError.validation(
        parsedQuery.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentThreadService.listThreads({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      limit: parsedQuery.data.limit,
      cursor: parsedQuery.data.cursor,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/threads", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentThreadService.createThread({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      modelSettings: parsed.data.modelSettings,
      chatPreferences: parsed.data.chatPreferences,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.post("/threads/start-turn", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = startThreadTurnRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const content = parsed.data.content?.trim() ?? "";
    const images = parsed.data.images ?? [];
    if (!content && images.length === 0) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "content or images is required",
      );
    }

    const durableKey = parseDurableChatRunKey(parsed.data.idempotencyKey ?? "");
    if (durableKey?.kind !== "run") {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "valid idempotencyKey is required",
      );
    }

    const result = await contentThreadService.startThreadTurn({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      modelSettings: parsed.data.modelSettings,
      chatPreferences: parsed.data.chatPreferences,
      content,
      images,
      mentionedSourceIds: parsed.data.mentionedSourceIds,
      sourceIds: parsed.data.sourceIds,
      tools: parsed.data.tools,
      command: parsed.data.command,
      invocation: parsed.data.invocation,
      timezone: parsed.data.timezone,
      idempotencyKey: durableKey.idempotencyKey,
      llm: parsed.data.llm,
      image: parsed.data.image,
      vision: parsed.data.vision,
      visionProfileAlias:
        parsed.data.modelSettings?.visionProfileAlias ?? undefined,
    });

    return ApiResponse.success(
      c,
      { thread: result.thread, run: presentThreadRunSummary(result.run) },
      201,
    );
  });

  app.get("/threads/chat-preferences/bootstrap", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentThreadService.getInitialChatPreferences({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/threads/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentThreadService.getThread({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.delete("/threads/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentThreadService.deleteThread({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.patch("/threads/:id/model-settings", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateThreadModelSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentThreadService.updateThreadModelSettings({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      llmProfileAlias: parsed.data.llmProfileAlias,
      imageProfileAlias: parsed.data.imageProfileAlias,
      visionProfileAlias: parsed.data.visionProfileAlias,
    });

    return ApiResponse.success(c, result);
  });

  app.patch("/threads/:id/chat-preferences", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateThreadChatPreferencesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentThreadService.updateThreadChatPreferences({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      chatPreferences: parsed.data,
    });

    return ApiResponse.success(c, result);
  });

  app.get("/messages/:messageId/citations/:rank", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const rank = Number.parseInt(c.req.param("rank"), 10);
    if (!Number.isFinite(rank) || rank <= 0) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "rank must be a positive integer",
      );
    }

    const result = await contentThreadService.getCitationDetail({
      workspaceId: requireRouteParam(c, "workspaceId"),
      messageId: requireRouteParam(c, "messageId"),
      rank,
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/messages/:messageId/images/:imageId/file", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentThreadService.getMessageImageFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      messageId: requireRouteParam(c, "messageId"),
      imageId: requireRouteParam(c, "imageId"),
      userId: getSessionUserId(session),
    });

    c.header("Content-Type", result.contentType);
    c.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    c.header("Cache-Control", "private, max-age=60");
    return c.body(result.body);
  });

  app.get("/threads/:id/messages", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentThreadService.listThreadMessages({
      ...(() => {
        const parsed = listThreadMessagesRequestSchema.safeParse({
          cursor: c.req.query("cursor"),
          include: c.req.query("include"),
          limit: c.req.query("limit"),
        });
        if (!parsed.success) {
          throw ApiError.validation(
            parsed.error.flatten() as Record<string, unknown>,
          );
        }
        return parsed.data;
      })(),
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/threads/:id/active-run", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const run = await durableChatRunService.findActiveRun({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, {
      threadRun: run ? presentThreadRunSummary(run) : null,
    });
  });

  app.get("/threads/:id/title-job/:jobId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const workspaceId = requireRouteParam(c, "workspaceId");
    const threadId = requireRouteParam(c, "id");
    const userId = getSessionUserId(session);
    const job = await jobsQueue.getJob(requireRouteParam(c, "jobId"));
    if (!job || job.name !== THREAD_TITLE_GENERATE_JOB) {
      throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
    }

    assertJobStringField(job.data, "workspaceId", workspaceId);
    assertJobStringField(job.data, "threadId", threadId);
    assertJobStringField(job.data, "userId", userId);

    return ApiResponse.success(
      c,
      presentJobState({
        id: String(job.id),
        type: job.name,
        state: await job.getState(),
        createdAtMs: job.timestamp,
        processedAtMs: job.processedOn,
        finishedAtMs: job.finishedOn,
        progress: job.progress,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
      }),
    );
  });

  app.post("/threads/:id/stream", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const workspaceId = requireRouteParam(c, "workspaceId");
    const threadId = requireRouteParam(c, "id");
    const userId = getSessionUserId(session);
    const bodyRecord = body as Record<string, unknown>;
    const rawIdempotencyKey =
      typeof bodyRecord.idempotencyKey === "string"
        ? bodyRecord.idempotencyKey.trim()
        : "";
    const durableKey = parseDurableChatRunKey(rawIdempotencyKey);
    if (durableKey?.kind === "stop") {
      const result = await durableChatRunService.stopRunAndReturn({
        workspaceId,
        threadId,
        userId,
        idempotencyKeyWithStopSuffix: rawIdempotencyKey,
      });

      return ApiResponse.success(c, result);
    }

    const existingDurableRun =
      durableKey?.kind === "run"
        ? await durableChatRunService.findRun({
            workspaceId,
            threadId,
            userId,
            idempotencyKey: durableKey.idempotencyKey,
          })
        : null;

    const parsed = streamThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const mode = parsed.data.mode ?? "send";
    const imagesProvided = Object.hasOwn(body, "images");
    const images = parsed.data.images ?? [];

    if (parsed.data.toolApprovalResume && mode !== "resume") {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "toolApprovalResume requires resume mode",
      );
    }

    if (
      !existingDurableRun &&
      (mode === "send" || mode === "edit") &&
      !parsed.data.content &&
      images.length === 0
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "content or images is required for send/edit mode",
      );
    }

    if (durableKey?.kind === "run") {
      if (existingDurableRun) {
        if (parsed.data.stream === false) {
          const result = await durableChatRunService.getRunResult({
            workspaceId,
            threadId,
            userId,
            idempotencyKey: durableKey.idempotencyKey,
          });
          return ApiResponse.success(c, result);
        }

        const stream = durableChatRunService.attachRunEvents({
          workspaceId,
          threadId,
          userId,
          idempotencyKey: durableKey.idempotencyKey,
        });
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache, no-transform");
        c.header("Connection", "keep-alive");
        c.header("X-Accel-Buffering", "no");
        return c.body(createSseResponse(stream, { cancel: "detach" }));
      }

      const request: DurableThreadRequestInput =
        mode === "resume"
          ? buildResumeThreadInput({
              workspaceId,
              threadId,
              userId,
              idempotencyKey: durableKey.idempotencyKey,
              data: parsed.data,
            })
          : mode === "refresh"
            ? {
                workspaceId,
                threadId,
                userId,
                content: "",
                mentionedSourceIds: parsed.data.mentionedSourceIds,
                sourceIds: parsed.data.sourceIds,
                tools: parsed.data.tools,
                command: parsed.data.command,
                invocation: parsed.data.invocation,
                timezone: parsed.data.timezone,
                userMessageId: parsed.data.userMessageId,
                assistantMessageId: parsed.data.assistantMessageId,
                idempotencyKey: durableKey.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              }
            : mode === "edit"
              ? {
                  workspaceId,
                  threadId,
                  userId,
                  content: parsed.data.content ?? "",
                  imagesProvided,
                  images,
                  mentionedSourceIds: parsed.data.mentionedSourceIds,
                  sourceIds: parsed.data.sourceIds,
                  tools: parsed.data.tools,
                  command: parsed.data.command,
                  invocation: parsed.data.invocation,
                  timezone: parsed.data.timezone,
                  userMessageId: parsed.data.userMessageId,
                  assistantMessageId: parsed.data.assistantMessageId,
                  idempotencyKey: durableKey.idempotencyKey,
                  llm: parsed.data.llm,
                  image: parsed.data.image,
                  vision: parsed.data.vision,
                  visionProfileAlias:
                    parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                }
              : {
                  workspaceId,
                  threadId,
                  userId,
                  content: parsed.data.content ?? "",
                  images,
                  mentionedSourceIds: parsed.data.mentionedSourceIds,
                  sourceIds: parsed.data.sourceIds,
                  tools: parsed.data.tools,
                  command: parsed.data.command,
                  invocation: parsed.data.invocation,
                  timezone: parsed.data.timezone,
                  idempotencyKey: durableKey.idempotencyKey,
                  llm: parsed.data.llm,
                  image: parsed.data.image,
                  vision: parsed.data.vision,
                  visionProfileAlias:
                    parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                };
      await durableChatRunService.getOrCreateRun({
        workspaceId,
        threadId,
        userId,
        idempotencyKey: durableKey.idempotencyKey,
        mode,
        request,
      });

      if (parsed.data.stream === false) {
        const result = await durableChatRunService.getRunResult({
          workspaceId,
          threadId,
          userId,
          idempotencyKey: durableKey.idempotencyKey,
        });
        return ApiResponse.success(c, result);
      }

      const stream = durableChatRunService.attachRunEvents({
        workspaceId,
        threadId,
        userId,
        idempotencyKey: durableKey.idempotencyKey,
      });
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");
      return c.body(createSseResponse(stream, { cancel: "detach" }));
    }

    if (parsed.data.stream === false) {
      const result =
        mode === "resume"
          ? await contentThreadStreamService.resumeThread(
              buildResumeThreadInput({
                workspaceId,
                threadId,
                userId,
                data: parsed.data,
              }),
            )
          : mode === "refresh"
            ? await contentThreadStreamService.refreshThread({
                workspaceId,
                threadId,
                userId,
                mentionedSourceIds: parsed.data.mentionedSourceIds,
                sourceIds: parsed.data.sourceIds,
                tools: parsed.data.tools,
                command: parsed.data.command,
                invocation: parsed.data.invocation,
                timezone: parsed.data.timezone,
                userMessageId: parsed.data.userMessageId,
                assistantMessageId: parsed.data.assistantMessageId,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              } satisfies RefreshThreadInput)
            : mode === "edit"
              ? await contentThreadStreamService.editThread({
                  workspaceId,
                  threadId,
                  userId,
                  content: parsed.data.content ?? "",
                  imagesProvided,
                  images,
                  mentionedSourceIds: parsed.data.mentionedSourceIds,
                  sourceIds: parsed.data.sourceIds,
                  tools: parsed.data.tools,
                  command: parsed.data.command,
                  invocation: parsed.data.invocation,
                  timezone: parsed.data.timezone,
                  userMessageId: parsed.data.userMessageId,
                  assistantMessageId: parsed.data.assistantMessageId,
                  idempotencyKey: parsed.data.idempotencyKey,
                  llm: parsed.data.llm,
                  image: parsed.data.image,
                  vision: parsed.data.vision,
                  visionProfileAlias:
                    parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                  mcpInstallIds: parsed.data.mcpInstallIds,
                } satisfies EditThreadInput)
              : await contentThreadStreamService.streamThread({
                  workspaceId,
                  threadId,
                  userId,
                  content: parsed.data.content ?? "",
                  images,
                  mentionedSourceIds: parsed.data.mentionedSourceIds,
                  sourceIds: parsed.data.sourceIds,
                  tools: parsed.data.tools,
                  command: parsed.data.command,
                  invocation: parsed.data.invocation,
                  timezone: parsed.data.timezone,
                  idempotencyKey: parsed.data.idempotencyKey,
                  llm: parsed.data.llm,
                  image: parsed.data.image,
                  vision: parsed.data.vision,
                  visionProfileAlias:
                    parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                  mcpInstallIds: parsed.data.mcpInstallIds,
                });

      return ApiResponse.success(c, result);
    }

    const stream =
      mode === "resume"
        ? contentThreadStreamService.resumeThreadEvents(
            buildResumeThreadInput({
              workspaceId,
              threadId,
              userId,
              data: parsed.data,
            }),
          )
        : mode === "refresh"
          ? contentThreadStreamService.refreshThreadEvents({
              workspaceId,
              threadId,
              userId,
              mentionedSourceIds: parsed.data.mentionedSourceIds,
              sourceIds: parsed.data.sourceIds,
              tools: parsed.data.tools,
              command: parsed.data.command,
              invocation: parsed.data.invocation,
              timezone: parsed.data.timezone,
              userMessageId: parsed.data.userMessageId,
              assistantMessageId: parsed.data.assistantMessageId,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
              image: parsed.data.image,
              vision: parsed.data.vision,
              visionProfileAlias:
                parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              mcpInstallIds: parsed.data.mcpInstallIds,
            } satisfies RefreshThreadInput)
          : mode === "edit"
            ? contentThreadStreamService.editThreadEvents({
                workspaceId,
                threadId,
                userId,
                content: parsed.data.content ?? "",
                imagesProvided,
                images,
                mentionedSourceIds: parsed.data.mentionedSourceIds,
                sourceIds: parsed.data.sourceIds,
                tools: parsed.data.tools,
                command: parsed.data.command,
                invocation: parsed.data.invocation,
                timezone: parsed.data.timezone,
                userMessageId: parsed.data.userMessageId,
                assistantMessageId: parsed.data.assistantMessageId,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                mcpInstallIds: parsed.data.mcpInstallIds,
              } satisfies EditThreadInput)
            : contentThreadStreamService.streamThreadEvents({
                workspaceId,
                threadId,
                userId,
                content: parsed.data.content ?? "",
                images,
                mentionedSourceIds: parsed.data.mentionedSourceIds,
                sourceIds: parsed.data.sourceIds,
                tools: parsed.data.tools,
                command: parsed.data.command,
                invocation: parsed.data.invocation,
                timezone: parsed.data.timezone,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                mcpInstallIds: parsed.data.mcpInstallIds,
              });

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");
    return c.body(createSseResponse(stream));
  });
}
