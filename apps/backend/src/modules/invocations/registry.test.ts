import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  createSelectableInvocationRegistry,
  type SelectableInvocationDefinitionWithAlias,
  type SelectableInvocationProvider,
} from "./registry";

function definition(
  input: Partial<SelectableInvocationDefinitionWithAlias> & { id: string },
): SelectableInvocationDefinitionWithAlias {
  return {
    label: input.id,
    sourceRef: {
      kind: "capability_tool",
      capabilityId: `sourceweft/${input.id}`,
      contributionId: input.id,
      sourcePackageName: null,
      toolName: input.id,
    },
    semantics: {
      kind: "fixed_tool_choice",
      target: "capability_tool",
      toolName: input.id,
    },
    enabled: true,
    ...input,
  };
}

function provider(input: {
  id: string;
  enabled?: boolean;
  definitions: SelectableInvocationDefinitionWithAlias[];
}): SelectableInvocationProvider {
  return {
    id: input.id,
    enabled: input.enabled ?? true,
    list: vi.fn(() => input.definitions),
  };
}

test("registry lists definitions from enabled providers without execution", () => {
  const fakeProvider = provider({
    id: "fake",
    definitions: [definition({ id: "builtin.generate_image", slashAlias: "/image" })],
  });
  const executionAdapter = vi.fn();

  const registry = createSelectableInvocationRegistry({ providers: [fakeProvider] });
  const definitions = registry.list();

  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.id, "builtin.generate_image");
  assert.equal(executionAdapter.mock.calls.length, 0);
});

test("registry rejects duplicate selectable ids deterministically", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [
      provider({ id: "one", definitions: [definition({ id: "duplicate" })] }),
      provider({ id: "two", definitions: [definition({ id: "duplicate" })] }),
    ],
  });

  assert.throws(() => registry.list(), /Duplicate selectable invocation id: duplicate/);
});

test("registry excludes disabled providers and consistently resolves unavailable definitions", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [
      provider({
        id: "enabled",
        definitions: [
          definition({ id: "enabled.tool" }),
          definition({
            id: "enabled.unavailable",
            enabled: false,
            unavailableReason: "Missing credentials",
          }),
        ],
      }),
      provider({
        id: "disabled",
        enabled: false,
        definitions: [definition({ id: "disabled.tool" })],
      }),
    ],
  });

  const definitions = registry.list();
  assert.deepEqual(
    definitions.map((item) => item.id),
    ["enabled.tool", "enabled.unavailable"],
  );
  assert.equal(registry.resolve("disabled.tool"), null);
  assert.equal(registry.resolve("enabled.unavailable")?.enabled, false);
  assert.equal(
    registry.resolve("enabled.unavailable")?.unavailableReason,
    "Missing credentials",
  );
});

test("registry resolves slash aliases through backend-owned alias map", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [
      provider({
        id: "skills",
        definitions: [definition({ id: "skill.research.summarize", slashAlias: "/summarize" })],
      }),
    ],
  });

  assert.equal(registry.resolveAlias("/summarize")?.id, "skill.research.summarize");
  assert.equal(registry.resolveAlias("summarize")?.id, "skill.research.summarize");
});
