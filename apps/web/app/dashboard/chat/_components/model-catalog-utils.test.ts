import assert from "node:assert/strict";
import { test } from "vitest";
import {
  catalogProviderLabel,
  mapCatalogKindsToModelItems,
} from "./model-catalog-utils";

test("catalog labels use configured names while preserving model identifiers", () => {
  const t = ((key: string) => key) as never;
  const catalog = mapCatalogKindsToModelItems(
    {
      llm: [
        {
          profileAlias: "global-openrouter-chat-openai-gpt-6-luna",
          modelAlias: "openai/gpt-6-luna",
          displayName: "GPT 6 Luna",
          subtitle: "openai/gpt-6-luna",
          badges: [],
          providerName: "openrouter",
          providerDisplayName: "OpenRouter",
          targetModel: "openai/gpt-6-luna",
        },
      ],
      image: [],
      vision: [],
    },
    t,
  );

  assert.equal(catalog.llm[0]?.chef, "OpenRouter");
  assert.equal(catalog.llm[0]?.name, "GPT 6 Luna");
  assert.equal(catalog.llm[0]?.modelAlias, "openai/gpt-6-luna");
  assert.equal(catalog.llm[0]?.subtitle, "openai/gpt-6-luna");
});

test("catalog provider label falls back when no configured name exists", () => {
  assert.equal(catalogProviderLabel(null, "openrouter"), "Openrouter");
  assert.equal(catalogProviderLabel("  ", "openrouter"), "Openrouter");
});
