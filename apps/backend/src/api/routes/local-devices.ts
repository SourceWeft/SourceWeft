import type { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, localDevices, localThreadBindings } from "@sourceweft/db";
import { requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import {
  claimEnrollment,
  createEnrollment,
  isOnline,
  ownedThread,
} from "../../modules/devices/service";

export function registerLocalDeviceRoutes(app: Hono) {
  app.post("/v1/local-devices/enroll", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    return ApiResponse.success(c, await createEnrollment(session.user.id));
  });
  app.post("/v1/local-devices/claim", async (c) => {
    const data = z
      .object({
        ticket: z.string().min(32).max(128),
        name: z.string().trim().min(1).max(80),
      })
      .parse(await c.req.json());
    return ApiResponse.success(
      c,
      await claimEnrollment(data.ticket, data.name),
    );
  });
  app.get("/v1/local-devices", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const rows = await db
      .select()
      .from(localDevices)
      .where(
        and(
          eq(localDevices.userId, session.user.id),
          isNull(localDevices.revokedAt),
        ),
      );
    return ApiResponse.success(c, {
      devices: rows.map((row) => ({
        id: row.id,
        name: row.name,
        online: isOnline(row),
      })),
    });
  });
  app.post(
    "/v1/workspaces/:workspaceId/threads/:threadId/local-execution",
    async (c) => {
      const session = await requireSession(c);
      if (!session) throw ApiError.unauthorized();
      await ownedThread(
        session.user.id,
        c.req.param("workspaceId"),
        c.req.param("threadId"),
      );
      throw new ApiError(
        409,
        "EXECUTION_TARGET_IMMUTABLE",
        "Execution environment is fixed when the conversation is created. Create a new conversation to use another environment.",
      );
    },
  );
  app.get(
    "/v1/workspaces/:workspaceId/threads/:threadId/local-execution",
    async (c) => {
      const session = await requireSession(c);
      if (!session) throw ApiError.unauthorized();
      const thread = await ownedThread(
        session.user.id,
        c.req.param("workspaceId"),
        c.req.param("threadId"),
      );
      const binding = await db.query.localThreadBindings.findFirst({
        where: eq(localThreadBindings.threadId, c.req.param("threadId")),
      });
      if (
        thread.executionTargetJson.kind === "local" &&
        (!binding || binding.deviceId !== thread.executionTargetJson.deviceId)
      ) {
        throw new ApiError(
          409,
          "LOCAL_BINDING_INVALID",
          "The local conversation binding is unavailable; cloud execution is not allowed.",
        );
      }
      const device = binding
        ? await db.query.localDevices.findFirst({
            where: eq(localDevices.id, binding.deviceId),
          })
        : null;
      return ApiResponse.success(c, {
        executionTarget: thread.executionTargetJson,
        target: device
          ? { deviceId: device.id, name: device.name, online: isOnline(device) }
          : null,
      });
    },
  );
}
