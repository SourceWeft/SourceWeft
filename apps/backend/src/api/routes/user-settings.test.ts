import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiResponse, toApiError } from "../response/api-response";
import { PreviewAccessError } from "../../modules/preview/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../modules/user-settings", () => ({
  userSettingsService: {
    getUserSettings: mocks.get,
    updateUserSettings: mocks.update,
  },
}));
import { registerUserSettingsRoutes } from "./user-settings";

const settings = {
  appearance: { theme: "system", language: "system" },
  preview: { gmail: true },
};
function app() {
  const result = new Hono();
  result.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  registerUserSettingsRoutes(result);
  return result;
}
function patch(body: unknown) {
  return app().request("/v1/user/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("user settings API security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "current-user" } });
    mocks.get.mockResolvedValue({ settings });
    mocks.update.mockResolvedValue({ settings });
  });

  it("returns current user's flags without accepting a target user from the client", async () => {
    const response = await app().request(
      "/v1/user/settings?userId=another-user",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings });
    expect(mocks.get).toHaveBeenCalledWith({ userId: "current-user" });
  });

  it.each([
    { preview: { gmail: true } },
    { appearance: { theme: "dark" }, preview: { gmail: true } },
    { appearance: { theme: "dark", preview: { gmail: true } } },
    { appearance: { theme: "dark" }, userId: "another-user" },
  ])("rejects forbidden fields without writing: %j", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("passes only the authenticated user's appearance patch to the service", async () => {
    const response = await patch({ appearance: { theme: "dark" } });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      userId: "current-user",
      patch: { appearance: { theme: "dark" } },
    });
  });

  it("requires authentication for reads and writes", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await app().request("/v1/user/settings")).status).toBe(401);
    expect((await patch({ appearance: { theme: "dark" } })).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("surfaces storage failure without returning default flags", async () => {
    mocks.get.mockRejectedValue(new Error("database unavailable"));
    const response = await app().request("/v1/user/settings");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
    });
  });

  it("maps preview denials to safe forbidden responses", () => {
    const error = toApiError(new PreviewAccessError());
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("PREVIEW_ACCESS_DENIED");
  });
});
