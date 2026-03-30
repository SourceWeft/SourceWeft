import { describe, expect, it } from "vitest";
import { normalizeChatCompleteResponse } from "../../src/normalize/messages";

describe("normalizeChatCompleteResponse", () => {
  it("preserves reasoning and provider fields", () => {
    const result = normalizeChatCompleteResponse(
      {
        id: "chatcmpl-1",
        model: "chat-default",
        provider_specific_fields: {
          provider: "openrouter",
        },
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello from LiteLLM",
              reasoning_content: "Thinking details",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"location":"Shanghai"}',
                  },
                },
              ],
            },
          },
        ],
      },
      "chat-default",
    );

    expect(result.outputText).toBe("Hello from LiteLLM");
    expect(result.reasoning).toBe("Thinking details");
    expect(result.providerFields).toEqual({
      provider_specific_fields: {
        provider: "openrouter",
      },
    });
    expect(result.message.toolCalls?.[0]).toEqual({
      id: "call_1",
      name: "get_weather",
      args: {
        location: "Shanghai",
      },
      argsJson: '{"location":"Shanghai"}',
    });
  });
});
