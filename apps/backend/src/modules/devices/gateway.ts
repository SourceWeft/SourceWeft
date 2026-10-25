import { isDeviceAccessActive } from "./access";
import { storeLocalFileReply } from "./binary-transfer";
import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  localDeviceReplySchema,
  persistLocalFailureCode,
} from "./invocation-reply";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  openLocalConnection,
  closeLocalConnection,
} from "./connection-lifecycle";
import { db, localDevices, localToolInvocations } from "@sourceweft/db";
import { tokenHash } from "./service";
import {
  deliverNetworkDecisions,
  denyFrame,
  handleNetworkAsk,
  NETWORK_REASONS,
} from "./network-approvals";
import { logger } from "../../shared/logger";

export function attachLocalDeviceGateway(server: HttpServer) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 3 * 1024 * 1024,
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/v1/local-devices/socket") {
      socket.destroy();
      return;
    }
    const token = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{40,128})$/,
    )?.[1];
    if (!token) {
      socket.destroy();
      return;
    }
    void db.query.localDevices
      .findFirst({
        where: and(
          eq(localDevices.tokenHash, tokenHash(token)),
          isNull(localDevices.revokedAt),
        ),
      })
      .then((device) => {
        if (!device) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          void serveDevice(ws, device.id, device.userId);
        });
      })
      .catch(() => socket.destroy());
  });
  return () => wss.close();
}

