import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { contentThreadService } from "../../../modules/threads";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

export function registerModelGatewayRoutes(app: Hono) {
  app.get("/model-gateway/models", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const view = c.req.query("view");
    if (view !== undefined && view !== "selector") {
      throw ApiError.validation({
        view: ["Expected 'selector' when the view parameter is provided."],
      });
    }

    const input = {
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    };
    if (view === "selector") {
      const result = await contentThreadService.listThreadModelSelectorCatalog(
        input,
      );
      const payload = JSON.stringify(result);
      const etag = `"${createHash("sha256")
        .update(payload)
        .digest("hex")
        .slice(0, 32)}"`;
      c.header("etag", etag);
      c.header(
        "cache-control",
        "private, max-age=60, stale-while-revalidate=300",
      );
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304);
      }
      c.header("content-type", "application/json; charset=UTF-8");
      c.header("content-length", String(Buffer.byteLength(payload)));
      return c.body(payload, 200);
    }

    const result = await contentThreadService.listThreadModelCatalog(input);

    return ApiResponse.success(c, result);
  });
}
