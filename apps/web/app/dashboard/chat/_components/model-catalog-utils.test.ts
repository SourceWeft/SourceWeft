import assert from "node:assert/strict";
import { test } from "vitest";
import {
  catalogProviderLabel,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
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

function catalogEntry(
  profileAlias: string,
  availableViaGlobal: boolean | undefined,
) {
  return {
    profileAlias,
    modelAlias: profileAlias,
    displayName: profileAlias,
    subtitle: profileAlias,
    badges: [],
    providerName: "provider",
    availableViaGlobal,
  };
}

test("system models unavailable for global traffic are not offered", () => {
  const t = ((key: string) => key) as never;
  const catalog = mapCatalogKindsToModelItems(
    {
      llm: [
        catalogEntry("chat-default", true),
        catalogEntry("disabled-provider-model", false),
        catalogEntry("unreported-availability", undefined),
      ],
      image: [catalogEntry("disabled-image-model", false)],
      vision: [],
    },
    t,
  );

  assert.deepEqual(
    catalog.llm.map((model) => model.profileAlias),
    ["chat-default", "unreported-availability"],
  );
  assert.deepEqual(catalog.image, []);
});

test("a thread that stored an unavailable model resolves to the catalog default", () => {
  const t = ((key: string) => key) as never;
  const availableModels = mapCatalogKindsToModelItems(
    {
      llm: [
        catalogEntry("ready-model", true),
        catalogEntry("chat-default", true),
        catalogEntry("disabled-provider-model", false),
      ],
      image: [],
      vision: [],
    },
    t,
  );

  const selected = resolveSelectedModels({
    availableModels,
    threadAliases: {
      llmProfileAlias: "disabled-provider-model",
      llmModelAlias: "disabled-provider-model",
    },
    fallbackAliases: {
      llmProfileAlias: "chat-default",
      llmModelAlias: "chat-default",
    },
  });

  assert.equal(selected.llm?.profileAlias, "chat-default");
});
