import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  createAgentTaskRequestSchema,
  listAgentTaskRunsRequestSchema,
  previewAgentTaskScheduleRequestSchema,
  runAgentTaskNowRequestSchema,
  updateAgentTaskRequestSchema,
} from "@sourceweft/contracts/scheduled-tasks";
import { agentTaskService } from "../../../modules/agent-tasks";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/**
 * Who is asking. The owner of every task these routes touch is the signed-in
 * person, never a value from the request; the workspace is the route's, and
 * the service only finds tasks that are stored in it.
 */
async function caller(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  return {
    workspaceId: requireRouteParam(c, "workspaceId"),
    userId: getSessionUserId(session),
  };
}

function parse<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.flatten() as Record<string, unknown>,
    );
  }
  return parsed.data;
}

const body = (c: Context) => c.req.json().catch(() => null);

export function registerAgentTaskRoutes(app: Hono) {
  app.get("/agent-tasks", async (c) =>
    ApiResponse.success(c, await agentTaskService.listTasks(await caller(c))),
  );

  app.post("/agent-tasks", async (c) => {
    const who = await caller(c);
    const input = parse(createAgentTaskRequestSchema, await body(c));
    return ApiResponse.success(
      c,
      await agentTaskService.createTask(who, input),
      201,
    );
  });

  // Registered before `/agent-tasks/:id` so "preview-schedule" is not an id.
  app.post("/agent-tasks/preview-schedule", async (c) => {
    const who = await caller(c);
    const input = parse(previewAgentTaskScheduleRequestSchema, await body(c));
    return ApiResponse.success(
      c,
      await agentTaskService.previewSchedule(who, input),
    );
  });

  app.get("/agent-tasks/:id", async (c) =>
    ApiResponse.success(
      c,
      await agentTaskService.getTask(
        await caller(c),
        requireRouteParam(c, "id"),
      ),
    ),
  );

  app.patch("/agent-tasks/:id", async (c) => {
    const who = await caller(c);
    const input = parse(updateAgentTaskRequestSchema, await body(c));
    return ApiResponse.success(
      c,
      await agentTaskService.updateTask(who, requireRouteParam(c, "id"), input),
    );
  });

  app.delete("/agent-tasks/:id", async (c) =>
    ApiResponse.success(
      c,
      await agentTaskService.deleteTask(
        await caller(c),
        requireRouteParam(c, "id"),
      ),
    ),
  );

  for (const [action, run] of [
    ["pause", agentTaskService.pauseTask.bind(agentTaskService)],
    ["resume", agentTaskService.resumeTask.bind(agentTaskService)],
    ["activate", agentTaskService.activateTask.bind(agentTaskService)],
  ] as const) {
    app.post(`/agent-tasks/:id/${action}`, async (c) =>
      ApiResponse.success(
        c,
        await run(await caller(c), requireRouteParam(c, "id")),
      ),
    );
  }

  app.post("/agent-tasks/:id/run-now", async (c) => {
    const who = await caller(c);
    const input = parse(runAgentTaskNowRequestSchema, await body(c));
    const { run, created } = await agentTaskService.runTaskNow(
      who,
      requireRouteParam(c, "id"),
      input,
    );
    return ApiResponse.success(c, { run }, created ? 201 : 200);
  });

  // Which scheduled run made this conversation; before `/agent-tasks/:id`
  // routes could ever read the word "by-thread" as an id.
  app.get("/agent-task-runs/by-thread/:threadId", async (c) =>
    ApiResponse.success(
      c,
      await agentTaskService.findRunForThread(
        await caller(c),
        requireRouteParam(c, "threadId"),
      ),
    ),
  );

  app.get("/agent-tasks/:id/runs", async (c) => {
    const who = await caller(c);
    const input = parse(listAgentTaskRunsRequestSchema, {
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    return ApiResponse.success(
      c,
      await agentTaskService.listTaskRuns(
        who,
        requireRouteParam(c, "id"),
        input,
      ),
    );
  });
}
