import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import {
  buildCapabilityCommandList,
  buildCapabilityToolList,
  findCapabilityCommand,
  findCapabilityToolCommandWorkflow,
  type DiscoveredCapabilityRecord,
} from "../src/index";

const fixtureRecords = [
  {
    manifest: {
      schemaVersion: 1,
      id: "local/search",
      kind: "tool",
      name: "Search Fixture",
      version: "0.0.0",
      activation: { onStartup: false, autoEnableWhenConfigured: false },
      contributes: {
        commands: [],
        skills: [],
        tools: [
          {
            id: "search_docs",
            title: "Search Docs",
            description: "Search documents and return cited results.",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            risk: "read",
            options: [
              {
                id: "source",
                title: "Source",
                valueType: "string",
                defaultValue: "all",
                target: { path: "config.source" },
                values: [
                  { value: "all", label: "All" },
                  { value: "internal", label: "Internal" },
                ],
              },
            ],
            command: {
              aliases: ["search"],
              category: "Research",
            },
            runtime: {
              execution: "direct",
              promptIntro: "Search documents for the user's request.",
              tools: ["search_docs"],
              permissionOverrides: { search_docs: "allow" },
              output: {
                kind: "tool_call",
                toolName: "search_docs",
              },
            },
          },
        ],
        vfs: [],
        artifacts: [],
        retrieval: [],
        documentParsers: [],
        mcp: [],
        connectors: [],
      },
      configSchema: {},
    },
    rootDir: "/fixtures/search",
    manifestPath: "/fixtures/search/sourceweft.capability.json",
    packageName: "@sourceweft/search-fixture",
  },
  {
    manifest: {
      schemaVersion: 1,
      id: "local/report",
      kind: "composite",
      name: "Report Fixture",
      version: "0.0.0",
      activation: { onStartup: false, autoEnableWhenConfigured: false },
      contributes: {
        commands: [],
        skills: [
          {
            id: "report_writer",
            title: "Write Report",
            resources: [],
            command: {
              title: "Draft",
              aliases: ["report"],
              category: "Artifacts",
              iconName: "fixture-report",
              iconTone: "mono",
            },
            runtime: {
              execution: "agent",
              promptIntro: "Write a report and publish the final artifact.",
              tools: ["publish_report"],
              permissionOverrides: { publish_report: "allow" },
              output: {
                kind: "artifact",
                artifactType: "report",
                publisherTool: "publish_report",
              },
            },
          },
        ],
        tools: [
          {
            id: "publish_report",
            title: "Publish Report",
            description: "Publish the final report artifact.",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            risk: "write",
            options: [
              {
                id: "style",
                title: "Style",
                valueType: "string",
                defaultValue: "concise",
                target: { path: "config.style" },
                values: [
                  { value: "concise", label: "Concise" },
                  { value: "detailed", label: "Detailed" },
                ],
              },
              {
                id: "maxSections",
                title: "Max Sections",
                valueType: "number",
                defaultValue: 5,
                target: { path: "config.maxSections" },
                values: [],
              },
            ],
          },
        ],
        vfs: [],
        artifacts: [],
        retrieval: [],
        documentParsers: [],
        mcp: [],
        connectors: [],
      },
      configSchema: {},
    },
    rootDir: "/fixtures/report",
    manifestPath: "/fixtures/report/sourceweft.capability.json",
    packageName: "@sourceweft/report-fixture",
  },
  {
    manifest: {
      schemaVersion: 1,
      id: "local/meeting",
      kind: "skill",
      name: "Meeting Fixture",
      version: "0.0.0",
      activation: { onStartup: false, autoEnableWhenConfigured: false },
      contributes: {
        commands: [],
        skills: [
          {
            id: "meeting_notes",
            resources: [],
            command: {
              aliases: ["notes"],
              category: "Writing",
              visibleWhen: "enabled",
            },
          },
        ],
        tools: [],
        vfs: [],
        artifacts: [],
        retrieval: [],
        documentParsers: [],
        mcp: [],
        connectors: [],
      },
      configSchema: {},
    },
    rootDir: "/fixtures/meeting",
    manifestPath: "/fixtures/meeting/sourceweft.capability.json",
    packageName: "@sourceweft/meeting-fixture",
  },
  {
    manifest: {
      schemaVersion: 1,
      id: "local/disabled",
      kind: "skill",
      name: "Disabled Fixture",
      version: "0.0.0",
      activation: { onStartup: false, autoEnableWhenConfigured: false },
      contributes: {
        commands: [],
        skills: [
          {
            id: "disabled_skill",
            title: "Disabled Skill",
            resources: [],
            command: {
              title: "Disabled Skill",
              aliases: ["disabled"],
              visibleWhen: "enabled",
            },
          },
        ],
        tools: [],
        vfs: [],
        artifacts: [],
        retrieval: [],
        documentParsers: [],
        mcp: [],
        connectors: [],
      },
      configSchema: {},
    },
    rootDir: "/fixtures/disabled",
    manifestPath: "/fixtures/disabled/sourceweft.capability.json",
    packageName: "@sourceweft/disabled-fixture",
  },
] satisfies readonly (Omit<DiscoveredCapabilityRecord, "manifest"> & {
  readonly manifest: unknown;
})[];

const normalizedFixtureRecords = fixtureRecords.map((record) => ({
  ...record,
  manifest: capabilityManifestSchema.parse(record.manifest),
})) satisfies readonly DiscoveredCapabilityRecord[];

