import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import {
  AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS,
  resolveAgentToolTimeoutMs,
} from "@sourceweft/contracts/agent-tools";
import { builtinVideoPresentationCapabilityManifest } from "../src";
import { validateVideoPresentationAgentTool } from "../src/agent-tool-defs";
import {
  generateVideoAssetsAgentTool,
  generateVideoNarrationAgentTool,
  loadVideoPresentationAgentTool,
  publishVideoPresentationAgentTool,
} from "../src/agent-tool-defs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinVideoPresentationCapabilityManifest,
  );
});

test("video-presentation manifest exposes only the five current typed tools", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinVideoPresentationCapabilityManifest,
  );
  const tools = manifest.contributes.tools;

  assert.deepEqual(
    tools.map((tool) => tool.id),
    [
      "load_video_presentation",
      "generate_video_assets",
      "generate_video_narration",
      "validate_video_presentation",
      "publish_video_presentation",
    ],
  );
  assert.equal(
    tools.every((tool) => tool.command === undefined),
    true,
  );
});

test("trusted validation declares its host-managed browser dependency", () => {
  assert.deepEqual(validateVideoPresentationAgentTool.sandboxRuntimeAssets, [
    "chrome-headless-shell",
  ]);
});

test("long-running video tools declare wall-clock budgets; ordinary tools use the host default", () => {
  assert.equal(
    resolveAgentToolTimeoutMs({
      definition: loadVideoPresentationAgentTool,
      hostMaxMs: 10 * 60_000,
    }),
    AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS,
  );
  assert.equal(generateVideoAssetsAgentTool.executionTimeoutMs, 5 * 60_000);
  assert.equal(generateVideoNarrationAgentTool.executionTimeoutMs, 5 * 60_000);
  assert.equal(
    validateVideoPresentationAgentTool.executionTimeoutMs,
    10 * 60_000,
  );
  assert.equal(
    resolveAgentToolTimeoutMs({
      definition: publishVideoPresentationAgentTool,
      hostMaxMs: 10 * 60_000,
    }),
    AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS,
  );
});
