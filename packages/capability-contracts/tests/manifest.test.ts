import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_COMMAND_TOOL_POLICY_MAX_IDS,
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
          aliases: ["generate_image"],
          iconName: "image",
          iconTone: "mono",
          visibleWhen: "hidden",
        },
        runtime: {
          execution: "agent",
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
  assert.equal(manifest.contributes.tools[0]?.command?.visibleWhen, "hidden");
  assert.deepEqual(
    manifest.contributes.tools[0]?.options.map((option) => option.id),
    ["aspectRatio"],
  );
});

test("capability-manifest.runtime parses automatic entry and bounded allow/deny tool policy", () => {
  const manifest = capabilityManifestSchema.parse({
    ...webSearchManifest,
    id: "sourceweft/report-agent",
    kind: "skill",
    tools: undefined,
    skills: [
      {
        id: "report-agent",
        runtime: {
          execution: "agent",
          tools: ["write_todos", "publish_report"],
          initialToolPolicy: "auto",
          toolPolicy: {
            allow: ["write_todos", "publish_report"],
            deny: ["task", "execute"],
          },
          output: {
            kind: "artifact",
            artifactType: "report",
            publisherTool: "publish_report",
          },
        },
      },
    ],
  });

  const runtime = manifest.contributes.skills[0]?.runtime;
  assert.equal(runtime?.initialToolPolicy, "auto");
  assert.deepEqual(runtime?.toolPolicy, {
    allow: ["write_todos", "publish_report"],
    deny: ["task", "execute"],
  });
});

test("capability-manifest.command workflow parses an explicit forced initial tool", () => {
  const manifest = capabilityManifestSchema.parse({
    ...webSearchManifest,
    tools: [
      {
        ...webSearchManifest.tools[0],
        command: {
          aliases: ["web"],
          workflow: {
            execution: "agent",
            initialToolPolicy: {
              kind: "force",
              toolName: "web_search",
            },
            successCriteria: {
              kind: "tool_call",
              toolName: "web_search",
            },
          },
        },
      },
    ],
  });

  assert.deepEqual(
    manifest.contributes.tools[0]?.command?.workflow?.initialToolPolicy,
    { kind: "force", toolName: "web_search" },
  );
});

test("capability-manifest rejects a tool present in both allow and deny policy", () => {
  const result = capabilityManifestSchema.safeParse({
    ...webSearchManifest,
    tools: [
      {
        ...webSearchManifest.tools[0],
        runtime: {
          execution: "agent",
          toolPolicy: {
            allow: ["web_search"],
            deny: ["web_search"],
          },
        },
      },
    ],
  });

  assert.equal(result.success, false);
});

test("capability-manifest rejects a forced initial tool excluded by command policy", () => {
  const result = capabilityManifestSchema.safeParse({
    ...webSearchManifest,
    tools: [
      {
        ...webSearchManifest.tools[0],
        command: {
          workflow: {
            execution: "agent",
            initialToolPolicy: {
              kind: "force",
              toolName: "web_search",
            },
            toolPolicy: {
              allow: ["read_file"],
              deny: ["web_search"],
            },
            successCriteria: {
              kind: "tool_call",
              toolName: "web_search",
            },
          },
        },
      },
    ],
  });

  assert.equal(result.success, false);
});

test("capability-manifest bounds command tool policy ids", () => {
  const result = capabilityManifestSchema.safeParse({
    ...webSearchManifest,
    tools: [
      {
        ...webSearchManifest.tools[0],
        runtime: {
          execution: "agent",
          toolPolicy: {
            deny: Array.from(
              { length: CAPABILITY_COMMAND_TOOL_POLICY_MAX_IDS + 1 },
              (_, index) => `tool_${index}`,
            ),
          },
        },
      },
    ],
  });

  assert.equal(result.success, false);
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
        defaultEnabled: true,
        categories: ["create", "present"],
        options: [
          {
            id: "stylePreset",
            title: "Style",
            valueType: "string",
            defaultValue: "auto",
            target: {
              path: "config.stylePreset",
            },
            values: [{ value: "auto", label: "Auto" }],
          },
        ],
        runtime: {
          tools: ["prepare_sandbox_workspace", "execute", "publish_artifact"],
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
  assert.equal(manifest.contributes.skills[0]?.defaultEnabled, true);
  assert.deepEqual(manifest.contributes.skills[0]?.categories, [
    "create",
    "present",
  ]);
  assert.deepEqual(manifest.contributes.skills[0]?.options[0]?.target, {
    path: "config.stylePreset",
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
    // zod's discriminated-union message wording varies across versions;
    // the stable part is the rejected discriminator key.
    /discriminator|Invalid input/,
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

test("capability manifest ignores an unknown top-level contributes key", () => {
  // The legacy-input rejection guard was removed once every manifest had
  // migrated to top-level contribution arrays. A stray `contributes` object is
  // now stripped as an unknown key, and the normalized `contributes` is built
  // from the top-level arrays alone.
  const result = parseCapabilityManifest({
    ...webSearchManifest,
    contributes: {
      tools: [],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok ? result.manifest.contributes.tools.map((tool) => tool.id) : [],
    webSearchManifest.tools.map((tool) => tool.id),
  );
});

test("capability-manifest.pipeline parses a deliverable pipeline declaration", () => {
  const manifest = capabilityManifestSchema.parse({
    schemaVersion: 1,
    id: "sourceweft/report-builder",
    kind: "tool",
    name: "Report Builder",
    version: "1.0.0",
    entry: "./src/index.ts",
    tools: [
      {
        id: "publish_report",
        title: "Publish Report",
        description: "Generate and publish a report artifact.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        runtime: {
          execution: "agent",
          tools: ["publish_report"],
          output: {
            kind: "artifact",
            artifactType: "report",
            publisherTool: "publish_report",
          },
          pipeline: {
            jobName: "report-generate",
          },
        },
      },
    ],
  });

  const pipeline = manifest.contributes.tools[0]?.runtime?.pipeline;
  assert.equal(pipeline?.jobName, "report-generate");
  assert.equal(pipeline?.queue, "deliverables");
});

test("capability-manifest.pipeline rejects invalid job names", () => {
  const result = capabilityManifestSchema.safeParse({
    schemaVersion: 1,
    id: "sourceweft/bad-pipeline",
    kind: "tool",
    name: "Bad",
    version: "1.0.0",
    tools: [
      {
        id: "bad_tool",
        title: "Bad",
        description: "Bad pipeline job name.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        runtime: {
          pipeline: { jobName: "Not A Job Name" },
        },
      },
    ],
  });
  assert.equal(result.success, false);
});
