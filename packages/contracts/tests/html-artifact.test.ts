import assert from "node:assert/strict";
import { test } from "node:test";
import {
  htmlArtifactMetadataSchema,
  presentationCommandSchema,
  presentationEventSchema,
} from "../src/html-artifact";

test("plain HTML has no required presentation metadata", () => {
  assert.deepEqual(htmlArtifactMetadataSchema.parse({ schemaVersion: 1 }), {
    schemaVersion: 1,
  });
  assert.equal(
    htmlArtifactMetadataSchema.safeParse({
      schemaVersion: 1,
      skillId: "anything",
    }).success,
    false,
  );
});

test("presentation capability is producer-neutral and rejects duplicate page IDs", () => {
  const presentation = {
    protocol: "presentation/v1",
    pages: [{ id: "first" }, { id: "second" }],
  };
  assert.ok(
    htmlArtifactMetadataSchema.safeParse({ schemaVersion: 1, presentation })
      .success,
  );
  assert.equal(
    htmlArtifactMetadataSchema.safeParse({
      schemaVersion: 1,
      presentation: { ...presentation, pages: [{ id: "a" }, { id: "a" }] },
    }).success,
    false,
  );
});

test("control protocol rejects out-of-range state and privileged commands", () => {
  const base = { protocol: "presentation/v1", channelId: "a".repeat(32) };
  assert.ok(
    presentationCommandSchema.safeParse({
      ...base,
      type: "command",
      command: "next",
      requestId: "1",
    }).success,
  );
  assert.equal(
    presentationCommandSchema.safeParse({
      ...base,
      type: "command",
      command: "execute",
      requestId: "1",
    }).success,
    false,
  );
  assert.equal(
    presentationEventSchema.safeParse({
      ...base,
      type: "ready",
      state: {
        slideIndex: 2,
        slideCount: 2,
        fragmentIndex: -1,
        overview: false,
      },
    }).success,
    false,
  );
});
