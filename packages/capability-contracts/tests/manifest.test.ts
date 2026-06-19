import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  parseCapabilityManifest,
} from "../src/index";

const webSearchManifest = {
  schemaVersion: 1,
  id: "sourceweft/web-search",
  kind: "tool",
  name: "Web Search",
  version: "0.1.0",
  entry: "./dist/index.js",
  tools: [
    {
      id: "web_search",
      title: "Search Web",
      description: "Search the web and return cited results.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      risk: "read",
      command: {
        aliases: ["web"],
        category: "Research",
      },
    },
  ],
};

test("capability-manifest.valid parses a builtin tool manifest", () => {
  const manifest = capabilityManifestSchema.parse(webSearchManifest);

  assert.equal(manifest.id, "sourceweft/web-search");
  assert.equal(manifest.kind, "tool");
  assert.equal(manifest.contributes.tools[0]?.id, "web_search");
  assert.deepEqual(manifest.contributes.tools[0]?.command?.aliases, ["web"]);
});

test("capability-manifest.compat parses legacy contributes metadata", () => {
  const manifest = capabilityManifestSchema.parse({
    schemaVersion: 1,
    id: "sourceweft/web-search",
    kind: "tool",
    name: "Web Search",
    version: "0.1.0",
    contributes: {
      tools: [
        {
          id: "web_search",
          title: "Search Web",
          description: "Search the web and return cited results.",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          risk: "read",
        },
      ],
    },
  });

  assert.equal(manifest.contributes.tools[0]?.id, "web_search");
});

test("capability-manifest.runtime parses artifact tool runtime metadata", () => {
  const manifest = capabilityManifestSchema.parse({
    ...webSearchManifest,
    id: "sourceweft/generate-image",
    kind: "tool",
    tools: [
      {
        id: "generate_image",
        title: "Generate Image",
        description: "Generate an image artifact.",
        risk: "write",
        options: [
          {
            id: "aspectRatio",
            title: "Aspect Ratio",
            description: "Default aspect ratio for generated images.",
            valueType: "string",
            defaultValue: "auto",
            target: { path: "config.aspectRatio" },
            values: [
              { value: "auto", label: "auto" },
              { value: "1:1", label: "1:1" },
            ],
          },
        ],
        command: {
          aliases: ["image"],
          iconName: "image",
          iconTone: "mono",
        },
        runtime: {
          execution: "direct",
          promptIntro: "Create an image artifact from the user's request.",
          tools: ["generate_image"],
          permissionOverrides: { generate_image: "allow" },
          output: {
            kind: "artifact",
            artifactType: "image",
            publisherTool: "generate_image",
          },
        },
      },
    ],
  });

  assert.equal(
    manifest.contributes.tools[0]?.runtime?.output?.kind,
    "artifact",
  );
  assert.deepEqual(
    manifest.contributes.tools[0]?.runtime?.permissionOverrides,
    {
      generate_image: "allow",
    },
  );
  assert.equal(manifest.contributes.tools[0]?.command?.iconName, "image");
  assert.equal(manifest.contributes.tools[0]?.command?.iconTone, "mono");
  assert.deepEqual(
    manifest.contributes.tools[0]?.options.map((option) => option.id),
    ["aspectRatio"],
  );
});

test("capability-manifest.skill-runtime parses PPT Deck minimal metadata", () => {
  const manifest = capabilityManifestSchema.parse({
    schemaVersion: 1,
    id: "sourceweft/ppt-deck",
    kind: "skill",
    name: "PPT Deck",
    description: "Create slide decks from user requests.",
    version: "1.0.0",
    skills: [
      {
        id: "ppt-deck",
        visibility: "restricted",
        categories: ["create", "present"],
        options: [
          {
            id: "stylePreset",
            title: "Style",
            valueType: "string",
            defaultValue: "auto",
            target: {
              path: "runtime.config.stylePreset",
            },
            values: [{ value: "auto", label: "Auto" }],
          },
        ],
        runtime: {
          tools: [
            "prepare_sandbox_workspace",
            "execute",
            "publish_artifact",
          ],
          output: {
            kind: "artifact",
            artifactType: "slides",
            publisherTool: "publish_artifact",
          },
        },
        command: {
          aliases: ["ppt"],
          category: "Artifacts",
        },
      },
    ],
  });

  assert.deepEqual(manifest.contributes.skills[0]?.runtime?.output, {
    kind: "artifact",
    artifactType: "slides",
    publisherTool: "publish_artifact",
  });
  assert.equal(manifest.contributes.skills[0]?.visibility, "restricted");
  assert.deepEqual(manifest.contributes.skills[0]?.categories, [
    "create",
    "present",
  ]);
  assert.deepEqual(manifest.contributes.skills[0]?.options[0]?.target, {
    path: "runtime.config.stylePreset",
  });
});

