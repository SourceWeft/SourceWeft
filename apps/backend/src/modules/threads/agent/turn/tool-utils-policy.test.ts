import assert from "node:assert/strict";
import { test } from "vitest";
import { filterInheritableAgentTools } from "./tool-utils";

test("root-only capability tools are removed from child Agent toolsets", () => {
  const tools = [
    { name: "publish_video_presentation" },
    { name: "validate_video_presentation" },
    { name: "custom_read_tool" },
  ];

  assert.deepEqual(
    filterInheritableAgentTools(tools).map((tool) => tool.name),
    ["custom_read_tool"],
  );
});
