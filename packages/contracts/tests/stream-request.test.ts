import assert from "node:assert/strict";
import test from "node:test";
import { streamThreadRequestSchema } from "../src/stream";

/**
 * Tool keys are open-ended by design: `buildRuntimeTools` treats every
 * non-reserved key as a tool name, which is how connector and capability tools
 * — whose names are not known when this schema is written — reach the turn.
 * The schema must therefore preserve unknown keys rather than strip or reject
 * them. (The guard that used to reject the removed `webSearchEnabled` /
 * `artifact` keys was dropped once every client had migrated; such a key now
 * survives as an inert runtime-tool entry.)
 */
test("streamThreadRequestSchema preserves unknown tool keys", () => {
  const result = streamThreadRequestSchema.safeParse({
    mode: "send",
    content: "hello",
    tools: {
      search_notion_pages: { enabled: true, connectorId: "conn_1" },
      some_future_capability_tool: { enabled: true },
    },
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }
  assert.deepEqual(result.data.tools?.some_future_capability_tool, {
    enabled: true,
  });
});

test("streamThreadRequestSchema accepts canonical empty skillIds", () => {
  const result = streamThreadRequestSchema.safeParse({
    tools: { skillIds: [] },
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }
  assert.deepEqual(result.data.tools?.skillIds, []);
});

test("streamThreadRequestSchema accepts canonical tool selections across modes", () => {
  const tools = {
    skillIds: ["builtin:image-generate"],
    web_search: { enabled: true },
    generate_image: { enabled: true },
  };

  for (const mode of ["send", "edit", "refresh"] as const) {
    const result = streamThreadRequestSchema.safeParse({
      mode,
      ...(mode === "refresh" ? {} : { content: "hello" }),
      tools,
    });
    assert.equal(result.success, true, `expected ${mode} mode to accept tools`);
  }
});

test("streamThreadRequestSchema accepts canonical web_search selection", () => {
  const result = streamThreadRequestSchema.safeParse({
    tools: { web_search: { enabled: true } },
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }
  assert.deepEqual(result.data.tools?.web_search, { enabled: true });
});

test("streamThreadRequestSchema keeps catchall support for dynamic MCP tool keys", () => {
  const result = streamThreadRequestSchema.safeParse({
    tools: { mcp__github__create_issue: { enabled: true } },
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }
  assert.deepEqual(result.data.tools?.mcp__github__create_issue, {
    enabled: true,
  });
});
