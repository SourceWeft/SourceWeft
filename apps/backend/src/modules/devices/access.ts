import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, inArray, sql } from "drizzle-orm";
import {
  db,
  localDevices,
  localDeviceAccess,
  localDeviceEnrollments,
  localToolInvocations,
  localCreationContexts,
} from "@sourceweft/db";
import { ApiError } from "../../api/response/api-response";
import { tokenHash } from "./service";

export type LocalExecutionCaller = {
  sessionId: string;
  nativeAccessId?: string;
};

export async function resolveLocalCaller(
  userId: string,
  sessionId: string,
  proof?: string,
): Promise<LocalExecutionCaller> {
  if (!proof) return { sessionId };
  const row = await db.query.localDeviceAccess.findFirst({
    where: and(
      eq(localDeviceAccess.userId, userId),
      eq(localDeviceAccess.sessionId, sessionId),
      eq(localDeviceAccess.native, true),
      eq(localDeviceAccess.tokenHash, tokenHash(proof)),
      isNull(localDeviceAccess.revokedAt),
      gt(localDeviceAccess.expiresAt, new Date()),
    ),
  });
  if (!row)
    throw new ApiError(
      403,
      "NATIVE_PROOF_EXPIRED",
      "本机身份已失效，请重新连接本机。",
    );
  return { sessionId, nativeAccessId: row.id };
}

export async function requireDeviceAccess(
  userId: string,
  deviceId: string,
  caller?: LocalExecutionCaller,
) {
  const device = await db.query.localDevices.findFirst({
    where: and(
      eq(localDevices.id, deviceId),
      eq(localDevices.userId, userId),
      isNull(localDevices.revokedAt),
    ),
  });
  if (!device)
    throw new ApiError(
      404,
      "LOCAL_DEVICE_NOT_FOUND",
      "未找到属于此账号的电脑。",
    );
  if (!caller)
    throw new ApiError(403, "LOCAL_CONNECTION_REQUIRED", "请先连接这台电脑。");
  const native = caller.nativeAccessId
    ? await db.query.localDeviceAccess.findFirst({
        where: and(
          eq(localDeviceAccess.id, caller.nativeAccessId),
          eq(localDeviceAccess.sessionId, caller.sessionId),
          eq(localDeviceAccess.userId, userId),
          eq(localDeviceAccess.deviceId, deviceId),
          eq(localDeviceAccess.native, true),
          isNull(localDeviceAccess.revokedAt),
          gt(localDeviceAccess.expiresAt, new Date()),
        ),
      })
    : null;
  if (native) return native;
  if (!device.remoteEnabled)
    throw new ApiError(
      403,
      "REMOTE_ACCESS_DISABLED",
      "请在目标 PC 开启允许其他设备连接。",
    );
  const remote = await db.query.localDeviceAccess.findFirst({
    where: and(
      eq(localDeviceAccess.sessionId, caller.sessionId),
      eq(localDeviceAccess.userId, userId),
      eq(localDeviceAccess.deviceId, deviceId),
      eq(localDeviceAccess.native, false),
      eq(localDeviceAccess.policyRevision, device.policyRevision),
      isNull(localDeviceAccess.revokedAt),
      gt(localDeviceAccess.expiresAt, new Date()),
    ),
  });
  if (!remote)
    throw new ApiError(403, "LOCAL_CONNECTION_REQUIRED", "请先连接这台电脑。");
  return remote;
}

/** Checked again at dispatch, including jobs accepted before a policy change. */
export async function isDeviceAccessActive(
  accessId: string | null,
  userId: string,
  deviceId: string,
) {
  if (!accessId) return false;
  const row = await db.query.localDeviceAccess.findFirst({
    where: and(
      eq(localDeviceAccess.id, accessId),
      eq(localDeviceAccess.userId, userId),
      eq(localDeviceAccess.deviceId, deviceId),
      isNull(localDeviceAccess.revokedAt),
      gt(localDeviceAccess.expiresAt, new Date()),
    ),
  });
  if (!row) return false;
  const device = await db.query.localDevices.findFirst({
    where: and(
      eq(localDevices.id, deviceId),
      eq(localDevices.userId, userId),
      isNull(localDevices.revokedAt),
    ),
  });
  return (
    !!device &&
    (row.native ||
      (device.remoteEnabled && row.policyRevision === device.policyRevision))
  );
}

