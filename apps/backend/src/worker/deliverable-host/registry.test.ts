import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildDeliverableProcessorMap,
  discoverDeliverablePipelines,
  type DeliverableCapabilityRecord,
} from "./registry";

function record(input: {
  packageName?: string;
  jobName?: string;
  id?: string;
}): DeliverableCapabilityRecord {
  return {
    packageName: input.packageName ?? "@sourceweft/fake-tool",
    rootDir: "/tmp/fake",
    manifest: {
      id: input.id ?? "sourceweft/fake-tool",
      entry: "./src/index.ts",
      contributes: {
        tools: [
          {
            id: "fake_tool",
            ...(input.jobName
              ? { runtime: { pipeline: { jobName: input.jobName } } }
              : {}),
          },
        ],
      },
    },
  };
}

function fakeDefinition(jobName: string) {
  return {
    id: "fake_pipeline",
    jobName,
    artifactType: "fake",
    stages: [{ id: "one", label: "One", budgetMs: 1000, maxAttempts: 1 }],
    defaultErrorCode: "FAKE_FAILED",
    invalidPayloadErrorCode: "FAKE_INVALID",
    prepareJob: () => ({}),
    loadState: () => ({
      generation: { status: "pending", stage: "one", progress: 0 },
    }),
    buildStageView: () => ({}),
    runStage: async ({ state }: { state: unknown }) => state,
    finalize: () => ({}),
  } as never;
}

test("discovers pipelines declared via runtime.pipeline and matches job names", async () => {
  const definitions = await discoverDeliverablePipelines({
    recordsProvider: async () => [
      record({ jobName: "fake-generate" }),
      record({ packageName: "@sourceweft/no-pipeline", jobName: undefined }),
    ],
    builtinModules: {
      "@sourceweft/fake-tool": async () => ({
        createDeliverablePipelines: () => [fakeDefinition("fake-generate")],
      }),
    },
  });
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.jobName, "fake-generate");
});

test("skips declarations whose factory or job name does not materialize", async () => {
  const definitions = await discoverDeliverablePipelines({
    recordsProvider: async () => [
      record({ packageName: "@sourceweft/missing-factory", jobName: "a" }),
      record({ packageName: "@sourceweft/mismatch", jobName: "b", id: "m2" }),
    ],
    builtinModules: {
      "@sourceweft/missing-factory": async () => ({}),
      "@sourceweft/mismatch": async () => ({
        createDeliverablePipelines: () => [fakeDefinition("not-b")],
      }),
    },
  });
  assert.equal(definitions.length, 0);
});

test("rejects duplicate job names across capabilities", async () => {
  const definitions = await discoverDeliverablePipelines({
    recordsProvider: async () => [
      record({ packageName: "@sourceweft/one", jobName: "dup", id: "one" }),
      record({ packageName: "@sourceweft/two", jobName: "dup", id: "two" }),
    ],
    builtinModules: {
      "@sourceweft/one": async () => ({
        createDeliverablePipelines: () => [fakeDefinition("dup")],
      }),
      "@sourceweft/two": async () => ({
        createDeliverablePipelines: () => [fakeDefinition("dup")],
      }),
    },
  });
  assert.equal(definitions.length, 1);
});

test("builds a processor map keyed by job name", async () => {
  const map = await buildDeliverableProcessorMap({
    recordsProvider: async () => [record({ jobName: "fake-generate" })],
    builtinModules: {
      "@sourceweft/fake-tool": async () => ({
        createDeliverablePipelines: () => [fakeDefinition("fake-generate")],
      }),
    },
    resolveRuntime: () => async () => {
      throw new Error("runtime not needed for registration");
    },
  });
  assert.deepEqual(Object.keys(map.processors), ["fake-generate"]);
  assert.equal(typeof map.processors["fake-generate"], "function");
  assert.deepEqual(map.failureCodes, { "fake-generate": "FAKE_FAILED" });
});

test("falls back to builtin modules when discovery throws or finds nothing", async () => {
  const builtinModules = {
    "@sourceweft/fake-tool": async () => ({
      createDeliverablePipelines: () => [fakeDefinition("fake-generate")],
    }),
  };

  const afterThrow = await buildDeliverableProcessorMap({
    recordsProvider: async () => {
      throw new Error("packages root unreadable");
    },
    builtinModules,
    resolveRuntime: () => async () => {
      throw new Error("runtime not needed");
    },
  });
  assert.equal(afterThrow.source, "builtin-fallback");
  assert.deepEqual(Object.keys(afterThrow.processors), ["fake-generate"]);

  const afterEmpty = await buildDeliverableProcessorMap({
    recordsProvider: async () => [],
    builtinModules,
    resolveRuntime: () => async () => {
      throw new Error("runtime not needed");
    },
  });
  assert.equal(afterEmpty.source, "builtin-fallback");
  assert.deepEqual(Object.keys(afterEmpty.processors), ["fake-generate"]);
  assert.deepEqual(afterEmpty.failureCodes, { "fake-generate": "FAKE_FAILED" });
});

test("registers the real video-presentation pipeline from its builtin module", async () => {
  const definitions = await discoverDeliverablePipelines({
    recordsProvider: async () => [
      {
        packageName: "@sourceweft/builtin-tool-video-presentation",
        rootDir: "/unused",
        manifest: {
          id: "sourceweft/video-presentation-tool",
          contributes: {
            tools: [
              {
                id: "generate_video_presentation",
                runtime: {
                  pipeline: { jobName: "video-presentation-generate" },
                },
              },
            ],
          },
        },
      },
    ],
  });
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.jobName, "video-presentation-generate");
  assert.equal(definitions[0]?.artifactType, "video_presentation");
  assert.equal(definitions[0]?.stages.length, 11);
});