test("commands.manifest-contributions build generic command list", () => {
  const commands = buildCapabilityCommandList(normalizedFixtureRecords);

  assert.deepEqual(
    commands.map((command) => ({
      actionKind: command.action.kind,
      id: command.id,
      targetId: command.action.targetId,
    })),
    [
      {
        actionKind: "skill",
        id: "cap:local/disabled:disabled_skill",
        targetId: "disabled_skill",
      },
      {
        actionKind: "skill",
        id: "cap:local/meeting:meeting_notes",
        targetId: "meeting_notes",
      },
      {
        actionKind: "skill",
        id: "cap:local/report:report_writer",
        targetId: "report_writer",
      },
      {
        actionKind: "tool",
        id: "cap:local/search:search_docs",
        targetId: "search_docs",
      },
    ],
  );
  assert.equal(
    commands.some(
      (command) => command.id === "cap:local/report:publish_report",
    ),
    false,
    "tools without command metadata should not appear in the command list",
  );
});

test("commands.manifest-contributions preserve command icon metadata", () => {
  const commands = buildCapabilityCommandList(normalizedFixtureRecords);
  const command = commands.find(
    (candidate) => candidate.contributionId === "report_writer",
  );

  assert.equal(command?.iconName, "fixture-report");
  assert.equal(command?.iconTone, "mono");
});

test("commands.manifest-contributions include skill parent display metadata", () => {
  const commands = buildCapabilityCommandList(normalizedFixtureRecords);
  const report = commands.find(
    (candidate) => candidate.contributionId === "report_writer",
  );
  const meeting = commands.find(
    (candidate) => candidate.contributionId === "meeting_notes",
  );
  const search = commands.find(
    (candidate) => candidate.contributionId === "search_docs",
  );

  assert.equal(report?.parentKind, "skill");
  assert.equal(report?.parentTitle, "Write Report");
  assert.equal(report?.displayTitle, "Write Report / Draft");
  assert.equal(meeting?.parentKind, "skill");
  assert.equal(meeting?.parentTitle, "Meeting Fixture");
  assert.equal(meeting?.displayTitle, "Meeting Fixture");
  assert.equal(search?.parentKind, null);
  assert.equal(search?.parentTitle, null);
  assert.equal(search?.displayTitle, "Search Docs");
});

test("commands.config controls enablement aliases visibility and order", () => {
  const commands = buildCapabilityCommandList(normalizedFixtureRecords, {
    packages: {
      "local/disabled": {
        enabled: false,
      },
      "local/meeting": {
        order: 1,
        contributions: {
          meeting_notes: {
            aliases: ["minutes"],
            order: 1,
          },
        },
      },
      "local/search": {
        order: 10,
        contributions: {
          search_docs: {
            aliases: ["lookup"],
            order: 10,
            visibility: "hidden",
          },
        },
      },
      "local/report": {
        order: 20,
        contributions: {
          report_writer: { order: 20 },
        },
      },
    },
  });

  assert.deepEqual(
    commands.map((command) => command.id),
    [
      "cap:local/meeting:meeting_notes",
      "cap:local/search:search_docs",
      "cap:local/report:report_writer",
    ],
  );
  assert.deepEqual(commands[0]?.aliases, ["minutes"]);
  assert.equal(commands[1]?.visible, false);
  assert.deepEqual(commands[1]?.aliases, ["lookup"]);
});

test("commands.workflow resolves tool command workflows from manifests", () => {
  const searchWorkflow = findCapabilityToolCommandWorkflow(
    normalizedFixtureRecords,
    "search_docs",
  );
  assert.equal(searchWorkflow?.execution, "direct");
  assert.deepEqual(searchWorkflow?.defaultTools, ["search_docs"]);
  assert.deepEqual(searchWorkflow?.permissionOverrides, {
    search_docs: "allow",
  });
  assert.deepEqual(searchWorkflow?.successCriteria, {
    kind: "tool_call",
    toolName: "search_docs",
  });

  const publisherWorkflow = findCapabilityToolCommandWorkflow(
    normalizedFixtureRecords,
    "publish_report",
  );
  assert.equal(publisherWorkflow, null);
});

test("commands.workflow adds artifact publisher tools to runtime defaults", () => {
  const records: DiscoveredCapabilityRecord[] = structuredClone(
    normalizedFixtureRecords,
  );
  const reportSkill = records[1]?.manifest.contributes.skills[0];
  assert.ok(reportSkill?.runtime);
  reportSkill.runtime.tools = [];

  const reportCommand = findCapabilityCommand(records, "report");

  assert.deepEqual(reportCommand?.workflow?.defaultTools, ["publish_report"]);
  assert.deepEqual(reportCommand?.workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "report",
    toolName: "publish_report",
  });
});

test("tools.catalog exposes manifest options for contributed tools", () => {
  const tools = buildCapabilityToolList(normalizedFixtureRecords);

  const searchTool = tools.find((tool) => tool.toolName === "search_docs");
  assert.ok(searchTool, "expected search_docs in capability tool catalog");
  assert.deepEqual(
    searchTool.options.map((option) => option.id),
    ["source"],
  );
  assert.deepEqual(
    Object.fromEntries(
      searchTool.options.map((option) => [
        option.id,
        { defaultValue: option.defaultValue, path: option.target?.path },
      ]),
    ),
    {
      source: { defaultValue: "all", path: "config.source" },
    },
  );

  const publisher = tools.find((tool) => tool.toolName === "publish_report");
  assert.deepEqual(
    publisher?.options.map((option) => option.id),
    ["style", "maxSections"],
  );
});

test("commands.alias resolver finds capability skill and tool aliases", () => {
  const report = findCapabilityCommand(normalizedFixtureRecords, "/report");
  assert.equal(report?.action.kind, "skill");
  assert.equal(report?.action.targetId, "report_writer");

  const search = findCapabilityCommand(normalizedFixtureRecords, "search");
  assert.equal(search?.action.kind, "tool");
  assert.equal(search?.action.targetId, "search_docs");
});