/** The host must prove possession of its credential AND consume the user's session ticket. */
export async function createNativeAccess(
  ticket: string,
  credential: string,
  workspaceBase: string,
) {
  return db.transaction(async (tx) => {
    const device = await tx.query.localDevices.findFirst({
      where: and(
        eq(localDevices.tokenHash, tokenHash(credential)),
        isNull(localDevices.revokedAt),
      ),
    });
    if (!device)
      throw new ApiError(403, "DEVICE_CREDENTIAL_INVALID", "本机凭据不可用。");
    const [enrollment] = await tx
      .delete(localDeviceEnrollments)
      .where(
        and(
          eq(localDeviceEnrollments.tokenHash, tokenHash(ticket)),
          eq(localDeviceEnrollments.userId, device.userId),
          gt(localDeviceEnrollments.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!enrollment?.sessionId)
      throw new ApiError(
        403,
        "NATIVE_SESSION_MISMATCH",
        "本机与登录账号不一致或验证已过期。",
      );
    await tx
      .update(localDevices)
      .set({ workspaceBase })
      .where(eq(localDevices.id, device.id));
    const proof = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await tx.insert(localDeviceAccess).values({
      id: randomUUID(),
      userId: device.userId,
      sessionId: enrollment.sessionId,
      deviceId: device.id,
      native: true,
      tokenHash: tokenHash(proof),
      policyRevision: device.policyRevision,
      expiresAt,
    });
    return {
      deviceId: device.id,
      proof,
      expiresAt: expiresAt.toISOString(),
      remoteEnabled: device.remoteEnabled,
    };
  });
}

export async function connectRemote(
  userId: string,
  sessionId: string,
  deviceId: string,
) {
  const device = await db.query.localDevices.findFirst({
    where: and(
      eq(localDevices.id, deviceId),
      eq(localDevices.userId, userId),
      isNull(localDevices.revokedAt),
    ),
  });
  if (!device?.remoteEnabled)
    throw new ApiError(
      403,
      "REMOTE_ACCESS_DISABLED",
      "请在目标 PC 开启允许其他设备连接。",
    );
  const id = randomUUID();
  await db.insert(localDeviceAccess).values({
    id,
    userId,
    sessionId,
    deviceId,
    native: false,
    policyRevision: device.policyRevision,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return { connected: true };
}

export async function setRemotePolicy(
  userId: string,
  deviceId: string,
  caller: LocalExecutionCaller,
  enabled: boolean,
) {
  const access = await requireDeviceAccess(userId, deviceId, caller);
  if (!access.native)
    throw new ApiError(
      403,
      "LOCAL_SETTINGS_ONLY",
      "此设置只能在目标 PC 上修改。",
    );
  const [device] = await db
    .update(localDevices)
    .set({
      remoteEnabled: enabled,
      policyRevision: sql`${localDevices.policyRevision}+1`,
    })
    .where(eq(localDevices.id, deviceId))
    .returning();
  await db
    .update(localDeviceAccess)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(localDeviceAccess.deviceId, deviceId),
        eq(localDeviceAccess.native, false),
        isNull(localDeviceAccess.revokedAt),
      ),
    );
  const grants = await db
    .select({ id: localDeviceAccess.id })
    .from(localDeviceAccess)
    .where(
      and(
        eq(localDeviceAccess.deviceId, deviceId),
        eq(localDeviceAccess.native, false),
      ),
    );
  if (grants.length)
    await db
      .update(localToolInvocations)
      .set({ status: "cancel_requested", error: "REMOTE_ACCESS_REVOKED" })
      .where(
        and(
          inArray(
            localToolInvocations.accessId,
            grants.map((g) => g.id),
          ),
          inArray(localToolInvocations.status, [
            "pending",
            "accepted",
            "running",
          ]),
        ),
      );
  return { remoteEnabled: device!.remoteEnabled };
}

export async function revokeSessionDeviceAccess(sessionId: string) {
  const grants = await db
    .update(localDeviceAccess)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(localDeviceAccess.sessionId, sessionId),
        isNull(localDeviceAccess.revokedAt),
      ),
    )
    .returning();
  const nativeDevices = [
    ...new Set(
      grants.filter((grant) => grant.native).map((grant) => grant.deviceId),
    ),
  ];
  if (nativeDevices.length) {
    await db
      .update(localDevices)
      .set({
        remoteEnabled: false,
        policyRevision: sql`${localDevices.policyRevision}+1`,
      })
      .where(inArray(localDevices.id, nativeDevices));
    const revoked = await db
      .update(localDeviceAccess)
      .set({ revokedAt: new Date() })
      .where(
        and(
          inArray(localDeviceAccess.deviceId, nativeDevices),
          isNull(localDeviceAccess.revokedAt),
        ),
      )
      .returning();
    grants.push(...revoked);
  }
  if (grants.length)
    await db
      .update(localToolInvocations)
      .set({ status: "cancel_requested", error: "SESSION_REVOKED" })
      .where(
        and(
          inArray(
            localToolInvocations.accessId,
            grants.map((g) => g.id),
          ),
          inArray(localToolInvocations.status, [
            "pending",
            "accepted",
            "running",
          ]),
        ),
      );
}

