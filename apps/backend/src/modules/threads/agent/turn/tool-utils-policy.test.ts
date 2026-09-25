import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { filterInheritableAgentTools, shouldBindAgentTool } from "./tool-utils";

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

describe("from runner.test.ts", () => {
  test("skill commands bind workflow default artifact tools", () => {
    const prepared = {
      command: {
        kind: "skill",
        workflow: {
          defaultTools: [
            "prepare_sandbox_workspace",
            "execute",
            "publish_artifact",
          ],
        },
      },
    } as unknown as Parameters<typeof shouldBindAgentTool>[0]["prepared"];

    assert.equal(
      shouldBindAgentTool({
        prepared,
        toolName: "publish_artifact",
      }),
      true,
    );
    assert.equal(
      shouldBindAgentTool({
        prepared,
        toolName: "unselected_tool",
      }),
      false,
    );
  });

  test("non-command active skill turns bind runtime-selected artifact tools", () => {
    const prepared = {
      command: null,
      runtimeTools: {
        publish_artifact: {
          shouldBind: true,
        },
        unselected_tool: {
          shouldBind: false,
        },
      },
    } as unknown as Parameters<typeof shouldBindAgentTool>[0]["prepared"];

    assert.equal(
      shouldBindAgentTool({
        prepared,
        toolName: "publish_artifact",
      }),
      true,
    );
    assert.equal(
      shouldBindAgentTool({
        prepared,
        toolName: "unselected_tool",
      }),
      false,
    );
  });
});
