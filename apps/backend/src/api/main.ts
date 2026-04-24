import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { auth } from "../modules/auth";
import { mapBullMqStateToStatus } from "../shared/job-status";
import { logger } from "../shared/logger";
import { closeQueue, jobsQueue } from "../shared/queue";
import { closeDatabase } from "../shared/database";
import { config } from "../shared/config";
import { ensureModelConfigBootstrapped } from "../shared/model-gateway";
import { registerAuthMetaRoutes } from "./routes/auth-meta";
import { registerBillingRoutes } from "./routes/billing";
import { registerContentRoutes } from "./routes/content";
import { healthResponse } from "./routes/health";
import { registerWorkspaceRoutes } from "./routes/workspace";
import { ApiError, ApiResponse, toApiError } from "./response/api-response";

await ensureModelConfigBootstrapped();

const app = new Hono();

type ErrorDetail = {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  status?: number;
  statusText?: string;
  url?: string;
  body?: Record<string, unknown>;
  bodyCode?: string;
  bodyMessage?: string;
  headers?: unknown;
  thrown?: unknown;
};

function describeError(error: unknown): ErrorDetail {
  const asRecord =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;

  if (asRecord) {
    const body =
      asRecord.body && typeof asRecord.body === "object"
        ? (asRecord.body as Record<string, unknown>)
        : undefined;

    const status =
      typeof asRecord.status === "number"
        ? asRecord.status
        : typeof asRecord.statusCode === "number"
          ? asRecord.statusCode
          : undefined;

    const messageFromBody =
      body && typeof body.message === "string" ? body.message : undefined;

    const codeFromBody =
      body && typeof body.code === "string" ? body.code : undefined;

    const errorStack =
      typeof asRecord.errorStack === "string" ? asRecord.errorStack : undefined;

    if (
      typeof asRecord.name === "string" &&
      (status !== undefined || body || errorStack)
    ) {
      return {
        name: asRecord.name,
        message:
          typeof asRecord.message === "string" && asRecord.message
            ? asRecord.message
            : messageFromBody || "",
        stack:
          typeof asRecord.stack === "string" && asRecord.stack
            ? asRecord.stack
            : errorStack,
        cause: asRecord.cause,
        status,
        body,
        bodyCode: codeFromBody,
        bodyMessage: messageFromBody,
        headers:
          asRecord.headers && typeof asRecord.headers === "object"
            ? asRecord.headers
            : undefined,
      };
    }
  }

  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? {
            name: error.cause.name,
            message: error.cause.message,
            stack: error.cause.stack,
          }
        : error.cause;

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause,
    };
  }

  if (
    typeof Response !== "undefined" &&
    error instanceof Response
  ) {
    return {
      name: "Response",
      message: `${error.status} ${error.statusText}`,
      status: error.status,
      statusText: error.statusText,
      url: error.url,
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
    };
  }

  return {
    name: "UnknownError",
    message: "Non-Error throw",
    thrown: error,
  };
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) {
        return "";
      }

      if (
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://")
      ) {
        return origin;
      }

      if (config.auth.trustedOrigins.length === 0) {
        return origin;
      }

      return config.auth.trustedOrigins.includes(origin) ? origin : "";
    },
    allowHeaders: ["Content-Type", "Authorization", "X-Workspace-Id"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["set-auth-token", "set-auth-jwt", "content-length"],
    credentials: true,
    maxAge: 600,
  }),
);

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  return auth.handler(c.req.raw);
});

app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
  oauthProviderAuthServerMetadata(auth)(c.req.raw),
);

app.get("/.well-known/openid-configuration", (c) =>
  oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
);

app.get("/api/v1/health", (c) => {
  return ApiResponse.success(c, healthResponse(), 200);
});

registerAuthMetaRoutes(app);
registerWorkspaceRoutes(app);
registerBillingRoutes(app);
registerContentRoutes(app);

app.post("/api/v1/jobs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const type =
    typeof body.type === "string" && body.type ? body.type : "example";
  const payload =
    body.payload &&
    typeof body.payload === "object" &&
    !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};

  const job = await jobsQueue.add(type, payload);

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

app.get("/api/v1/jobs/:id", async (c) => {
  const jobId = c.req.param("id");
  const job = await jobsQueue.getJob(jobId);
  if (!job) {
    throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
  }

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

app.post("/api/v1/jobs/:id/cancel", async (c) => {
  const cancelId = c.req.param("id");
  const job = await jobsQueue.getJob(cancelId);
  if (!job) {
    throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
  }

  return ApiResponse.success(c, {
    id: String(job.id),
    implemented: false,
    message:
      "Cancel endpoint is a skeleton placeholder and is not implemented yet",
  });
});

app.get("/api/v1/jobs/:id/events", async (c) => {
  const eventsId = c.req.param("id");
  const job = await jobsQueue.getJob(eventsId);
  if (!job) {
    throw new ApiError(404, "JOB_NOT_FOUND", "Job not found");
  }

  return ApiResponse.success(c, { items: [] });
});

app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));

app.onError((error, c) => {
  const apiError = toApiError(error);
  const errorDetail = describeError(error);
  logger.error("API request failed", {
    method: c.req.method,
    pathname: new URL(c.req.url).pathname,
    code: apiError.code,
    status: apiError.statusCode,
    errorName: errorDetail.name,
    error: errorDetail.message,
    errorStack: errorDetail.stack,
    errorCause: errorDetail.cause,
    errorResponseStatus: errorDetail.status,
    errorBody: errorDetail.body,
    errorBodyCode: errorDetail.bodyCode,
    errorBodyMessage: errorDetail.bodyMessage,
    errorHeaders: errorDetail.headers,
    errorResponseStatusText: errorDetail.statusText,
    errorResponseUrl: errorDetail.url,
    errorThrown: errorDetail.thrown,
  });
  return ApiResponse.error(c, apiError);
});

serve(
  {
    fetch: app.fetch,
    port: config.apiPort,
  },
  () => {
    logger.info("API server started", { port: config.apiPort });
  },
);

async function shutdown() {
  logger.info("API shutting down");
  await Promise.allSettled([closeQueue(), closeDatabase()]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
