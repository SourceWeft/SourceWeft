import { describe, expect, it } from "vitest";

import {
  extractReport,
  getDelegateChipTitle,
} from "./delegate-tool-card-state";

describe("getDelegateChipTitle", () => {
  it("takes the first sentence of the brief (Chinese)", () => {
    expect(getDelegateChipTitle("验证等式 1+1=2。请用直接计算验证。")).toBe(
      "验证等式 1+1=2。",
    );
  });

  it("takes the first sentence of the brief (English)", () => {
    expect(getDelegateChipTitle("Verify 1+2=3. Use any available tools.")).toBe(
      "Verify 1+2=3.",
    );
  });

  it("uses the first non-empty line when there is no sentence break", () => {
    expect(getDelegateChipTitle("\n\nResearch the topic\nmore detail")).toBe(
      "Research the topic",
    );
  });

  it("caps very long titles with an ellipsis", () => {
    const title = getDelegateChipTitle("x".repeat(80));
    expect(title?.endsWith("…")).toBe(true);
    expect((title ?? "").length).toBeLessThanOrEqual(49);
  });

  it("returns null for an empty brief", () => {
    expect(getDelegateChipTitle("   \n  ")).toBeNull();
  });
});

describe("extractReport", () => {
  it("unwraps the clean markdown report from a serialized LangGraph Command", () => {
    // Shape deepagents' `task` tool produces: a Command whose single overriding
    // ToolMessage carries the report prose under kwargs.content.
    const content = "## 验证报告：等式 1 + 1 = 2\n\n**结论**：✅ **成立**";
    const output = {
      goto: [],
      update: {
        files: {},
        messages: [
          {
            id: ["langchain_core", "messages", "ToolMessage"],
            lc: 1,
            type: "constructor",
            kwargs: {
              name: "task",
              content,
              tool_call_id: "call_00_x",
              additional_kwargs: {},
              response_metadata: {},
            },
          },
        ],
        threadToolCallCount: { __all__: 4 },
      },
      lg_name: "Command",
    };

    expect(extractReport(output)).toBe(content);
  });

  it("joins array-form message content blocks", () => {
    const output = {
      update: {
        messages: [
          {
            kwargs: {
              content: [
                { type: "text", text: "part one " },
                { type: "text", text: "part two" },
              ],
            },
          },
        ],
      },
    };

    expect(extractReport(output)).toBe("part one part two");
  });

  it("reads content mirrored under lc_kwargs", () => {
    const output = {
      update: { messages: [{ lc_kwargs: { content: "mirrored" } }] },
    };

    expect(extractReport(output)).toBe("mirrored");
  });

  it("takes the last message when several are present", () => {
    const output = {
      update: {
        messages: [
          { kwargs: { content: "first" } },
          { kwargs: { content: "last" } },
        ],
      },
    };

    expect(extractReport(output)).toBe("last");
  });

  it("returns a plain string report unchanged (no-tool-call fallback path)", () => {
    expect(extractReport("plain report")).toBe("plain report");
  });

  it("keeps the legacy {summary} shape", () => {
    expect(extractReport({ summary: "short summary" })).toBe("short summary");
  });

  it("returns null instead of dumping the wrapper for an unrecognized object", () => {
    expect(extractReport({ foo: "bar" })).toBeNull();
  });

  it("tolerates an error/partial result without leaking JSON", () => {
    expect(extractReport({ update: { messages: [] } })).toBeNull();
    expect(extractReport({ update: {} })).toBeNull();
    expect(extractReport(null)).toBeNull();
  });

  it("returns null for empty content rather than an empty string", () => {
    const output = { update: { messages: [{ kwargs: { content: "" } }] } };
    expect(extractReport(output)).toBeNull();
  });
});
