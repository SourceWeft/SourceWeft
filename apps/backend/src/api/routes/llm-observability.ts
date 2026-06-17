import { Hono, type Context } from "hono";
import {
  getLlmGeneration,
  getLlmSpan,
  getLlmTrace,
  listLlmGenerations,
  listLlmTraces,
  recordAuditAccess,
} from "../../modules/llm-observability";
import {
  presentGeneration,
  presentGenerationSummary,
  presentSpan,
  presentTrace,
  presentTraceSummary,
} from "../../modules/llm-observability/presenter";
import {
  resolveTeamObservabilityAccess,
  resolveWorkspaceObservabilityAccess,
  type LlmObservabilityAccess,
} from "../../modules/llm-observability/permissions";
import { workspaceService } from "../../modules/workspace";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

function parseDateQuery(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "INVALID_DATE", "date query parameter is invalid");
  }
  return date;
}

function parseCursor(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const [datePart, idPart] = value.split("|", 2);
  if (!idPart) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor must include both startedAt and id");
  }
  const date = parseDateQuery(datePart);
  if (!date) {
    return undefined;
  }
  return {
    startedAt: date,
    id: idPart,
  };
}

function parseStatus(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  if (!["running", "ok", "error", "cancelled"].includes(value)) {
    throw new ApiError(400, "INVALID_STATUS", "status must be one of running, ok, error, cancelled");
  }
  return value;
}

function parseLimit(value: string | undefined) {
  const limit = value ? Number(value) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiError(400, "INVALID_LIMIT", "limit must be a positive number");
  }
  return Math.min(Math.floor(limit), 200);
}

function parseBooleanQuery(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new ApiError(400, "INVALID_BOOLEAN", "boolean query parameter must be true or false");
}

function parseObservationLimit(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiError(400, "INVALID_LIMIT", "observationLimit must be a positive number");
  }
  return Math.min(limit, 500);
}

function traceDetailQuery(c: Context) {
  const summaryOnly = parseBooleanQuery(c.req.query("summaryOnly"), false);
  return {
    includePayload: summaryOnly
      ? false
      : parseBooleanQuery(c.req.query("includePayload"), true),
    observationCursor: summaryOnly
      ? undefined
      : parseCursor(c.req.query("observationCursor")),
    observationLimit: summaryOnly
      ? 0
      : parseObservationLimit(c.req.query("observationLimit")),
    summaryOnly,
  };
}

function requireParam(c: Context, name: string) {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, "VALIDATION_ERROR", `${name} route parameter is required`);
  }
  return value;
}

function commonTraceQuery(c: Context) {
  return {
    from: parseDateQuery(c.req.query("from")),
    to: parseDateQuery(c.req.query("to")),
    userId: c.req.query("userId"),
    threadId: c.req.query("threadId"),
    messageId: c.req.query("messageId"),
    feature: c.req.query("feature"),
    status: parseStatus(c.req.query("status")),
    traceId: c.req.query("traceId"),
    cursor: parseCursor(c.req.query("cursor")),
    limit: parseLimit(c.req.query("limit")),
  };
}

function generationQuery(c: Context) {
  if (c.req.query("feature")) {
    throw new ApiError(400, "UNSUPPORTED_FILTER", "feature filter is not supported for generation lists");
  }
  return {
    ...commonTraceQuery(c),
    feature: undefined,
    operation: c.req.query("operation"),
    provider: c.req.query("provider"),
    modelAlias: c.req.query("modelAlias"),
  };
}

function requireDataAccess(access: LlmObservabilityAccess) {
  if (access.metricsOnly) {
    throw ApiError.forbidden("This role can only access LLM observability metrics");
  }
}

async function auditPayloadView(input: {
  access: LlmObservabilityAccess;
  workspaceId?: string | null;
  targetType: string;
  targetId: string;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  const workspaceId = input.workspaceId ?? input.access.workspaceId;
  if (!input.access.payloadAccess || !workspaceId) {
    return;
  }

  await recordAuditAccess({
    teamId: input.access.teamId,
    workspaceId,
    actorUserId: input.access.actorUserId,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    strict: true,
    metadata: {
      role: input.access.role,
      ...(input.metadata ?? {}),
    },
  });
}

async function requireWorkspaceAccess(c: Context) {
  const session = await requireSession(c);
  if (!session) {
    throw ApiError.unauthorized();
  }

  const access = await resolveWorkspaceObservabilityAccess({
    workspaceId: requireParam(c, "workspaceId"),
    actorUserId: getSessionUserId(session),
  });
  if (!access) {
    throw ApiError.forbidden();
  }
  return access;
}

async function requireTeamAccess(c: Context) {
  const session = await requireSession(c);
  if (!session) {
    throw ApiError.unauthorized();
  }

  const access = await resolveTeamObservabilityAccess({
    teamId: requireParam(c, "teamId"),
    actorUserId: getSessionUserId(session),
  });
  if (!access) {
    throw ApiError.forbidden();
  }
  return access;
}

async function requireTeamWorkspaceScope(c: Context, access: LlmObservabilityAccess, required = true) {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    if (!required) {
      return undefined;
    }
    throw new ApiError(400, "VALIDATION_ERROR", "workspaceId query parameter is required for team observability detail");
  }

  const workspace = await workspaceService.findWorkspaceInOrganization({
    workspaceId,
    organizationId: access.teamId,
  });
  if (!workspace) {
    throw ApiError.notFound("Workspace not found");
  }
  return workspace.id;
}

