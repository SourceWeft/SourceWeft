import { Hono } from "hono";
import { desktopAuthRendezvous } from "../../modules/auth/desktop-auth-rendezvous";
import { requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

function ensureObjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.invalidJson();
  }

  return value as Record<string, unknown>;
}

export function registerDesktopAuthRoutes(app: Hono) {
  app.post("/v1/desktop-auth/complete", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const state = typeof body.state === "string" ? body.state : "";
    const token = typeof body.token === "string" ? body.token : "";

    const result = desktopAuthRendezvous.complete({ state, token });
    if (result === "invalid") {
      throw new ApiError(400, "INVALID_DESKTOP_AUTH_STATE", "Invalid state");
    }

    if (result === "expired") {
      throw new ApiError(
        410,
        "DESKTOP_AUTH_EXPIRED",
        "Desktop sign-in has expired",
      );
    }

    return ApiResponse.success(c, { ok: true });
  });

  app.get("/v1/desktop-auth/poll", async (c) => {
    const state = c.req.query("state") || "";
    const result = desktopAuthRendezvous.consume(state);

    if (result.status === "invalid") {
      throw new ApiError(400, "INVALID_DESKTOP_AUTH_STATE", "Invalid state");
    }

    if (result.status === "expired") {
      throw new ApiError(
        410,
        "DESKTOP_AUTH_EXPIRED",
        "Desktop sign-in has expired",
      );
    }

    if (result.status === "complete") {
      return ApiResponse.success(c, {
        status: "complete",
        token: result.token,
      });
    }

    return ApiResponse.success(c, { status: "pending" });
  });
}
