import type { Context, Hono } from "hono";
import { listNotificationsRequestSchema } from "@sourceweft/contracts/notifications";
import {
  listNotifications,
  markAllRead,
  markRead,
  notificationPath,
  unreadCount,
} from "../../../modules/notifications";
import { requireContentWorkspace } from "../../../modules/workspace/guards";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/**
 * The inbox belongs to the signed-in person in the route workspace's team;
 * nothing in the request can name another person or team.
 */
async function scope(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  const userId = getSessionUserId(session);
  const workspace = await requireContentWorkspace({
    workspaceId: requireRouteParam(c, "workspaceId"),
    userId,
  });
  return { userId, teamId: workspace.organizationId };
}

export function registerNotificationRoutes(app: Hono) {
  app.get("/notifications", async (c) => {
    const who = await scope(c);
    const parsed = listNotificationsRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    let page;
    try {
      page = await listNotifications({ ...who, ...parsed.data });
    } catch (error) {
      if (error instanceof Error && error.message.includes("cursor")) {
        throw ApiError.validation({ cursor: ["Invalid cursor"] });
      }
      throw error;
    }
    return ApiResponse.success(c, {
      notifications: page.items.map((item) => ({
        ...item,
        readAt: item.readAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
        lastOccurredAt: item.lastOccurredAt.toISOString(),
        path: notificationPath(item),
      })),
      nextCursor: page.nextCursor,
    });
  });

  app.get("/notifications/unread-count", async (c) =>
    ApiResponse.success(c, { count: await unreadCount(await scope(c)) }),
  );

  // Registered before `/notifications/:id/read` so "read-all" is not an id.
  app.post("/notifications/read-all", async (c) =>
    ApiResponse.success(c, { updated: await markAllRead(await scope(c)) }),
  );

  app.post("/notifications/:id/read", async (c) => {
    const who = await scope(c);
    const found = await markRead({ ...who, id: requireRouteParam(c, "id") });
    if (!found) throw ApiError.notFound("Notification not found");
    return ApiResponse.success(c, { updated: 1 });
  });
}
