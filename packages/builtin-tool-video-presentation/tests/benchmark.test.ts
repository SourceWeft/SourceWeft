import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_RENDER_BENCHMARK_PHASES,
  VIDEO_RENDER_WARM_TARGET_MS,
  buildVideoRenderBenchmarkFixture,
} from "../src/benchmark";

test("render benchmark is an 85-second eight-scene cold plus warm fixture", () => {
  const fixture = buildVideoRenderBenchmarkFixture();
  assert.equal(fixture.payload.project.durationSeconds, 85);
  assert.equal(fixture.payload.sceneModules.length, 8);
  assert.equal(fixture.payload.audioTracks.length, 8);
  assert.equal(fixture.payload.assets.length, 1);
  assert.deepEqual(VIDEO_RENDER_BENCHMARK_PHASES, [
    "cold",
    "warm",
    "warm",
    "warm",
  ]);
  assert.equal(VIDEO_RENDER_WARM_TARGET_MS, 120_000);
  assert.ok(
    fixture.project.files.some((file) => file.path === "pnpm-lock.yaml"),
  );
  assert.equal(fixture.project.validationSamples.length, 24);
});
