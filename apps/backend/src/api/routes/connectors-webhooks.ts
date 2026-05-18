import type { Hono } from "hono";
import { connectorWebhookService } from "../../modules/connectors";
import { ApiResponse } from "../response/api-response";

function queryRecord(url: string) {
  const search = new URL(url).searchParams;
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of search.entries()) {
    output[key] = value;
  }
  return output;
}

export function registerConnectorWebhookRoutes(app: Hono) {
  app.post("/v1/connectors/webhooks/:connectorType", async (c) => {
    const connectorType = c.req.param("connectorType");
    const result = await connectorWebhookService.receive({
      connectorType,
      request: c.req.raw,
      query: queryRecord(c.req.url),
    });
    return ApiResponse.success(c, result, 202);
  });
}
