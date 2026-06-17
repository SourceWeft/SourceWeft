import assert from "node:assert/strict";
import { test } from "vitest";
import { withOpenRouterAttributionHeaders } from "./runtime";

test("withOpenRouterAttributionHeaders adds current and legacy OpenRouter attribution headers", () => {
  const headers = withOpenRouterAttributionHeaders({
    providerKind: "openrouter",
    defaultHeaders: {
      "X-Custom": "keep",
    },
  });

  assert.equal(headers["X-Custom"], "keep");
  assert.equal(headers["X-OpenRouter-Title"], "SourceWeft");
  assert.equal(headers["X-Title"], "SourceWeft");
  assert.equal(headers["HTTP-Referer"], "https://sourceweft.com");
});

test("withOpenRouterAttributionHeaders leaves non-OpenRouter headers unchanged", () => {
  const headers = withOpenRouterAttributionHeaders({
    providerKind: "openai-compatible",
    defaultHeaders: {
      "X-Custom": "keep",
    },
  });

  assert.deepEqual(headers, {
    "X-Custom": "keep",
  });
});
