import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVideoPresentationRequestKey } from "./video-presentation-request";

test("buildVideoPresentationRequestKey produces stable keys for same inputs", () => {
  const input = {
    workspaceId: "ws_123",
    threadId: "thread_456",
    userMessageId: "msg_789",
    modelIdentifier: "gpt-4o",
    requestFingerprint: {
      brief: "Explain TDD",
      renderProfile: { stylePreset: "technical" },
    },
  };

  const key1 = buildVideoPresentationRequestKey(input);
  const key2 = buildVideoPresentationRequestKey(input);

  assert.equal(key1, key2, "Same inputs must produce same key");
  assert.match(key1, /^video_presentation:ws_123:thread_456:msg_789:gpt-4o:[a-f0-9]{16}$/);
});

test("buildVideoPresentationRequestKey produces different keys for different content", () => {
  const base = {
    workspaceId: "ws_123",
    threadId: "thread_456",
    userMessageId: "msg_789",
    modelIdentifier: "gpt-4o",
    requestFingerprint: { brief: "Original content" },
  };

  const modified = {
    ...base,
    requestFingerprint: { brief: "Different content" },
  };

  const key1 = buildVideoPresentationRequestKey(base);
  const key2 = buildVideoPresentationRequestKey(modified);

  assert.notEqual(key1, key2, "Different content must produce different keys");
});

test("buildVideoPresentationRequestKey produces different keys for different models", () => {
  const base = {
    workspaceId: "ws_123",
    threadId: "thread_456",
    userMessageId: "msg_789",
    modelIdentifier: "gpt-4o",
    requestFingerprint: { brief: "Same content" },
  };

  const differentModel = {
    ...base,
    modelIdentifier: "claude-opus-4",
  };

  const key1 = buildVideoPresentationRequestKey(base);
  const key2 = buildVideoPresentationRequestKey(differentModel);

  assert.notEqual(key1, key2, "Different models must produce different keys");
});

test("buildVideoPresentationRequestKey is backward compatible without fingerprint", () => {
  const withoutFingerprint = {
    workspaceId: "ws_123",
    threadId: "thread_456",
    userMessageId: "msg_789",
    modelIdentifier: "gpt-4o",
  };

  const key = buildVideoPresentationRequestKey(withoutFingerprint);

  assert.equal(key, "video_presentation:ws_123:thread_456:msg_789:gpt-4o");
  assert.equal(key.split(":").length, 5, "Should have 5 parts without fingerprint");
});

test("buildVideoPresentationRequestKey omits model identifier when not provided", () => {
  const minimal = {
    workspaceId: "ws_123",
    threadId: "thread_456",
    userMessageId: "msg_789",
  };

  const key = buildVideoPresentationRequestKey(minimal);

  assert.equal(key, "video_presentation:ws_123:thread_456:msg_789");
  assert.equal(key.split(":").length, 4);
});
