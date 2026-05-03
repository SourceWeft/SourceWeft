import { Hono, type Context } from "hono";
import {
  getLlmGeneration,
  getLlmSpan,
  getLlmTrace,
  listLlmGenerations,
  listLlmTraces,
  recordAuditAccess,
} from "../../shared/llm-observability";
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

function parseLimit(value: string | undefined) {
  const limit = value ? Number(value) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiError(400, "INVALID_LIMIT", "limit must be a positive number");
  }
  return Math.min(Math.floor(limit), 200);
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
    status: c.req.query("status"),
    cursor: parseDateQuery(c.req.query("cursor")),
    limit: parseLimit(c.req.query("limit")),
  };
}

function generationQuery(c: Context) {
  return {
    ...commonTraceQuery(c),
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
  targetType: string;
  targetId: string;
  action: string;
}) {
  if (!input.access.payloadAccess || !input.access.workspaceId) {
    return;
  }

  await recordAuditAccess({
    teamId: input.access.teamId,
    workspaceId: input.access.workspaceId,
    actorUserId: input.access.actorUserId,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    metadata: {
      role: input.access.role,
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

function registerRoutes(input: {
  app: Hono;
  resolveAccess: (c: Context) => Promise<LlmObservabilityAccess>;
  baseInput: (access: LlmObservabilityAccess) => { teamId: string; workspaceId?: string };
}) {
  input.app.get("/llm/traces", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const result = await listLlmTraces({
      ...input.baseInput(access),
      ...commonTraceQuery(c),
    });
    return ApiResponse.success(c, {
      items: result.items.map(presentTraceSummary),
      nextCursor: result.nextCursor,
    });
  });

  input.app.get("/llm/traces/:traceId", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const result = await getLlmTrace({
      ...input.baseInput(access),
      traceId: requireParam(c, "traceId"),
    });
    if (!result) {
      throw ApiError.notFound("Trace not found");
    }
    await auditPayloadView({
      access,
      targetType: "llm_trace",
      targetId: result.trace.traceId,
      action: "llm_trace.payload.viewed",
    });
    return ApiResponse.success(c, {
      trace: presentTrace(result.trace, access),
      spans: result.spans.map((span) => presentSpan(span, access)),
      generations: result.generations.map((generation) => presentGeneration(generation, access)),
    });
  });

  input.app.get("/llm/generations", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const result = await listLlmGenerations({
      ...input.baseInput(access),
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
    const generation = await getLlmGeneration({
      ...input.baseInput(access),
      generationId: requireParam(c, "generationId"),
    });
    if (!generation) {
      throw ApiError.notFound("Generation not found");
    }
    await auditPayloadView({
      access,
      targetType: "llm_generation",
      targetId: generation.id,
      action: "llm_generation.payload.viewed",
    });
    return ApiResponse.success(c, presentGeneration(generation, access));
  });

  input.app.get("/llm/spans/:spanId", async (c) => {
    const access = await input.resolveAccess(c);
    requireDataAccess(access);
    const span = await getLlmSpan({
      ...input.baseInput(access),
      spanId: requireParam(c, "spanId"),
    });
    if (!span) {
      throw ApiError.notFound("Span not found");
    }
    await auditPayloadView({
      access,
      targetType: "llm_span",
      targetId: span.spanId,
      action: "llm_span.payload.viewed",
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
    baseInput: (access) => ({
      teamId: access.teamId,
    }),
  });
  app.route("/v1/teams/:teamId", routes);
}
