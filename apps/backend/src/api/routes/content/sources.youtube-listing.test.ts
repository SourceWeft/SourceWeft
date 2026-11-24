import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { ContentError } from "../../../modules/content/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  listing: vi.fn(),
}));
vi.mock("../../../modules/sources", () => ({
  contentSourceService: {},
  sourceIndexingService: {},
  sourceParsingService: {},
}));
vi.mock("../../../modules/notes", () => ({
  getNoteOrigin: vi.fn(),
  updateNoteContent: vi.fn(),
}));
vi.mock("../../../modules/sources/youtube/listing-service", () => ({
  listYouTubeCollection: mocks.listing,
}));
vi.mock("../../../modules/workspace/guards", () => ({
  requireContentWorkspace: async () => ({
    id: "workspace",
    organizationId: "team",
  }),
}));
vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: () => "user",
}));
import { registerSourceRoutes } from "./sources";

const app = new Hono();
const routes = new Hono();
registerSourceRoutes(routes);
app.route("/v1/workspaces/:workspaceId", routes);
app.onError((error, c) =>
  c.json(
    { code: (error as { code?: string }).code },
    ((error as { statusCode?: number }).statusCode ?? 500) as 429,
  ),
);

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user" } });
  mocks.listing.mockReset();
});

function list() {
  return app.request("/v1/workspaces/workspace/sources/youtube/listing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/playlist?list=PLxyz12345",
    }),
  });
}

test("a rate-limited listing tells the client when to retry", async () => {
  mocks.listing.mockRejectedValue(
    new ContentError(
      429,
      "SOURCE_DISCOVERY_RATE_LIMITED",
      "You have reached the limit for listing YouTube videos.",
      {
        details: {
          scope: "minute",
          retryAfterSeconds: 42,
          limit: 5,
          windowSeconds: 60,
        },
        exposeDetails: true,
      },
    ),
  );

  const response = await list();

  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("42");
});

test("any other listing failure carries no Retry-After", async () => {
  mocks.listing.mockRejectedValue(
    new ContentError(502, "YOUTUBE_LISTING_FAILED", "feed down"),
  );

  const response = await list();

  expect(response.status).toBe(502);
  expect(response.headers.get("retry-after")).toBeNull();
});

test("a successful listing is returned", async () => {
  mocks.listing.mockResolvedValue({
    kind: "playlist",
    title: "Lectures",
    videos: [],
  });

  const response = await list();

  expect(response.status).toBe(200);
  expect(response.headers.get("retry-after")).toBeNull();
  expect(mocks.listing).toHaveBeenCalledWith({
    teamId: "team",
    workspaceId: "workspace",
    userId: "user",
    url: "https://www.youtube.com/playlist?list=PLxyz12345",
  });
});