function requireTraceIdQuery(c: Context) {
  const traceId = c.req.query("traceId");
  if (!traceId) {
    throw new ApiError(400, "VALIDATION_ERROR", "traceId query parameter is required for span detail");
  }
  return traceId;
}

type RouteKind = "list" | "traceDetail" | "generationDetail" | "spanDetail";
type BaseInput = { teamId: string; workspaceId?: string };

function requireScopedBase(input: BaseInput): { teamId: string; workspaceId: string } {
  if (!input.workspaceId) {
    throw new ApiError(400, "VALIDATION_ERROR", "workspaceId query parameter is required for observability detail");
  }
  return { teamId: input.teamId, workspaceId: input.workspaceId };
}

function registerRoutes(input: {
  app: Hono;
  resolveAccess: (c: Context) => Promise<LlmObservabilityAccess>;
  baseInput: (
    access: LlmObservabilityAccess,
    c: Context,
    route: RouteKind,
  ) => Promise<BaseInput> | BaseInput;
}) {
  input.app.get("/llm/traces", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const result = await listLlmTraces({
      ...await input.baseInput(access, c, "list"),
      ...commonTraceQuery(c),
    });
    return ApiResponse.success(c, {
      items: result.items.map((trace) => presentTraceSummary(trace)),
      nextCursor: result.nextCursor,
    });
  });

  input.app.get("/llm/traces/:traceId", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const base = requireScopedBase(await input.baseInput(access, c, "traceDetail"));
    const detailQuery = traceDetailQuery(c);
    const result = await getLlmTrace({
      ...base,
      observationCursor: detailQuery.observationCursor,
      observationLimit: detailQuery.observationLimit,
      traceId: requireParam(c, "traceId"),
    });
    if (!result) {
      throw ApiError.notFound("Trace not found");
    }
    if (detailQuery.includePayload) {
      await auditPayloadView({
        access,
        workspaceId: result.trace.workspaceId,
        targetType: "llm_trace",
        targetId: result.trace.id,
        action: "llm_trace.payload.viewed",
        metadata: {
          traceId: result.trace.traceId,
        },
      });
    }
    return ApiResponse.success(c, {
      trace: presentTrace(result.trace, access, {
        includePayload: detailQuery.includePayload,
      }),
      spans: result.spans.map((span) => presentSpan(span, access, {
        includePayload: detailQuery.includePayload,
      })),
      generations: result.generations.map((generation) => presentGeneration(generation, access, {
        includePayload: detailQuery.includePayload,
      })),
      nextObservationCursor: result.nextObservationCursor,
      observationsTruncated: result.observationsTruncated,
    });
  });

  input.app.get("/llm/generations", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const result = await listLlmGenerations({
      ...await input.baseInput(access, c, "list"),
      ...generationQuery(c),
    });
    return ApiResponse.success(c, {
      items: result.items.map(presentGenerationSummary),
      nextCursor: result.nextCursor,
    });
  });

  input.app.get("/llm/generations/:generationId", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const base = requireScopedBase(await input.baseInput(access, c, "generationDetail"));
    const generation = await getLlmGeneration({
      ...base,
      generationId: requireParam(c, "generationId"),
    });
    if (!generation) {
      throw ApiError.notFound("Generation not found");
    }
    await auditPayloadView({
      access,
      workspaceId: generation.workspaceId,
      targetType: "llm_generation",
      targetId: generation.id,
      action: "llm_generation.payload.viewed",
    });
    return ApiResponse.success(c, presentGeneration(generation, access));
  });

  input.app.get("/llm/spans/:spanId", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const base = requireScopedBase(await input.baseInput(access, c, "spanDetail"));
    const span = await getLlmSpan({
      ...base,
      traceId: requireTraceIdQuery(c),
      spanId: requireParam(c, "spanId"),
    });
    if (!span) {
      throw ApiError.notFound("Span not found");
    }
    await auditPayloadView({
      access,
      workspaceId: span.workspaceId,
      targetType: "llm_span",
      targetId: span.id,
      action: "llm_span.payload.viewed",
      metadata: {
        traceId: span.traceId,
        spanId: span.spanId,
      },
    });
    return ApiResponse.success(c, presentSpan(span, access));
  });
}

export function registerWorkspaceLlmObservabilityRoutes(app: Hono) {
  registerRoutes({
    app,
    resolveAccess: requireWorkspaceAccess,
    baseInput: (access) => ({
      teamId: access.teamId,
      workspaceId: access.workspaceId,
    }),
  });
}

export function registerTeamLlmObservabilityRoutes(app: Hono) {
  const routes = new Hono();
  registerRoutes({
    app: routes,
    resolveAccess: requireTeamAccess,
    baseInput: async (access, c, route) => ({
      teamId: access.teamId,
      workspaceId: route === "traceDetail" || route === "generationDetail" || route === "spanDetail"
        ? await requireTeamWorkspaceScope(c, access)
        : await requireTeamWorkspaceScope(c, access, false),
    }),
  });
  app.route("/v1/teams/:teamId", routes);
}
