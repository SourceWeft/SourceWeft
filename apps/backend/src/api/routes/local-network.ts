import type { Hono } from "hono";
import {
  respondLocalNetworkRequestSchema,
  updateLocalDeviceNetworkModeSchema,
} from "@sourceweft/contracts";
import { resolveLocalCaller } from "../../modules/devices/access";
import {
  listPendingNetworkRequests,
  respondToNetworkRequest,
  setDeviceNetworkMode,
} from "../../modules/devices/network-approvals";
import { ownedThread } from "../../modules/devices/service";
import { requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

/**
 * Network approvals for commands running on a local computer, and the
 * per-computer mode that decides whether they are asked at all. The approval
 * routes never resume a chat run: the command is still executing and the
 * device is waiting on the answer.
 */
export function registerLocalNetworkRoutes(app: Hono) {
  app.get(
    "/v1/workspaces/:workspaceId/threads/:threadId/network-requests",
    async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSession(c);
      if (!session) throw ApiError.unauthorized();
      const thread = await ownedThread(
        session.user.id,
        c.req.param("workspaceId"),
        c.req.param("threadId"),
      );
      return ApiResponse.success(
        c,
        await listPendingNetworkRequests({
          userId: session.user.id,
          workspaceId: thread.workspaceId,
          threadId: thread.id,
        }),
      );
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/local-network-requests/:requestId/respond",
    async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSession(c);
      if (!session) throw ApiError.unauthorized();
      const parsed = respondLocalNetworkRequestSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        throw ApiError.validation(
          parsed.error.flatten() as Record<string, unknown>,
        );
      return ApiResponse.success(
        c,
        await respondToNetworkRequest({
          userId: session.user.id,
          workspaceId: c.req.param("workspaceId"),
          requestId: c.req.param("requestId"),
          decision: parsed.data.decision,
          ...(parsed.data.trust?.ttlSeconds !== undefined
            ? { ttlSeconds: parsed.data.trust.ttlSeconds }
            : {}),
        }),
      );
    },
  );

  app.patch("/v1/local-devices/:deviceId", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const parsed = updateLocalDeviceNetworkModeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    const caller = await resolveLocalCaller(
      session.user.id,
      session.session.id,
      c.req.header("X-Local-Proof"),
    );
    return ApiResponse.success(
      c,
      await setDeviceNetworkMode({
        userId: session.user.id,
        deviceId: c.req.param("deviceId"),
        caller,
        networkMode: parsed.data.networkMode,
      }),
    );
  });
}
