import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { researchRunSchema } from "@sourceweft/contracts/source-research";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
  saveNote: vi.fn(),
}));

vi.mock("../../../modules/sources/research/service", () => ({
  createResearch: mocks.create,
  getResearch: mocks.get,
  listResearch: mocks.list,
  cancelResearch: mocks.cancel,
}));
vi.mock("../../../modules/notes", () => ({
  saveResearchReportAsNote: mocks.saveNote,
}));
vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../../billing-host/bindings", () => ({ billingRuntime: {} }));

import { ApiResponse, toApiError } from "../../response/api-response";
import { ContentError } from "../../../modules/content/errors";
import { registerSourceResearchRoutes } from "./source-research";

const app = new Hono();
const routes = new Hono();
registerSourceResearchRoutes(routes);
app.route("/v1/workspaces/:workspaceId", routes);
app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

/** A full stored run row the mapper can project onto `researchRunSchema`. */
function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    teamId: "org-1",
    workspaceId: "ws-1",
    createdByUserId: "user",
    topic: "Solid-state batteries",
    status: "queued",
    phase: null,
    progressJson: { round: 0, searches: 0, pagesRead: 0, modelCalls: 0 },
    planJson: null,
    ledgerJson: [],
    reportMarkdown: null,
    reportCitationsJson: null,
    modelCalls: 0,
    errorCode: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-11-22T00:00:00.000Z"),
    updatedAt: new Date("2026-11-22T00:00:00.000Z"),
    ...overrides,
  };
}

function post(path: string, body: unknown) {
  return app.request(`/v1/workspaces/ws-1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user" } });
  mocks.create.mockReset();
  mocks.get.mockReset();
  mocks.list.mockReset();
  mocks.cancel.mockReset();
  mocks.saveNote.mockReset();
});

test("POST /source-research needs a session", async () => {
  mocks.session.mockResolvedValue(null);
  const r = await post("/source-research", { topic: "batteries" });
  expect(r.status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled();
});

test("an empty topic is a 400 before the service is called", async () => {
  const blank = await post("/source-research", { topic: "   " });
  expect(blank.status).toBe(400);
  expect((await blank.json()).code).toBe("VALIDATION_ERROR");

  const missing = await post("/source-research", {});
  expect(missing.status).toBe(400);

  expect(mocks.create).not.toHaveBeenCalled();
});

test("a started run comes back as a researchRunSchema run", async () => {
  mocks.create.mockResolvedValue({ kind: "ok", run: runRow() });
  const r = await post("/source-research", { topic: "batteries" });
  expect(r.status).toBe(201);
  const body = await r.json();
  const parsed = researchRunSchema.safeParse(body.run);
  expect(parsed.success).toBe(true);
  expect(body.run.phase).toBe("planning");
  expect(body.run.citations).toEqual([]);
  expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
    workspaceId: "ws-1",
    userId: "user",
    topic: "batteries",
  });
});

test("a limited result is a 429 with Retry-After and the limit's code", async () => {
  mocks.create.mockResolvedValue({
    kind: "limited",
    code: "CONCURRENCY_LIMIT",
    retryAfterSeconds: 42,
  });
  const r = await post("/source-research", { topic: "batteries" });
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("42");
  const body = await r.json();
  expect(body.code).toBe("CONCURRENCY_LIMIT");
  expect(body.details.retryAfterSeconds).toBe(42);
});

test("a limited result with no retry hint falls back to 60 seconds", async () => {
  mocks.create.mockResolvedValue({ kind: "limited", code: "DAILY_LIMIT" });
  const r = await post("/source-research", { topic: "batteries" });
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("60");
  expect((await r.json()).code).toBe("DAILY_LIMIT");
});

test("reading another workspace's run is a 404", async () => {
  mocks.get.mockRejectedValue(
    new ContentError(404, "RESEARCH_NOT_FOUND", "Research run not found"),
  );
  const r = await app.request("/v1/workspaces/ws-1/source-research/run-x");
  expect(r.status).toBe(404);
  expect((await r.json()).code).toBe("RESEARCH_NOT_FOUND");
});

test("GET /source-research lists the workspace's runs", async () => {
  mocks.list.mockResolvedValue([]);
  const r = await app.request("/v1/workspaces/ws-1/source-research");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ runs: [] });
});

test("cancel returns the flag the service decided", async () => {
  mocks.cancel.mockResolvedValue(true);
  const r = await post("/source-research/run-1/cancel", {});
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ cancelled: true });
});

test("save-note returns the saved note", async () => {
  mocks.saveNote.mockResolvedValue({
    noteId: "note-1",
    sourceId: "src-1",
    title: "Solid-state batteries",
    alreadySaved: false,
  });
  const r = await post("/source-research/run-1/save-note", {});
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ noteId: "note-1", alreadySaved: false });
  expect(mocks.saveNote.mock.calls[0]?.[0]).toMatchObject({
    workspaceId: "ws-1",
    userId: "user",
    runId: "run-1",
  });
});
