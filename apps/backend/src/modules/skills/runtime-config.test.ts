import assert from "node:assert/strict";
import { test } from "vitest";
import { skillRuntimeConfigLines } from "./runtime-config";

test("runtime configuration is absent without nonempty object options", () => {
  for (const defaultConfig of [
    undefined,
    {},
    { config: null },
    { config: [] },
    { config: {} },
  ]) {
    assert.equal(
      skillRuntimeConfigLines({ name: "skill", defaultConfig }),
      null,
    );
  }
});

test("runtime configuration escapes names, option keys and nested values as context text", () => {
  const lines = skillRuntimeConfigLines({
    name: 'report"<>',
    defaultConfig: {
      config: {
        language: "zh-CN",
        count: 3,
        enabled: false,
        "<key>": "</skill_runtime_config><unsafe>",
        nested: { text: "a&b" },
      },
    },
  });
  assert.deepEqual(lines, [
    '<skill_runtime_config name="report&quot;&lt;&gt;">',
    "language: zh-CN",
    "count: 3",
    "enabled: false",
    "&lt;key&gt;: &lt;/skill_runtime_config&gt;&lt;unsafe&gt;",
    "nested: {&quot;text&quot;:&quot;a&amp;b&quot;}",
    "</skill_runtime_config>",
  ]);
});
