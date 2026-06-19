import assert from "node:assert/strict";
import { test } from "vitest";
import { notionAgentToolDefs } from "@sourceweft/builtin-connector-notion";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  buildEffectiveToolsSelection,
  buildRuntimeTools,
  buildTurnOptionsSnapshot,
  readWebAccessOverride,
  resolveConnectorToolSelections,
  resolveGenerateImageToolSelection,
  resolveWebSearchEnabled,
} from "./tool-selection";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { ThreadToolsSelection } from "./types";

registerAgentTools(notionAgentToolDefs);

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

test("resolveWebSearchEnabled reads tool-name keyed request before legacy flag", () => {
  assert.equal(
    resolveWebSearchEnabled({
      tools: {
        webSearchEnabled: true,
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

test("resolveGenerateImageToolSelection maps legacy artifact to generate_image config", () => {
  assert.deepEqual(
    resolveGenerateImageToolSelection({
      artifact: {
        kind: "image",
        mode: "generate",
        modelAlias: "legacy-image",
        image: { aspectRatio: "1:1", quality: "standard" },
      },
    }),
    {
      modelAlias: "legacy-image",
      config: { aspectRatio: "1:1", quality: "standard" },
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
        "ppt-deck": {
          config: {
            language: "zh-CN",
            slideCount: 10,
            stylePreset: "executive",
            visualDensity: "dense",
          },
        },
      },
      search_notion_pages: { enabled: true, connectorId: "connector_1" },
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
        "ppt-deck": {
          config: {
            language: "zh-CN",
            slideCount: 10,
            stylePreset: "executive",
            visualDensity: "dense",
          },
        },
      },
      search_notion_pages: { enabled: true, connectorId: "connector_1" },
    },
  });
});

test("buildRuntimeTools exposes generic options without enabled flag", () => {
  assert.deepEqual(
    buildRuntimeTools({
      toolPermissions: { generate_video_presentation: "allow" },
      tools: {
        generate_video_presentation: {
          enabled: true,
          narration: { enabled: false },
        },
        skillIds: ["skill-1"],
      },
    }),
    {
      generate_video_presentation: {
        toolName: "generate_video_presentation",
        enabled: true,
        permission: "allow",
        shouldBind: true,
        selection: {
          enabled: true,
          narration: { enabled: false },
        },
        options: {
          narration: { enabled: false },
        },
      },
    },
  );
});

test("resolveConnectorToolSelections keeps notion connector tool selections only", () => {
  const tools: ThreadToolsSelection = {
    search_notion_pages: { enabled: true, connectorId: "connector_1" },
    delete_notion_page: { enabled: true },
    create_notion_page: { enabled: false },
    web_search: { enabled: true },
  };

  assert.deepEqual(resolveConnectorToolSelections(tools, "notion"), {
    search_notion_pages: { enabled: true, connectorId: "connector_1" },
    delete_notion_page: { enabled: true },
    create_notion_page: { enabled: false },
  });
});
