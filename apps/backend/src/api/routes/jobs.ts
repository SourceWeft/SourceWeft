import { Hono } from "hono";
import { mapBullMqStateToStatus } from "../../shared/job-status";
import { jobsQueue } from "../../shared/queue";
import { requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

const PUBLIC_JOB_TYPES = new Set(["example"]);

function assertJobOwnedBySession(job: { data: unknown }, userId: string) {
  const jobUserId =
    job.data && typeof job.data === "object"
      ? (job.data as Record<string, unknown>).userId
      : undefined;

  if (jobUserId !== userId) {
    throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
  }
}

export function registerJobRoutes(app: Hono) {
  app.post("/v1/jobs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const type =
      typeof body.type === "string" && body.type ? body.type : "example";
    if (!PUBLIC_JOB_TYPES.has(type)) {
      throw new ApiError(403, "JOB_TYPE_FORBIDDEN", "Job type is not public");
    }

    const payload =
      body.payload &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};

    const job = await jobsQueue.add(type, {
      ...payload,
      userId: session.user.id,
    });

    return ApiResponse.success(
      c,
      {
        id: String(job.id),
        status: "queued",
        type,
      },
      201,
    );
  });

  app.get("/v1/jobs/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const jobId = c.req.param("id");
    const job = await jobsQueue.getJob(jobId);
    if (!job) {
      throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
    }

    assertJobOwnedBySession(job, session.user.id);

    const state = await job.getState();
    const status = mapBullMqStateToStatus(state);
    const updatedAtMs = job.finishedOn ?? job.processedOn ?? job.timestamp;

    return ApiResponse.success(c, {
      id: String(job.id),
      type: job.name,
      status,
      createdAt: new Date(job.timestamp).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
    });
  });

  app.post("/v1/jobs/:id/cancel", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const cancelId = c.req.param("id");
    const job = await jobsQueue.getJob(cancelId);
    if (!job) {
      throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
    }

    assertJobOwnedBySession(job, session.user.id);

    const state = await job.getState();
    if (state === "completed" || state === "failed") {
      throw new ApiError(
        409,
        "JOB_NOT_CANCELLABLE",
        `Job cannot be cancelled from '${state}' state`,
      );
    }

    if (state === "active") {
      throw new ApiError(
        409,
        "JOB_RUNNING",
        "Running jobs cannot be cancelled safely",
      );
    }

    await job.remove();

    return ApiResponse.success(c, {
      id: String(job.id),
      removed: true,
    });
  });

  app.get("/v1/jobs/:id/events", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const eventsId = c.req.param("id");
    const job = await jobsQueue.getJob(eventsId);
    if (!job) {
      throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
    }

    assertJobOwnedBySession(job, session.user.id);

    return ApiResponse.success(c, { items: [] });
  });
}
