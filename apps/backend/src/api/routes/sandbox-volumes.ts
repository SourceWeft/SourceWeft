import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  VolumeControlUnauthorized,
  type VolumeService,
} from "@sourceweft/sandbox-volume";
import { sandboxVolumeService } from "../../modules/threads/agent/sandbox-service/volume";
import { logger } from "../../shared/logger";

const requestSchema = z
  .object({
    bootId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    epoch: z.number().int().nonnegative().safe(),
    seq: z.number().int().nonnegative().safe(),
    nextPack: z.number().int().nonnegative().max(1_000_000),
    locatorChunkIds: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .max(256)
      .optional(),
  })
  .strict();

type Dependencies = {
  service: () => Pick<
    VolumeService,
    "verifyControlToken" | "refreshControl"
  > | null;
  log: (event: string, fields: Record<string, unknown>) => void;
};

/** A capability-authenticated, attachment-only daemon endpoint. It deliberately
 * exposes no bootstrap, rebase, drain, rollback or object-deletion operations.
 */
export function registerSandboxVolumeRoutes(
  app: Hono,
  dependencies: Dependencies = {
    service: sandboxVolumeService,
    log: (event, fields) => logger.warn(event, fields),
  },
) {
  const inFlight = new Set<string>();
  const nextPoll = new Map<string, number>();
  let activeRequests = 0;
  const capacity = 32;
  const maxTrackedAttachments = 10_000;
  const path = "/v1/sandbox-volumes/:attachmentId/control";
  app.post(
    path,
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: "control_request_too_large" }, 413),
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const service = dependencies.service();
      if (!service) return c.json({ error: "not_found" }, 404);
      const id = c.req.param("attachmentId");
      const credential = /^Bearer (svctl_[A-Za-z0-9_-]{43})$/.exec(
        c.req.header("authorization") ?? "",
      )?.[1];
      if (!credential || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
        return c.json({ error: "unauthorized" }, 401);
      // Bound even authentication lookups; arbitrary valid-shaped credentials
      // must not enqueue unlimited database work during storage degradation.
      if (activeRequests >= capacity) {
        c.header("Retry-After", "1");
        return c.json({ error: "control_capacity_exhausted" }, 503);
      }
      activeRequests++;
      try {
        try {
          await service.verifyControlToken(id, credential);
        } catch (error) {
          if (error instanceof VolumeControlUnauthorized)
            return c.json({ error: "unauthorized" }, 401);
          dependencies.log("sandbox.volume.control_auth_unavailable", {
            attachmentId: id,
          });
          return c.json({ error: "control_unavailable" }, 503);
        }
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "invalid_control_request" }, 400);
        }
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success)
          return c.json({ error: "invalid_control_request" }, 400);
        const now = performance.now();
        if (inFlight.has(id) || (nextPoll.get(id) ?? 0) > now) {
          c.header("Retry-After", "1");
          return c.json({ error: "control_poll_in_progress" }, 429);
        }
        if (nextPoll.size >= maxTrackedAttachments)
          for (const [key, until] of nextPoll)
            if (until <= now && !inFlight.has(key)) nextPoll.delete(key);
        if (!nextPoll.has(id) && nextPoll.size >= maxTrackedAttachments) {
          c.header("Retry-After", "1");
          return c.json({ error: "control_capacity_exhausted" }, 503);
        }
        // Reserve the cooldown entry before awaiting remote work so parallel
        // completions cannot grow the tracking map beyond its capacity.
        nextPoll.set(id, Number.POSITIVE_INFINITY);
        inFlight.add(id);
        try {
          return c.json(
            await service.refreshControl(id, credential, parsed.data),
          );
        } catch (error) {
          if (error instanceof VolumeControlUnauthorized)
            return c.json({ error: "unauthorized" }, 401);
          if (error instanceof Error && error.name === "VolumeConflict")
            return c.json({ error: "attachment_state_changed" }, 409);
          // Exceptions can contain signed URLs. Never return or log their raw messages.
          dependencies.log("sandbox.volume.control_refresh_failed", {
            attachmentId: id,
            errorType: error instanceof Error ? error.name : "unknown",
          });
          return c.json({ error: "control_unavailable" }, 503);
        } finally {
          inFlight.delete(id);
          nextPoll.set(id, performance.now() + 1000);
        }
      } finally {
        activeRequests--;
      }
    },
  );
}
