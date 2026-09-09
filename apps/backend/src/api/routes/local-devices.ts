import { contentThreadService } from "../../modules/threads/service";
import { randomUUID } from "node:crypto";
import { threadExecutionTargetSchema } from "@sourceweft/contracts";
import {
  connectRemote,
  revokeFolderAccess,
  createNativeAccess,
  resolveLocalCaller,
  setRemotePolicy,
  requireDeviceAccess,
} from "../../modules/devices/access";
import type { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  localDevices,
  localThreadBindings,
  localFolderGrants,
  localCreationContexts,
} from "@sourceweft/db";
import { requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import {
  claimEnrollment,
  createEnrollment,
  isOnline,
  tokenHash,
  validateThreadExecutionTarget,
  ownedThread,
} from "../../modules/devices/service";

export function registerLocalDeviceRoutes(app: Hono) {
  app.post("/v1/local-devices/creation-context", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const data = z
      .object({ target: threadExecutionTargetSchema })
      .strict()
      .parse(await c.req.json());
    const caller = await resolveLocalCaller(
      session.user.id,
      session.session.id,
      c.req.header("X-Local-Proof"),
    );
    if (data.target.kind === "local")
      await requireDeviceAccess(session.user.id, data.target.deviceId, caller);
    await validateThreadExecutionTarget(session.user.id, data.target);
    const id = randomUUID();
    await db.insert(localCreationContexts).values({
      id,
      userId: session.user.id,
      sessionId: session.session.id,
      target: data.target,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    return ApiResponse.success(c, { id, target: data.target });
  });
  app.post("/v1/local-devices/enroll", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    return ApiResponse.success(
      c,
      await createEnrollment(session.user.id, session.session.id),
    );
  });
  app.post("/v1/local-devices/native-session", async (c) => {
    const data = z
      .object({
        ticket: z.string().min(32),
        workspaceBase: z.string().startsWith("/").max(4096),
      })
      .parse(await c.req.json());
    const credential = c.req
      .header("Authorization")
      ?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
    if (!credential) throw ApiError.unauthorized();
    return ApiResponse.success(
      c,
      await createNativeAccess(data.ticket, credential, data.workspaceBase),
    );
  });
  app.post("/v1/local-devices/:deviceId/connect", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    return ApiResponse.success(
      c,
      await connectRemote(
        session.user.id,
        session.session.id,
        c.req.param("deviceId"),
      ),
    );
  });
  app.post("/v1/local-devices/:deviceId/policy", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const caller = await resolveLocalCaller(
      session.user.id,
      session.session.id,
      c.req.header("X-Local-Proof"),
    );
    const data = z
      .object({ remoteEnabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    return ApiResponse.success(
      c,
      await setRemotePolicy(
        session.user.id,
        c.req.param("deviceId"),
        caller,
        data.remoteEnabled,
      ),
    );
  });
  app.get("/v1/local-devices/:deviceId/folders", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const caller = await resolveLocalCaller(
      session.user.id,
      session.session.id,
      c.req.header("X-Local-Proof"),
    );
    await requireDeviceAccess(session.user.id, c.req.param("deviceId"), caller);
    const folders = await db
      .select({ id: localFolderGrants.id, name: localFolderGrants.name })
      .from(localFolderGrants)
      .where(
        and(
          eq(localFolderGrants.deviceId, c.req.param("deviceId")),
          eq(localFolderGrants.userId, session.user.id),
          isNull(localFolderGrants.revokedAt),
        ),
      );
    return ApiResponse.success(c, { folders });
  });
  app.post(
    "/v1/local-devices/:deviceId/folders/:folderId/revoke",
    async (c) => {
      const session = await requireSession(c);
      if (!session) throw ApiError.unauthorized();
      const caller = await resolveLocalCaller(
        session.user.id,
        session.session.id,
        c.req.header("X-Local-Proof"),
      );
      return ApiResponse.success(
        c,
        await revokeFolderAccess(
          session.user.id,
          c.req.param("deviceId"),
          c.req.param("folderId"),
          caller,
        ),
      );
    },
  );
  app.post("/v1/local-devices/folders/register", async (c) => {
    const credential = c.req
      .header("Authorization")
      ?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
    if (!credential) throw ApiError.unauthorized();
    const device = await db.query.localDevices.findFirst({
      where: and(
        eq(localDevices.tokenHash, tokenHash(credential)),
        isNull(localDevices.revokedAt),
      ),
    });
    if (!device) throw ApiError.unauthorized();
    const data = z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(256),
        path: z.string().startsWith("/").max(4096),
      })
      .strict()
      .parse(await c.req.json());
    await db
      .insert(localFolderGrants)
      .values({ ...data, deviceId: device.id, userId: device.userId });
    return ApiResponse.success(c, { id: data.id, name: data.name });
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
    const caller = await resolveLocalCaller(
      session.user.id,
      session.session.id,
      c.req.header("X-Local-Proof"),
    );
    return ApiResponse.success(c, {
      devices: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          online: isOnline(row),
          remoteEnabled: row.remoteEnabled,
          connected: await requireDeviceAccess(
            session.user.id,
            row.id,
            caller,
          ).then(
            () => true,
            () => false,
          ),
        })),
      ),
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
      const visible = await contentThreadService.getThread({
        userId: session.user.id,
        workspaceId: c.req.param("workspaceId"),
        threadId: c.req.param("threadId"),
      });
      const thread = {
        executionTargetJson: visible.thread.executionTarget ?? {
          kind: "cloud" as const,
        },
      };
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
        workspace: binding?.localWorkspaceId
          ? { id: binding.localWorkspaceId, path: binding.workspacePath }
          : null,
        target: device
          ? { deviceId: device.id, name: device.name, online: isOnline(device) }
          : null,
      });
    },
  );
}
