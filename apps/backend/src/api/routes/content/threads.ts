import type { Hono } from "hono";
import {
  createThreadRequestSchema,
  listThreadMessagesRequestSchema,
  listThreadsRequestSchema,
  startThreadTurnRequestSchema,
  streamThreadRequestSchema,
  type ThreadRunSummary,
  updateThreadModelSettingsRequestSchema,
} from "@sourceweft/contracts";
import { contentService } from "../../../modules/content";
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
import { parseDurableChatRunKey } from "../../../modules/content/threads/durable/constants";
import type {
  EditThreadInput,
  RefreshThreadInput,
  StreamThreadEventInput,
} from "../../../modules/content/threads";

type DurableThreadRequestInput =
  | StreamThreadEventInput
  | RefreshThreadInput
  | EditThreadInput;

function presentThreadRunSummary(run: {
  id: string;
  idempotencyKey: string;
  status: "queued" | "running" | "cancel_requested" | string;
  mode: "send" | "refresh" | "edit";
  userMessageId: string | null;
  assistantMessageId: string | null;
}): ThreadRunSummary {
  return {
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    status:
      run.status === "running" || run.status === "cancel_requested"
        ? run.status
        : "queued",
    mode: run.mode,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
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

    const result = await contentService.listThreads({
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

    const result = await contentService.createThread({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      modelSettings: parsed.data.modelSettings,
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

    const result = await contentService.startThreadTurn({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      modelSettings: parsed.data.modelSettings,
      content,
      images,
      mentionedSourceIds: parsed.data.mentionedSourceIds,
      sourceIds: parsed.data.sourceIds,
      tools: parsed.data.tools,
      command: parsed.data.command,
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

  app.get("/threads/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getThread({
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

    const result = await contentService.deleteThread({
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

    const result = await contentService.updateThreadModelSettings({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      llmProfileAlias: parsed.data.llmProfileAlias,
      imageProfileAlias: parsed.data.imageProfileAlias,
      visionProfileAlias: parsed.data.visionProfileAlias,
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

    const result = await contentService.getCitationDetail({
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

    const result = await contentService.getMessageImageFile({
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

    const result = await contentService.listThreadMessages({
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

    const run = await contentService.findActiveDurableThreadRun({
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
      const result = await contentService.stopDurableThreadRun({
        workspaceId,
        threadId,
        userId,
        idempotencyKeyWithStopSuffix: rawIdempotencyKey,
      });

      return ApiResponse.success(c, result);
    }

    const existingDurableRun =
      durableKey?.kind === "run"
        ? await contentService.findDurableThreadRun({
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
          const result = await contentService.getDurableThreadRunResult({
            workspaceId,
            threadId,
            userId,
            idempotencyKey: durableKey.idempotencyKey,
          });
          return ApiResponse.success(c, result);
        }

        const stream = contentService.attachDurableThreadRunEvents({
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
        mode === "refresh"
          ? {
              workspaceId,
              threadId,
              userId,
              content: "",
              mentionedSourceIds: parsed.data.mentionedSourceIds,
              sourceIds: parsed.data.sourceIds,
              tools: parsed.data.tools,
              command: parsed.data.command,
              timezone: parsed.data.timezone,
              userMessageId: parsed.data.userMessageId,
              assistantMessageId: parsed.data.assistantMessageId,
              idempotencyKey: durableKey.idempotencyKey,
              llm: parsed.data.llm,
              image: parsed.data.image,
              vision: parsed.data.vision,
              visionProfileAlias:
                parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              toolApprovalResume: parsed.data.toolApprovalResume ?? null,
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
                timezone: parsed.data.timezone,
                userMessageId: parsed.data.userMessageId,
                assistantMessageId: parsed.data.assistantMessageId,
                idempotencyKey: durableKey.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                toolApprovalResume: parsed.data.toolApprovalResume ?? null,
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
                timezone: parsed.data.timezone,
                idempotencyKey: durableKey.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                toolApprovalResume: parsed.data.toolApprovalResume ?? null,
              };
      await contentService.getOrCreateDurableThreadRun({
        workspaceId,
        threadId,
        userId,
        idempotencyKey: durableKey.idempotencyKey,
        mode,
        request,
      });

      if (parsed.data.stream === false) {
        const result = await contentService.getDurableThreadRunResult({
          workspaceId,
          threadId,
          userId,
          idempotencyKey: durableKey.idempotencyKey,
        });
        return ApiResponse.success(c, result);
      }

      const stream = contentService.attachDurableThreadRunEvents({
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
        mode === "refresh"
          ? await contentService.refreshThread({
              workspaceId,
              threadId,
              userId,
              mentionedSourceIds: parsed.data.mentionedSourceIds,
              sourceIds: parsed.data.sourceIds,
              tools: parsed.data.tools,
              command: parsed.data.command,
              timezone: parsed.data.timezone,
              userMessageId: parsed.data.userMessageId,
              assistantMessageId: parsed.data.assistantMessageId,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
              image: parsed.data.image,
              vision: parsed.data.vision,
              visionProfileAlias:
                parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              toolApprovalResume: parsed.data.toolApprovalResume ?? null,
            } satisfies RefreshThreadInput)
          : mode === "edit"
            ? await contentService.editThread({
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
                timezone: parsed.data.timezone,
                userMessageId: parsed.data.userMessageId,
                assistantMessageId: parsed.data.assistantMessageId,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
                toolApprovalResume: parsed.data.toolApprovalResume ?? null,
              } satisfies EditThreadInput)
            : await contentService.streamThread({
                workspaceId,
                threadId,
                userId,
                content: parsed.data.content ?? "",
                images,
                mentionedSourceIds: parsed.data.mentionedSourceIds,
                sourceIds: parsed.data.sourceIds,
                tools: parsed.data.tools,
                command: parsed.data.command,
                timezone: parsed.data.timezone,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
                image: parsed.data.image,
                vision: parsed.data.vision,
                visionProfileAlias:
                  parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              });

      return ApiResponse.success(c, result);
    }

    const stream =
      mode === "refresh"
        ? contentService.refreshThreadEvents({
            workspaceId,
            threadId,
            userId,
            mentionedSourceIds: parsed.data.mentionedSourceIds,
            sourceIds: parsed.data.sourceIds,
            tools: parsed.data.tools,
            command: parsed.data.command,
            timezone: parsed.data.timezone,
            userMessageId: parsed.data.userMessageId,
            assistantMessageId: parsed.data.assistantMessageId,
            idempotencyKey: parsed.data.idempotencyKey,
            llm: parsed.data.llm,
            image: parsed.data.image,
            vision: parsed.data.vision,
            visionProfileAlias:
              parsed.data.modelSettings?.visionProfileAlias ?? undefined,
            toolApprovalResume: parsed.data.toolApprovalResume ?? null,
          } satisfies RefreshThreadInput)
        : mode === "edit"
          ? contentService.editThreadEvents({
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
              timezone: parsed.data.timezone,
              userMessageId: parsed.data.userMessageId,
              assistantMessageId: parsed.data.assistantMessageId,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
              image: parsed.data.image,
              vision: parsed.data.vision,
              visionProfileAlias:
                parsed.data.modelSettings?.visionProfileAlias ?? undefined,
              toolApprovalResume: parsed.data.toolApprovalResume ?? null,
            } satisfies EditThreadInput)
          : contentService.streamThreadEvents({
              workspaceId,
              threadId,
              userId,
              content: parsed.data.content ?? "",
              images,
              mentionedSourceIds: parsed.data.mentionedSourceIds,
              sourceIds: parsed.data.sourceIds,
              tools: parsed.data.tools,
              command: parsed.data.command,
              timezone: parsed.data.timezone,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
              image: parsed.data.image,
              vision: parsed.data.vision,
              visionProfileAlias:
                parsed.data.modelSettings?.visionProfileAlias ?? undefined,
            });

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");
    return c.body(createSseResponse(stream));
  });
}
