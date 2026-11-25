import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  assistantDecisionActionSchema,
  postAssistantMessageRequestSchema,
  ticketActionRequestSchema,
  ticketStageSchema,
  updateAssistantRequestSchema,
} from "@sourceweft/contracts/assistants";
import { assistantService } from "../../../modules/assistants";
import { requireContentWorkspace } from "../../../modules/workspace/guards";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/**
 * Who is asking, and in which workspace. The workspace is always the
 * route's own; nothing in the request body or query can name another one.
 * `requireContentWorkspace` rejects a non-member with a 404 before the
 * service (which repeats its own membership check) is ever called.
 */
async function caller(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  const userId = getSessionUserId(session);
  const workspaceId = requireRouteParam(c, "workspaceId");
  await requireContentWorkspace({ workspaceId, userId });
  return { workspaceId, userId };
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

const listFeedQuerySchema = z.object({
  before: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const listDecisionsQuerySchema = z.object({
  before: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  action: assistantDecisionActionSchema.optional(),
});

const listTicketsQuerySchema = z.object({
  stage: ticketStageSchema.optional(),
});

export function registerAssistantRoutes(app: Hono) {
  app.get("/assistant", async (c) =>
    ApiResponse.success(c, await assistantService.get(await caller(c))),
  );

  app.post("/assistant", async (c) =>
    ApiResponse.success(
      c,
      { assistant: await assistantService.enable(await caller(c)) },
      201,
    ),
  );

  app.patch("/assistant", async (c) => {
    const who = await caller(c);
    const input = parse(updateAssistantRequestSchema, await body(c));
    return ApiResponse.success(c, await assistantService.update(who, input));
  });

  app.get("/assistant/feed", async (c) => {
    const who = await caller(c);
    const input = parse(listFeedQuerySchema, {
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    return ApiResponse.success(c, await assistantService.listFeed(who, input));
  });

  app.get("/assistant/decisions", async (c) => {
    const who = await caller(c);
    const input = parse(listDecisionsQuerySchema, {
      before: c.req.query("before"),
      limit: c.req.query("limit"),
      action: c.req.query("action"),
    });
    return ApiResponse.success(
      c,
      await assistantService.listDecisions(who, input),
    );
  });

  app.post("/assistant/messages", async (c) => {
    const who = await caller(c);
    const input = parse(postAssistantMessageRequestSchema, await body(c));
    const { item, created } = await assistantService.postMessage(who, input);
    return ApiResponse.success(c, { item }, created ? 201 : 200);
  });

  app.get("/assistant/tickets", async (c) => {
    const who = await caller(c);
    const input = parse(listTicketsQuerySchema, {
      stage: c.req.query("stage"),
    });
    return ApiResponse.success(
      c,
      await assistantService.listTickets(who, input),
    );
  });

  app.post("/assistant/tickets/:ticketId/close", async (c) => {
    const who = await caller(c);
    const ticketId = requireRouteParam(c, "ticketId");
    const input = parse(ticketActionRequestSchema, await body(c));
    return ApiResponse.success(
      c,
      await assistantService.closeTicket(who, ticketId, input),
    );
  });

  app.post("/assistant/tickets/:ticketId/retry", async (c) => {
    const who = await caller(c);
    const ticketId = requireRouteParam(c, "ticketId");
    const input = parse(ticketActionRequestSchema, await body(c));
    const { ticket, created } = await assistantService.retryTicket(
      who,
      ticketId,
      input,
    );
    return ApiResponse.success(c, { ticket }, created ? 201 : 200);
  });
}
