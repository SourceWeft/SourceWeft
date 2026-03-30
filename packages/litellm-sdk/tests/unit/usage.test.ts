import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../../src/normalize/usage";

describe("normalizeUsage", () => {
  it("maps prompt/completion/total tokens", () => {
    const usage = normalizeUsage({
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
    });

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
  });

  it("maps cached token details", () => {
    const usage = normalizeUsage({
      input_tokens: 50,
      output_tokens: 10,
      total_tokens: 60,
      input_tokens_details: {
        cached_tokens: 30,
        cache_creation_tokens: 5,
      },
    });

    expect(usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    });
  });
});