export async function resolveCreationContext(
  userId: string,
  caller: LocalExecutionCaller,
  id: string | undefined,
  legacyTarget?: import("@sourceweft/contracts").ThreadExecutionTarget,
) {
  if (!id) {
    if (legacyTarget?.kind === "local")
      throw new ApiError(
        409,
        "CREATION_CONTEXT_REQUIRED",
        "请使用新的电脑选择入口创建对话。",
      );
    return legacyTarget ?? { kind: "cloud" as const };
  }
  const context = await db.query.localCreationContexts.findFirst({
    where: and(
      eq(localCreationContexts.id, id),
      eq(localCreationContexts.userId, userId),
      eq(localCreationContexts.sessionId, caller.sessionId),
      gt(localCreationContexts.expiresAt, new Date()),
    ),
  });
  if (!context)
    throw new ApiError(
      409,
      "CREATION_CONTEXT_EXPIRED",
      "新建上下文已过期，请重新发送。",
    );
  if (legacyTarget && targetKey(context.target) !== targetKey(legacyTarget))
    throw new ApiError(409, "CREATION_CONTEXT_MISMATCH", "新建目标不一致。");
  if (context.target.kind === "local")
    await requireDeviceAccess(userId, context.target.deviceId, caller);
  return context.target;
}

export function targetKey(
  target: import("@sourceweft/contracts").ThreadExecutionTarget,
) {
  return target.kind === "cloud"
    ? "cloud"
    : `local:${target.deviceId}:${target.folderId ?? ""}`;
}

export async function revokeFolderAccess(
  userId: string,
  deviceId: string,
  folderId: string,
  caller: LocalExecutionCaller,
) {
  const native = await requireDeviceAccess(userId, deviceId, caller);
  if (!native.native)
    throw new ApiError(
      403,
      "LOCAL_SETTINGS_ONLY",
      "文件夹授权只能在目标 PC 修改。",
    );
  const { localFolderGrants, localThreadBindings } =
    await import("@sourceweft/db");
  const [folder] = await db
    .update(localFolderGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(localFolderGrants.id, folderId),
        eq(localFolderGrants.deviceId, deviceId),
        eq(localFolderGrants.userId, userId),
      ),
    )
    .returning();
  if (!folder)
    throw new ApiError(404, "LOCAL_FOLDER_NOT_FOUND", "工作文件夹不存在。");
  const bindings = await db
    .select({ threadId: localThreadBindings.threadId })
    .from(localThreadBindings)
    .where(
      and(
        eq(localThreadBindings.folderId, folderId),
        eq(localThreadBindings.deviceId, deviceId),
      ),
    );
  if (bindings.length)
    await db
      .update(localToolInvocations)
      .set({ status: "cancel_requested", error: "LOCAL_FOLDER_REVOKED" })
      .where(
        and(
          inArray(
            localToolInvocations.threadId,
            bindings.map((b) => b.threadId),
          ),
          inArray(localToolInvocations.status, [
            "pending",
            "accepted",
            "running",
          ]),
        ),
      );
  return { revoked: true };
}
