import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { BillingError } from "../server/errors";
import { StripeWebhookService } from "../server/providers/stripe/webhook";
export {
  StripeBillingProvider,
  createStripeClient,
} from "../server/providers/stripe/provider";
export { PostgresStripeInboxStore } from "../server/providers/stripe/state";
export {
  StripeWebhookService,
  STRIPE_WEBHOOK_EVENTS,
} from "../server/providers/stripe/webhook";
export function registerStripeWebhook(app: Hono, inbox: StripeWebhookService) {
  app.post(
    "/v1/billing/webhooks/stripe",
    bodyLimit({ maxSize: 256 * 1024 }),
    async (c) => {
      try {
        await inbox.receive(
          await c.req.text(),
          c.req.header("stripe-signature"),
        );
      } catch (error) {
        if (error instanceof BillingError)
          return c.json(
            { error: error.code },
            error.statusCode as ContentfulStatusCode,
          );
        throw error;
      }
      inbox.kick();
      return c.text("OK", 200);
    },
  );
}
