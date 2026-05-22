import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSkillCommands, publicSkillCommands } from "./commands";

test("parseSkillCommands derives canonical names from command files", () => {
  const commands = parseSkillCommands({
    skillSlug: "pm-data-analytics",
    files: [
      {
        path: "commands/write-query.md",
        contentText: `---
description: Write SQL from product analytics questions.
argument-hint: <analytics question>
tools: [web_search]
---
# Query writer

Use $ARGUMENTS to generate SQL.`,
        mimeType: "text/markdown",
        sizeBytes: 1,
        contentHash: "hash",
      },
    ],
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.canonicalName, "/pm-data-analytics:write-query");
  assert.equal(commands[0]?.name, "write-query");
  assert.equal(commands[0]?.argumentHint, "<analytics question>");
  assert.deepEqual(commands[0]?.tools, ["web_search"]);
  assert.match(commands[0]?.instruction ?? "", /Use \$ARGUMENTS/);
  assert.deepEqual(publicSkillCommands(commands), [
    {
      id: "pm-data-analytics:write-query",
      name: "write-query",
      canonicalName: "/pm-data-analytics:write-query",
      displayName: "Write Query",
      description: "Write SQL from product analytics questions.",
      path: "commands/write-query.md",
      argumentHint: "<analytics question>",
      skillSlugs: ["pm-data-analytics"],
      tools: ["web_search"],
    },
  ]);
});

test("parseSkillCommands maps nested command paths to dotted names", () => {
  const commands = parseSkillCommands({
    skillSlug: "pm-data-analytics",
    files: [
      {
        path: "commands/sql/write-query.md",
        contentText: "# Query writer",
        mimeType: "text/markdown",
        sizeBytes: 1,
        contentHash: "hash",
      },
    ],
  });

  assert.equal(
    commands[0]?.canonicalName,
    "/pm-data-analytics:sql.write-query",
  );
  assert.equal(commands[0]?.displayName, "Sql Write Query");
});

test("parseSkillCommands uses frontmatter title as display name", () => {
  const commands = parseSkillCommands({
    skillSlug: "pm-data-analytics",
    files: [
      {
        path: "commands/write-query.md",
        contentText: `---
title: Query Builder
---
# Query writer`,
        mimeType: "text/markdown",
        sizeBytes: 1,
        contentHash: "hash",
      },
    ],
  });

  assert.equal(commands[0]?.displayName, "Query Builder");
});
