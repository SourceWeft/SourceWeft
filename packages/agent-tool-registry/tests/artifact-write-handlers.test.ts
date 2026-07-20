import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactWriteHandler } from "@sourceweft/contracts";
import {
  collectArtifactWriteHandlers,
  createArtifactWriteHandlerRegistry,
  EMPTY_ARTIFACT_WRITE_HANDLER_REGISTRY,
  type ArtifactWriteHandlerWarning,
} from "../src/artifact-write-handlers";

/**
 * The write side is the mirror of `artifact-view-handlers.ts` and is tested for
 * the same three properties: a capability's factory is what registers it, a
 * duplicate registration is reported rather than silently taking over, and a
 * package that fails to load degrades the registry instead of the host.
 *
 * The last one is why `collect` swallows: one capability package with a broken
 * import must not take down every other capability's ability to write.
 */

function handler(artifactType: string): ArtifactWriteHandler {
  return { artifactType };
}

test("handlers are collected from each module's factory", async () => {
  const handlers = await collectArtifactWriteHandlers({
    modules: {
      "@sourceweft/a": async () => ({
        createArtifactWriteHandlers: () => [handler("slides")],
      }),
      "@sourceweft/b": async () => ({
        createArtifactWriteHandlers: async () => [handler("video_presentation")],
      }),
    },
  });
  assert.deepEqual(
    handlers.map((entry) => entry.artifactType),
    ["slides", "video_presentation"],
  );
});

test("a module without the factory contributes nothing and is not an error", async () => {
  const warnings: ArtifactWriteHandlerWarning[] = [];
  const handlers = await collectArtifactWriteHandlers({
    modules: { "@sourceweft/a": async () => ({}) },
    onWarn: (warning) => warnings.push(warning),
  });
  assert.deepEqual(handlers, []);
  assert.deepEqual(warnings, []);
});

test("a package that fails to load is reported, and the rest still register", async () => {
  const warnings: ArtifactWriteHandlerWarning[] = [];
  const handlers = await collectArtifactWriteHandlers({
    modules: {
      "@sourceweft/broken": async () => {
        throw new Error("boom");
      },
      "@sourceweft/ok": async () => ({
        createArtifactWriteHandlers: () => [handler("slides")],
      }),
    },
    onWarn: (warning) => warnings.push(warning),
  });
  assert.deepEqual(
    handlers.map((entry) => entry.artifactType),
    ["slides"],
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.kind, "load_failed");
});

test("the first registration for a type wins and the duplicate is reported", () => {
  // Letting the later one take over would make which handler validates an
  // artifact depend on module iteration order.
  const warnings: ArtifactWriteHandlerWarning[] = [];
  const first = handler("slides");
  const registry = createArtifactWriteHandlerRegistry([first, handler("slides")], {
    onWarn: (warning) => warnings.push(warning),
  });
  assert.equal(registry.handlerFor("slides"), first);
  assert.deepEqual(warnings, [{ kind: "conflict", artifactType: "slides" }]);
});

test("an unregistered, null or undefined type resolves to null", () => {
  const registry = createArtifactWriteHandlerRegistry([handler("slides")]);
  // A type nobody registered: the host's type-agnostic write still applies, so
  // this is an ordinary answer rather than an error.
  assert.equal(registry.handlerFor("mindmap"), null);
  assert.equal(registry.handlerFor(null), null);
  assert.equal(registry.handlerFor(undefined), null);
  assert.equal(EMPTY_ARTIFACT_WRITE_HANDLER_REGISTRY.handlerFor("slides"), null);
});

test("the builtin capability packages register without conflicting", async () => {
  const warnings: ArtifactWriteHandlerWarning[] = [];
  const handlers = await collectArtifactWriteHandlers({
    onWarn: (warning) => warnings.push(warning),
  });
  createArtifactWriteHandlerRegistry(handlers, {
    onWarn: (warning) => warnings.push(warning),
  });
  assert.deepEqual(warnings, []);

  // The seam is in place but no capability has been migrated onto it yet, so
  // the collected set is legitimately empty. What must hold either way is that
  // `image` and `file` are never claimed: they are top-level media served by
  // the generic writer, exactly as the read side serves them generically. A
  // handler appearing for one of them would mean a capability had taken over a
  // type with more than one producer — the mistake this split exists to avoid.
  for (const generic of ["image", "file"]) {
    assert.equal(
      handlers.some((entry) => entry.artifactType === generic),
      false,
      `${generic} is a top-level medium and must stay on the generic write path`,
    );
  }
});
