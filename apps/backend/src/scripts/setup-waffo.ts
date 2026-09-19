// Commercial billing operator command. Secrets are read only from environment variables.
import "dotenv/config";
import {
  readBillingConfig,
  validateBillingConfiguration,
} from "@sourceweft/billing/config";
import {
  createWaffoClient,
  PostgresWaffoStateStore,
  WAFFO_WEBHOOK_EVENTS,
} from "@sourceweft/billing/integrations/waffo";
import { setupWaffoCatalog } from "@sourceweft/billing/waffo-setup";
import { database, closeDatabase } from "@sourceweft/db";
import { config } from "../shared/config";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(store-id|webhook-url)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown option: ${arg}`);
    return [match[1], match[2]];
  }),
);
try {
  const billingConfig = readBillingConfig(
    {
      ...process.env,
      SOURCEWEFT_SAAS_ENABLED: "true",
      BACKEND_BILLING_PROVIDER: "waffo",
    },
    config.auth.webBaseUrl,
  );
  validateBillingConfiguration(billingConfig);
  if (billingConfig.waffo.environment !== "test")
    throw new Error(
      "This setup command requires a TEST API Key and test environment",
    );
  const client = createWaffoClient(billingConfig);
  const settings = await setupWaffoCatalog({
    client,
    config: billingConfig,
    state: new PostgresWaffoStateStore(database),
    storeId: options["store-id"],
  });
  console.log(
    JSON.stringify(
      {
        environment: "test",
        storeId: settings.storeId,
        products: settings.products,
      },
      null,
      2,
    ),
  );
  if (options["webhook-url"]) {
    const url = new URL(options["webhook-url"]);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/v1/billing/webhooks/waffo"
    )
      throw new Error(
        "Use an HTTPS endpoint ending in /v1/billing/webhooks/waffo",
      );
    const result = await client.webhooks.add({
      storeId: settings.storeId,
      channel: "http",
      url: url.toString(),
      events: [...WAFFO_WEBHOOK_EVENTS],
      testMode: true,
    });
    console.log("Test webhook registered", JSON.stringify(result));
  }
} catch (error) {
  const details =
    error && typeof error === "object" && "details" in error
      ? error.details
      : undefined;
  console.error(
    error instanceof Error ? error.message : "Waffo setup failed",
    details ?? "",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
