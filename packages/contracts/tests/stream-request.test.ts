import assert from "node:assert/strict";
import test from "node:test";
import { streamThreadRequestSchema } from "../src/content";

const legacyToolCases = [
  {
    name: "webSearchEnabled",
    tools: { webSearchEnabled: true },
    expectedAlias: "web_search.enabled",
  },
  {
    name: "artifact",
    tools: { artifact: { kind: "image" } },
    expectedAlias: "generate_image",
  },
] as const;

for (const legacyCase of legacyToolCases) {
  for (const mode of ["send", "edit", "refresh"] as const) {
    test(`streamThreadRequestSchema rejects legacy ${legacyCase.name} for ${mode} mode`, () => {
      const result = streamThreadRequestSchema.safeParse({
        mode,
        ...(mode === "refresh" ? {} : { content: "hello" }),
        tools: legacyCase.tools,
      });

      assert.equal(result.success, false);
      if (result.success) {
        return;
      }
      if (mode === "send") {
        assert.match(
          result.error.issues.map((issue) => issue.message).join("\n"),
          new RegExp(legacyCase.expectedAlias.replaceAll(".", "\\."), "u"),
        );
      }
    });
  }
}

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
