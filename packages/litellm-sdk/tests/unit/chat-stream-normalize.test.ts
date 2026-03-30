import { describe, expect, it } from "vitest";
import { normalizeChatStreamChunk } from "../../src/normalize/messages";

describe("normalizeChatStreamChunk", () => {
  it("preserves usage-only chunks without token deltas", () => {
    const chunk = normalizeChatStreamChunk({
      id: "chatcmpl-1",
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 15,
        total_tokens: 115,
      },
    });

    expect(chunk.token).toBeUndefined();
    expect(chunk.usage).toEqual({
      inputTokens: 100,
      outputTokens: 15,
      totalTokens: 115,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
  });
});
