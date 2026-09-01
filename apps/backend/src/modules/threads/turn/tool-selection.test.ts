import assert from "node:assert/strict";
import { test } from "vitest";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  buildEffectiveToolsSelection,
  buildRuntimeTools,
  buildTurnOptionsSnapshot,
  readWebAccessOverride,
  resolveConnectorToolSelections,
  resolveTurnToolSelections,
  resolveWebSearchEnabled,
} from "./tool-selection";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { ThreadToolsSelection } from "./types";

import {
  SYNTHETIC_CONNECTOR_DELETE_TOOL,
  SYNTHETIC_CONNECTOR_READ_TOOL,
  SYNTHETIC_CONNECTOR_TYPE,
  SYNTHETIC_CONNECTOR_WRITE_TOOL,
  syntheticConnectorAgentToolDefs,
} from "../../../test/synthetic-capability";

/**
 * Connector tool selection is host logic keyed off the tool definitions the
 * registry holds — the host asks a tool which connector type it belongs to and
 * keeps only that connector's selections. A synthetic connector supplies those
 * definitions, so these assertions cannot be broken (or accidentally satisfied)
 * by a real connector's tool set.
 */
registerAgentTools(syntheticConnectorAgentToolDefs);

function skill(input: Partial<EnabledSkillDescriptor>): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "skill-1",
    sourceType: "workspace_custom",
    name: "skill",
    version: "1.0.0",
    description: "Skill",
    files: [],
    ...input,
  };
}

test("resolveWebSearchEnabled reads tool-name keyed request selections", () => {
  assert.equal(
    resolveWebSearchEnabled({
      tools: {
        web_search: { enabled: false },
      },
      enabledSkills: [skill({ name: "search", tools: ["web_search"] })],
    }),
    false,
  );
  assert.equal(
    resolveWebSearchEnabled({
      tools: undefined,
      enabledSkills: [skill({ name: "search", tools: ["web_search"] })],
    }),
    true,
  );
  assert.equal(
    resolveWebSearchEnabled({
      tools: {
        web_fetch: { enabled: false },
      },
      enabledSkills: [],
    }),
    false,
  );
});

test("readWebAccessOverride reads web fetch fallback", () => {
  assert.equal(readWebAccessOverride({ web_fetch: { enabled: true } }), true);
  assert.equal(readWebAccessOverride({ web_fetch: { enabled: false } }), false);
});

test("resolveTurnToolSelections reads generate_image selection only", () => {
  assert.deepEqual(
    resolveTurnToolSelections({
      generate_image: {
        enabled: true,
        modelAlias: "image-model",
        config: { aspectRatio: "1:1", quality: "standard" },
      },
    }),
    {
      generate_image: {
        enabled: true,
        modelAlias: "image-model",
        config: { aspectRatio: "1:1", quality: "standard" },
      },
    },
  );
});

test("buildTurnOptionsSnapshot stores effective canonical tool selections", () => {
  const effectiveTools = buildEffectiveToolsSelection({
    baseTools: {
      generate_image: {
        config: { style: "cartoon" },
      },
      publish_artifact: {
        enabled: true,
      },
      skillRuntimeConfig: {
        "builtin:ppt-deck": {
          language: "zh-CN",
          slideCount: 10,
          stylePreset: "executive",
          visualDensity: "dense",
        },
      },
      [SYNTHETIC_CONNECTOR_READ_TOOL]: {
        enabled: true,
        connectorId: "connector_1",
      },
    },
    skillIds: ["skill-1"],
    webAccessEnabled: true,
  });

  assert.deepEqual(buildTurnOptionsSnapshot({ tools: effectiveTools }), {
    version: 1,
    tools: {
      skillIds: ["skill-1"],
      web_search: { enabled: true },
      web_fetch: { enabled: true },
      generate_image: { enabled: true, config: { style: "cartoon" } },
      publish_artifact: {
        enabled: true,
      },
      skillRuntimeConfig: {
        "builtin:ppt-deck": {
          language: "zh-CN",
          slideCount: 10,
          stylePreset: "executive",
          visualDensity: "dense",
        },
      },
      [SYNTHETIC_CONNECTOR_READ_TOOL]: {
        enabled: true,
        connectorId: "connector_1",
      },
    },
  });
});

test("buildRuntimeTools exposes generic options without enabled flag", () => {
  assert.deepEqual(
    buildRuntimeTools({
      toolPermissions: { custom_tool: "allow" },
      tools: {
        custom_tool: {
          enabled: true,
          format: { density: "compact" },
        },
        skillIds: ["skill-1"],
      },
    }),
    {
      custom_tool: {
        toolName: "custom_tool",
        enabled: true,
        permission: "allow",
        shouldBind: true,
        selection: {
          enabled: true,
          format: { density: "compact" },
        },
        options: {
          format: { density: "compact" },
        },
      },
    },
  );
});

test("resolveConnectorToolSelections keeps one connector's tool selections only", () => {
  const tools: ThreadToolsSelection = {
    [SYNTHETIC_CONNECTOR_READ_TOOL]: {
      enabled: true,
      connectorId: "connector_1",
    },
    [SYNTHETIC_CONNECTOR_DELETE_TOOL]: { enabled: true },
    [SYNTHETIC_CONNECTOR_WRITE_TOOL]: { enabled: false },
    web_search: { enabled: true },
  };

  assert.deepEqual(
    resolveConnectorToolSelections(tools, SYNTHETIC_CONNECTOR_TYPE),
    {
      [SYNTHETIC_CONNECTOR_READ_TOOL]: {
        enabled: true,
        connectorId: "connector_1",
      },
      [SYNTHETIC_CONNECTOR_DELETE_TOOL]: { enabled: true },
      [SYNTHETIC_CONNECTOR_WRITE_TOOL]: { enabled: false },
    },
  );
});