test("capability-manifest.command runtime rejects sandbox artifact success criteria", () => {
  assert.throws(
    () =>
      capabilityManifestSchema.parse({
        schemaVersion: 1,
        id: "sourceweft/legacy-ppt-deck",
        kind: "skill",
        name: "Legacy PPT Deck",
        version: "1.0.0",
        skills: [
          {
            id: "ppt-deck",
            visibility: "restricted",
            runtime: {
              execution: "agent",
              tools: ["prepare_sandbox_workspace", "execute"],
              output: { kind: "none" },
            },
            command: {
              workflow: {
                execution: "agent",
                successCriteria: {
                  kind: "sandbox_artifact",
                  artifactType: "slides",
                  manifestPath:
                    "/workspace/output/.sourceweft/artifacts/slides.json",
                },
              },
            },
          },
        ],
      }),
    /Invalid input/,
  );
});

test("capability-manifest.options reject unsafe target path segments", () => {
  assert.throws(
    () =>
      capabilityManifestSchema.parse({
        schemaVersion: 1,
        id: "sourceweft/generate-image",
        kind: "tool",
        name: "Generate Image",
        version: "0.1.0",
        tools: [
          {
            id: "generate_image",
            title: "Generate Image",
            description: "Generate an image artifact.",
            risk: "write",
            options: [
              {
                id: "polluted",
                title: "Polluted",
                valueType: "boolean",
                defaultValue: true,
                target: { path: "config.__proto__.enabled" },
                values: [],
              },
            ],
          },
        ],
      }),
    /unsafe segment/,
  );
});

test("capability-manifest.kind rejects mismatched top-level contributions", () => {
  const result = parseCapabilityManifest({
    schemaVersion: 1,
    id: "sourceweft/ppt-deck",
    kind: "skill",
    name: "PPT Deck",
    version: "1.0.0",
    tools: [
      {
        id: "publish_artifact",
        title: "Publish Artifact",
        description: "Publish artifacts.",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ["manifest.invalid"],
  );
});

test("capability-manifest.kind rejects mismatched legacy contributes", () => {
  const result = parseCapabilityManifest({
    schemaVersion: 1,
    id: "sourceweft/ppt-deck",
    kind: "skill",
    name: "PPT Deck",
    version: "1.0.0",
    contributes: {
      tools: [
        {
          id: "publish_artifact",
          title: "Publish Artifact",
          description: "Publish artifacts.",
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ["manifest.invalid"],
  );
});

test("capability-manifest.connector parses connector metadata contributions", () => {
  const manifest = capabilityManifestSchema.parse({
    schemaVersion: 1,
    id: "sourceweft/notion",
    kind: "connector",
    name: "Notion Connector",
    version: "0.1.0",
    connectors: [
      {
        id: "notion",
        title: "Notion",
        auth: {
          kind: "oauth2",
          authorizationUrl: "https://www.notion.so/install-integration",
          tokenUrl: "https://api.notion.com/v1/oauth/token",
          scopes: [],
          authorizationParams: {
            owner: "user",
          },
          sendScope: false,
        },
        sync: {
          supportsIncremental: true,
          defaultFrequencyMinutes: 360,
          resources: [
            {
              type: "notion_page",
              title: "Notion page",
              supportsDeleteDetection: false,
            },
          ],
        },
        actions: [
          {
            id: "notion.page.find",
            title: "Find Notion page",
            risk: "low",
            requiresApproval: false,
            visibility: "agent",
            capabilities: ["connector_read"],
            inputSchema: { type: "object" },
            agentToolName: "search_notion_pages",
          },
        ],
        configSchema: { type: "object" },
      },
    ],
  });

  assert.equal(manifest.kind, "connector");
  assert.equal(manifest.contributes.connectors[0]?.id, "notion");
  assert.equal(
    manifest.contributes.connectors[0]?.actions[0]?.agentToolName,
    "search_notion_pages",
  );
});

test("capability-manifest.connector rejects malformed connector metadata", () => {
  const result = parseCapabilityManifest({
    schemaVersion: 1,
    id: "sourceweft/notion",
    kind: "connector",
    name: "Notion Connector",
    version: "0.1.0",
    connectors: [
      {
        id: "notion",
        title: "Notion",
        auth: {
          kind: "oauth2",
          authorizationUrl: "",
          tokenUrl: "https://api.notion.com/v1/oauth/token",
        },
        sync: {
          supportsIncremental: true,
          defaultFrequencyMinutes: 0,
          resources: [{ type: "", title: "" }],
        },
        actions: [{ id: "", title: "", inputSchema: [] }],
        configSchema: [],
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ["manifest.invalid"],
  );
});

test("capability-manifest.invalid returns typed manifest diagnostics", () => {
  const result = parseCapabilityManifest({
    ...webSearchManifest,
    id: "web-search",
    kind: "unknown",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ["manifest.invalid"],
  );
});
