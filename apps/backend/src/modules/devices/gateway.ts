import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, localDevices, localToolInvocations } from "@sourceweft/db";
import { tokenHash } from "./service";
import { logger } from "../../shared/logger";

const replySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("accepted"), id: z.string().max(256) }),
  z.object({
    type: z.literal("result"),
    id: z.string().max(256),
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(4000).optional(),
  }),
]);

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
  await db
    .update(localDevices)
    .set({ connectionId, heartbeatAt: new Date() })
    .where(eq(localDevices.id, deviceId));
  const delivered = new Set<string>();
  ws.send(
    JSON.stringify({ type: "connected", deviceId, userId, connectionId }),
  );
  ws.on("message", (bytes) => {
    void (async () => {
      const parsed = replySchema.safeParse(JSON.parse(bytes.toString()));
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
      } else {
        await db
          .update(localToolInvocations)
          .set({
            status: message.ok ? "succeeded" : "failed",
            result: message.result ?? null,
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
        if (delivered.has(call.id)) continue;
        delivered.add(call.id);
        ws.send(
          JSON.stringify({
            type: "call",
            id: call.id,
            userId,
            threadId: call.threadId,
            action: call.action,
            payload: call.payload,
            deadline: call.deadline.getTime(),
          }),
        );
      }
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
    void db
      .update(localDevices)
      .set({ connectionId: null, heartbeatAt: null })
      .where(activeConnection)
      .catch(() => {});
  });
}
