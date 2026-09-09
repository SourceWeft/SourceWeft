import { ContentError } from "../content/errors";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, inArray } from "drizzle-orm";
import {
  db,
  localDevices,
  localDeviceEnrollments,
  localThreadBindings,
  localToolInvocations,
  threads,
} from "@sourceweft/db";
import { ApiError } from "../../api/response/api-response";

export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const isOnline = (device: {
  heartbeatAt: Date | null;
  revokedAt: Date | null;
}) =>
  !device.revokedAt &&
  !!device.heartbeatAt &&
  Date.now() - device.heartbeatAt.getTime() < 20_000;

export async function createEnrollment(userId: string) {
  const ticket = randomBytes(32).toString("base64url");
  await db.insert(localDeviceEnrollments).values({
    tokenHash: tokenHash(ticket),
    userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { ticket };
}

export async function claimEnrollment(ticket: string, name: string) {
  return db.transaction(async (tx) => {
    const [enrollment] = await tx
      .delete(localDeviceEnrollments)
      .where(
        and(
          eq(localDeviceEnrollments.tokenHash, tokenHash(ticket)),
          gt(localDeviceEnrollments.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!enrollment)
      throw new ApiError(
        403,
        "ENROLLMENT_EXPIRED",
        "Enrollment ticket is invalid or expired.",
      );
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    await tx.insert(localDevices).values({
      id,
      userId: enrollment.userId,
      name,
      tokenHash: tokenHash(token),
    });
    return { id, userId: enrollment.userId, token };
  });
}

export async function ownedThread(
  userId: string,
  workspaceId: string,
  threadId: string,
) {
  const row = await db.query.threads.findFirst({
    where: and(
      eq(threads.id, threadId),
      eq(threads.workspaceId, workspaceId),
      eq(threads.createdBy, userId),
      eq(threads.visibility, "private"),
    ),
  });
  if (!row)
    throw new ApiError(
      404,
      "THREAD_NOT_FOUND",
      "Local execution requires your private conversation.",
    );
  return row;
}

export async function validateThreadExecutionTarget(
  userId: string,
  target?: import("@sourceweft/contracts").ThreadExecutionTarget,
) {
  if (!target || target.kind === "cloud") return;
  const device = await db.query.localDevices.findFirst({
    where: and(
      eq(localDevices.id, target.deviceId),
      eq(localDevices.userId, userId),
      isNull(localDevices.revokedAt),
    ),
  });
  if (!device)
    throw new ApiError(
      404,
      "LOCAL_DEVICE_NOT_FOUND",
      "Choose a computer owned by this account.",
    );
  // Being temporarily offline does not change a local conversation into cloud.
}

export async function localCall(input: {
  deviceId: string;
  userId: string;
  threadId: string;
  runId?: string;
  id?: string;
  action: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const device = await db.query.localDevices.findFirst({
    where: and(
      eq(localDevices.id, input.deviceId),
      eq(localDevices.userId, input.userId),
      isNull(localDevices.revokedAt),
    ),
  });
  if (!device || !isOnline(device))
    throw new ContentError(
      409,
      "DEVICE_OFFLINE",
      "The bound computer is offline. This conversation will not switch execution environments.",
    );
  const id = input.id ?? randomUUID();
  const timeout = Math.min(input.timeoutMs ?? 30_000, 180_000);
  const deadline = new Date(Date.now() + timeout);
  await db
    .insert(localToolInvocations)
    .values({
      id,
      deviceId: input.deviceId,
      userId: input.userId,
      threadId: input.threadId,
      runId: input.runId,
      action: input.action,
      payload: input.payload,
      deadline,
    })
    .onConflictDoNothing();
  const record = await db.query.localToolInvocations.findFirst({
    where: eq(localToolInvocations.id, id),
  });
  if (
    !record ||
    record.deviceId !== input.deviceId ||
    record.threadId !== input.threadId ||
    record.userId !== input.userId ||
    record.action !== input.action ||
    canonical(record.payload) !== canonical(input.payload)
  ) {
    throw new ContentError(
      409,
      "LOCAL_INVOCATION_CONFLICT",
      "Call identity cannot be reused for different parameters.",
    );
  }
  while (Date.now() < deadline.getTime() && !input.signal?.aborted) {
    const current = await db.query.localToolInvocations.findFirst({
      where: eq(localToolInvocations.id, id),
    });
    if (current?.status === "succeeded") return current.result ?? {};
    if (
      current &&
      ["failed", "cancelled", "outcome_unknown"].includes(current.status)
    )
      throw new ContentError(
        409,
        `LOCAL_EXECUTION_${current.status.toUpperCase()}`,
        current.error ?? "Local execution did not complete.",
      );
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await db
    .update(localToolInvocations)
    .set({ status: "cancel_requested" })
    .where(
      and(
        eq(localToolInvocations.id, id),
        inArray(localToolInvocations.status, [
          "pending",
          "accepted",
          "running",
        ]),
      ),
    );
  throw new ContentError(
    input.signal?.aborted ? 499 : 408,
    input.signal?.aborted ? "CLIENT_CANCELLED" : "LOCAL_EXECUTION_TIMEOUT",
    "Local cancellation requested; awaiting physical termination on the bound computer.",
  );
}
