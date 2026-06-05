import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";
import { AGENT_TOOL_NAMES } from "../tool-names";
import {
  logSandboxStartupWarning,
  warnIfSandboxHitlBypassed,
} from "./startup-log";

const originalSandboxConfig = structuredClone(config.sandbox);

beforeEach(() => {
  Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
});

afterEach(() => {
  Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
  vi.restoreAllMocks();
});

test("logSandboxStartupWarning includes Daytona default snapshot configuration state", () => {
  config.sandbox.enabled = true;
  config.sandbox.provider = "daytona";
  config.sandbox.daytona.apiUrl = "http://daytona-startup-test/api";
  config.sandbox.daytona.apiKey = "startup-test-key";
  config.sandbox.daytona.defaultSnapshot =
    "ghcr.io/sourceweft/sourceweft-sandbox-base:node20-tools0.1.0-latest";
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

  logSandboxStartupWarning("api");

  assert.equal(warn.mock.calls.length, 1);
  const metadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
  assert.equal(metadata.daytonaDefaultSnapshotConfigured, true);
  assert.equal(metadata.daytonaDefaultSnapshotKind, "image");
});

test("logSandboxStartupWarning warns when Daytona default snapshot is missing", () => {
  config.sandbox.enabled = true;
  config.sandbox.provider = "daytona";
  config.sandbox.daytona.apiUrl = "http://daytona-startup-test/api";
  config.sandbox.daytona.apiKey = "startup-test-key";
  config.sandbox.daytona.defaultSnapshot = "";
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

  logSandboxStartupWarning("worker");

  assert.equal(warn.mock.calls.length, 2);
  const startupMetadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
  const incompleteMetadata = warn.mock.calls[1]?.[1] as Record<string, unknown>;
  assert.equal(startupMetadata.daytonaDefaultSnapshotConfigured, false);
  assert.equal(startupMetadata.daytonaDefaultSnapshotKind, "missing");
  assert.equal(
    warn.mock.calls[1]?.[0],
    "Sandbox runtime is enabled but Daytona provider configuration is incomplete",
  );
  assert.equal(incompleteMetadata.daytonaDefaultSnapshotConfigured, false);
});

test("warnIfSandboxHitlBypassed warns when execute interrupt is missing", () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

  warnIfSandboxHitlBypassed({
    interruptOn: {},
    boundSandboxToolNames: [AGENT_TOOL_NAMES.prepareSandboxWorkspace],
  });

  assert.equal(warn.mock.calls.length, 1);
  assert.deepEqual(warn.mock.calls[0]?.[1], {
    missingInterrupts: [
      AGENT_TOOL_NAMES.execute,
      AGENT_TOOL_NAMES.prepareSandboxWorkspace,
    ],
    boundSandboxToolNames: [AGENT_TOOL_NAMES.prepareSandboxWorkspace],
  });
});

test("warnIfSandboxHitlBypassed stays quiet when sandbox interrupts are present", () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

  warnIfSandboxHitlBypassed({
    interruptOn: {
      [AGENT_TOOL_NAMES.execute]: {},
      [AGENT_TOOL_NAMES.prepareSandboxWorkspace]: {},
      [AGENT_TOOL_NAMES.collectSandboxOutputs]: {},
    },
    boundSandboxToolNames: [
      AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      AGENT_TOOL_NAMES.collectSandboxOutputs,
    ],
  });

  assert.equal(warn.mock.calls.length, 0);
});
