import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  available: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("../../../modules/dictation", () => ({
  isDictationAvailable: mocks.available,
  transcribeDictationSegment: mocks.transcribe,
}));
vi.mock("../../../modules/workspace/guards", () => ({
  requireContentWorkspace: async () => ({ id: "ws-1", organizationId: "org-1" }),
}));
vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../../billing-host/bindings", () => ({ billingRuntime: {} }));

import { ApiResponse, toApiError } from "../../response/api-response";
import { registerDictationRoutes } from "./dictation";

const app = new Hono();
const routes = new Hono();
registerDictationRoutes(routes);
app.route("/v1/workspaces/:workspaceId", routes);
app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

function wavFile(bytes: number) {
  return new File([new Uint8Array(bytes)], "segment.wav", {
    type: "audio/wav",
  });
}

function segmentForm(overrides: {
  file?: File | null;
  sessionId?: string;
  seq?: string;
} = {}) {
  const form = new FormData();
  if (overrides.file !== null) {
    form.set("file", overrides.file ?? wavFile(1000));
  }
  form.set(
    "sessionId",
    overrides.sessionId ?? "550e8400-e29b-41d4-a716-446655440000",
  );
  form.set("seq", overrides.seq ?? "0");
  return form;
}

function postSegment(form: FormData) {
  return app.request("/v1/workspaces/ws-1/dictation/segments", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user" } });
  mocks.available.mockReset().mockResolvedValue(true);
  mocks.transcribe.mockReset();
});

test("GET /dictation needs a session", async () => {
  mocks.session.mockResolvedValue(null);
  const r = await app.request("/v1/workspaces/ws-1/dictation");
  expect(r.status).toBe(401);
  expect(mocks.available).not.toHaveBeenCalled();
});

test("GET /dictation answers { available }", async () => {
  mocks.available.mockResolvedValue(true);
  const r = await app.request("/v1/workspaces/ws-1/dictation");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ available: true });
});

test("POST without a file → 400", async () => {
  const r = await postSegment(segmentForm({ file: null }));
  expect(r.status).toBe(400);
  expect((await r.json()).code).toBe("DICTATION_INVALID_AUDIO");
  expect(mocks.transcribe).not.toHaveBeenCalled();
});

test("POST with a 1 MB + 1 byte file → 400 DICTATION_INVALID_AUDIO", async () => {
  const r = await postSegment(segmentForm({ file: wavFile(1024 * 1024 + 1) }));
  expect(r.status).toBe(400);
  expect((await r.json()).code).toBe("DICTATION_INVALID_AUDIO");
  expect(mocks.transcribe).not.toHaveBeenCalled();
});

test("POST with a non-UUID session id or a negative seq → 400 validation", async () => {
  const bad = await postSegment(segmentForm({ sessionId: "not-a-uuid" }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).code).toBe("VALIDATION_ERROR");

  const negative = await postSegment(segmentForm({ seq: "-1" }));
  expect(negative.status).toBe(400);
  expect((await negative.json()).code).toBe("VALIDATION_ERROR");

  expect(mocks.transcribe).not.toHaveBeenCalled();
});

test("limited → 429 with Retry-After", async () => {
  mocks.transcribe.mockResolvedValue({ kind: "limited", retryAfterSeconds: 7 });
  const r = await postSegment(segmentForm());
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("7");
  const body = await r.json();
  expect(body.code).toBe("DICTATION_RATE_LIMITED");
  expect(body.details.retryAfterSeconds).toBe(7);
});

test("ok → 200 { text, durationSec }", async () => {
  mocks.transcribe.mockResolvedValue({
    kind: "ok",
    text: "hello",
    durationSec: 1.5,
  });
  const r = await postSegment(segmentForm());
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ text: "hello", durationSec: 1.5 });
  expect(mocks.transcribe).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "ws-1",
      userId: "user",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      seq: 0,
    }),
    expect.anything(),
  );
});