async function serveDevice(ws: WebSocket, deviceId: string, userId: string) {
  const connectionId = randomUUID();
  const activeConnection = and(
    eq(localDevices.id, deviceId),
    eq(localDevices.connectionId, connectionId),
    isNull(localDevices.revokedAt),
  );
  await openLocalConnection(deviceId, connectionId);
  if (ws.readyState !== WebSocket.OPEN) {
    await closeLocalConnection(deviceId, connectionId);
    return;
  }
  const delivered = new Set<string>();
  ws.send(
    JSON.stringify({ type: "connected", deviceId, userId, connectionId }),
  );
  ws.on("message", (bytes) => {
    void (async () => {
      const parsed = localDeviceReplySchema.safeParse(
        JSON.parse(bytes.toString()),
      );
      if (!parsed.success) {
        ws.close(1008, "Invalid device message");
        return;
      }
      const [live] = await db
        .update(localDevices)
        .set({ heartbeatAt: new Date() })
        .where(activeConnection)
        .returning({ id: localDevices.id });
      if (!live) {
        ws.close(1008, "Connection revoked");
        return;
      }
      const message = parsed.data;
      if (message.type === "heartbeat") {
        ws.send(JSON.stringify({ type: "heartbeat" }));
        return;
      }
      if (message.type === "network.ask") {
        // A failed lookup must not take the command's connection down with it;
        // the safe answer is no.
        const frame = await handleNetworkAsk(
          { id: deviceId, userId },
          message,
        ).catch((error: unknown) => {
          logger.warn("Local network ask failed", {
            deviceId,
            error: String(error),
          });
          return denyFrame(message.askId, NETWORK_REASONS.unavailable);
        });
        if (frame && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify(frame));
        return;
      }
      const target = and(
        eq(localToolInvocations.id, message.id),
        eq(localToolInvocations.deviceId, deviceId),
        eq(localToolInvocations.userId, userId),
      );
      if (message.type === "accepted") {
        await db
          .update(localToolInvocations)
          .set({ status: "running" })
          .where(
            and(
              target,
              inArray(localToolInvocations.status, ["pending", "accepted"]),
            ),
          );
      } else if (message.type === "result") {
        const invocation = await db.query.localToolInvocations.findFirst({
          where: target,
        });
        if (!invocation) throw new Error("Unknown device invocation reply");
        const result =
          message.ok &&
          (invocation.action === "folder.read" ||
            invocation.action === "file.read" ||
            invocation.action === "file.binary.chunk")
            ? await storeLocalFileReply(
                { userId, deviceId, invocationId: message.id },
                message.result ?? {},
              )
            : persistLocalFailureCode(message);
        await db
          .update(localToolInvocations)
          .set({
            status: message.ok
              ? "succeeded"
              : message.error?.includes("OUTCOME_UNKNOWN")
                ? "outcome_unknown"
                : message.error?.includes("CALL_CANCELLED") ||
                    message.error?.includes("CALL_EXPIRED")
                  ? "cancelled"
                  : "failed",
            result,
            error: message.error ?? null,
          })
          .where(
            and(
              target,
              inArray(localToolInvocations.status, [
                "pending",
                "accepted",
                "running",
                "cancel_requested",
              ]),
            ),
          );
      }
    })().catch((error: unknown) => {
      logger.warn("Local device reply failed", {
        deviceId,
        error: String(error),
      });
      ws.close(1011, "Device reply failed");
    });
  });
  let busy = false;
  let tick = 0;
  const timer = setInterval(() => {
    if (busy || ws.readyState !== WebSocket.OPEN) return;
    busy = true;
    void (async () => {
      const live = await db.query.localDevices.findFirst({
        where: activeConnection,
      });
      if (
        !live ||
        !live.heartbeatAt ||
        Date.now() - live.heartbeatAt.getTime() > 20_000
      ) {
        ws.close(1008, "Lease expired");
        return;
      }
      const calls = await db
        .select()
        .from(localToolInvocations)
        .where(
          and(
            eq(localToolInvocations.deviceId, deviceId),
            inArray(localToolInvocations.status, [
              "pending",
              "accepted",
              "running",
              "cancel_requested",
            ]),
          ),
        )
        .limit(30);
      for (const call of calls) {
        if (
          call.status === "cancel_requested" ||
          call.deadline.getTime() <= Date.now()
        ) {
          ws.send(JSON.stringify({ type: "cancel", id: call.id }));
          continue;
        }
        if (!(await isDeviceAccessActive(call.accessId, userId, deviceId))) {
          ws.send(JSON.stringify({ type: "cancel", id: call.id }));
          await db
            .update(localToolInvocations)
            .set({
              status: delivered.has(call.id) ? "cancel_requested" : "cancelled",
              error: "LOCAL_ACCESS_REVOKED",
            })
            .where(eq(localToolInvocations.id, call.id));
          continue;
        }
        if (delivered.has(call.id) || call.status !== "pending") continue;
        const claimed = await db
          .update(localToolInvocations)
          .set({ status: "accepted" })
          .where(
            and(
              eq(localToolInvocations.id, call.id),
              eq(localToolInvocations.status, "pending"),
              sql`exists (select 1 from ${localDevices} where ${localDevices.id} = ${deviceId} and ${localDevices.connectionId} = ${connectionId})`,
            ),
          )
          .returning({ id: localToolInvocations.id });
        if (!claimed.length || ws.readyState !== WebSocket.OPEN) continue;
        delivered.add(call.id);
        ws.send(
          JSON.stringify({
            type: "call",
            id: call.id,
            userId,
            threadId: call.threadId ?? "",
            action: call.action,
            payload: call.payload,
            deadline: call.deadline.getTime(),
          }),
        );
      }
      // Answers to `network.ask`: the user's decision, or an expiry. The
      // settle-sweep runs about once a second; delivery every tick.
      await deliverNetworkDecisions(
        deviceId,
        (frame) => {
          if (ws.readyState !== WebSocket.OPEN) return false;
          ws.send(JSON.stringify(frame));
          return true;
        },
        { sweep: tick++ % 4 === 0 },
      );
    })()
      .catch((error: unknown) =>
        logger.warn("Local device dispatch failed", {
          deviceId,
          error: String(error),
        }),
      )
      .finally(() => {
        busy = false;
      });
  }, 250);
  ws.on("close", () => {
    clearInterval(timer);
    void closeLocalConnection(deviceId, connectionId).catch((error) => {
      logger.warn("Local connection cleanup failed", {
        deviceId,
        error: String(error),
      });
    });
  });
}
