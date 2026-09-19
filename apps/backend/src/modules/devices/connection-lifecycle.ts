import { and, eq, inArray } from "drizzle-orm";
import { db, localDevices, localToolInvocations } from "@sourceweft/db";

async function settleLostCalls(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  deviceId: string,
) {
  await tx
    .update(localToolInvocations)
    .set({
      status: "cancelled",
      error: "DEVICE_OFFLINE: The operation was not dispatched.",
    })
    .where(
      and(
        eq(localToolInvocations.deviceId, deviceId),
        eq(localToolInvocations.status, "pending"),
      ),
    );
  await tx
    .update(localToolInvocations)
    .set({
      status: "outcome_unknown",
      error:
        "DEVICE_OFFLINE: Execution result is unknown. Check the computer before retrying.",
    })
    .where(
      and(
        eq(localToolInvocations.deviceId, deviceId),
        inArray(localToolInvocations.status, [
          "accepted",
          "running",
          "cancel_requested",
        ]),
      ),
    );
}

export async function openLocalConnection(
  deviceId: string,
  connectionId: string,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(localDevices)
      .set({ connectionId, heartbeatAt: new Date() })
      .where(eq(localDevices.id, deviceId));
    // Locking the device first serializes replacement against close. Never replay
    // operations left by an earlier connection, even after a backend restart.
    await settleLostCalls(tx, deviceId);
  });
}

export async function closeLocalConnection(
  deviceId: string,
  connectionId: string,
) {
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(localDevices)
      .set({ connectionId: null, heartbeatAt: null })
      .where(
        and(
          eq(localDevices.id, deviceId),
          eq(localDevices.connectionId, connectionId),
        ),
      )
      .returning({ id: localDevices.id });
    if (closed.length) await settleLostCalls(tx, deviceId);
  });
}
