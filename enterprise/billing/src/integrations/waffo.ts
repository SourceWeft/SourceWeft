import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import { WaffoWebhookService } from "../server/providers/waffo/webhook";
import { BillingError } from "../server/errors";
export {
  WaffoWebhookService,
  WAFFO_WEBHOOK_EVENTS,
} from "../server/providers/waffo/webhook";
export { PostgresWaffoStateStore } from "../server/providers/waffo/state";
export { createWaffoClient } from "../server/providers/waffo/client";

export function registerWaffoWebhook(app: Hono, service: WaffoWebhookService) {
  app.post(
    "/v1/billing/webhooks/waffo",
    bodyLimit({ maxSize: 256 * 1024 }),
    async (c) => {
      try {
        await service.receive(
          await c.req.text(),
          c.req.header("x-waffo-signature"),
        );
      } catch (error) {
        if (error instanceof BillingError)
          return c.json(
            { error: error.code },
            error.statusCode as ContentfulStatusCode,
          );
        throw error;
      }
      // The receipt is durable before ACK; the scheduler recovers interrupted work.
      service.kick();
      return c.text("OK", 200);
    },
  );
}
