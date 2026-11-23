import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  resolvePublicArtifactBytes: vi.fn(),
  resolvePublicArtifact: vi.fn(),
  resolvePublicChat: vi.fn(),
  resolvePublicChatImage: vi.fn(),
}));

vi.mock("../../modules/sharing", () => ({
  sharingService: {
    resolvePublicArtifactBytes: mocks.resolvePublicArtifactBytes,
    resolvePublicArtifact: mocks.resolvePublicArtifact,
  },
}));

vi.mock("../../modules/threads/share/service", () => ({
  threadShareService: {
    resolvePublicChat: mocks.resolvePublicChat,
    resolvePublicChatImage: mocks.resolvePublicChatImage,
  },
}));

vi.mock("../../modules/artifact-records", () => ({
  artifactRecordsService: { executePublic: vi.fn() },
  artifactRecordError: (code: string, message: string) =>
    new Error(`${code}: ${message}`),
}));

vi.mock("../../modules/artifacts", () => ({
  contentArtifactsService: {
    getSharedArtifactFile: vi.fn(),
    getSharedVersionFile: vi.fn(),
    getSharedArtifactVersionMediaBytes: vi.fn(),
    getSharedCurrentArtifactVersionMedia: vi.fn(),
  },
}));

import { registerPublicShareRoutes } from "./public-shares";

const createTestApp = () => createRouteTestApp(registerPublicShareRoutes);

const CHAT = {
  title: "A shared chat",
  takenAt: "2026-01-01T00:00:00.000Z",
  assistantName: "Assistant",
  noindex: false,
  messages: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

test("GET /chat returns the public chat", async () => {
  mocks.resolvePublicChat.mockResolvedValue(CHAT);

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/chat",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { chat: CHAT });
  assert.deepEqual(mocks.resolvePublicChat.mock.calls[0]?.[0], "tok");
  assert.equal(response.headers.get("x-robots-tag"), null);
});

test("GET /chat sets x-robots-tag noindex only when the chat is noindex", async () => {
  mocks.resolvePublicChat.mockResolvedValue({ ...CHAT, noindex: true });

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/chat",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
});

test("GET /chat is a 404 SHARE_NOT_FOUND when there is no live share", async () => {
  mocks.resolvePublicChat.mockResolvedValue(null);

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/chat",
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "SHARE_NOT_FOUND");
});

test("GET /chat/images/:n serves an inline image with the hardening headers", async () => {
  mocks.resolvePublicChatImage.mockResolvedValue({
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
  });

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/chat/images/1",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-disposition"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, must-revalidate",
  );
  assert.deepEqual(mocks.resolvePublicChatImage.mock.calls[0], ["tok", 1]);
});

test("GET /chat/images/:n serves a non-allow-listed type as an attachment octet-stream", async () => {
  mocks.resolvePublicChatImage.mockResolvedValue({
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/svg+xml",
  });

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/chat/images/2",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-disposition"), "attachment");
});

for (const n of ["0", "abc", "-1", "01", "1.5"]) {
  test(`GET /chat/images/:n rejects a malformed n (${n}) as 404`, async () => {
    const response = await createTestApp().request(
      `http://localhost/v1/public/shares/tok/chat/images/${n}`,
    );

    assert.equal(response.status, 404);
    assert.equal(mocks.resolvePublicChatImage.mock.calls.length, 0);
  });
}

test("GET /chat/images/:n is a 404 when the service finds nothing", async () => {
  mocks.resolvePublicChatImage.mockResolvedValue(null);

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/chat/images/3",
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "SHARE_NOT_FOUND");
});
