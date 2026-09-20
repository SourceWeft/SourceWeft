import assert from "node:assert/strict";
import { test } from "vitest";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  buildPersonaDraft,
  buildPersonaPatch,
  derivePersonaSlug,
  filesystemPolicyOf,
  normalizeToolAllowlist,
  PERSONA_AVAILABLE_TOOLS,
  uniquePersonaSlug,
} from "./authoring";
import { findPersona } from "./registry";
import { READ_ONLY_BUSINESS_TOOL_NAMES } from "../subagents/read-only";
import { presentPersona } from "./present";

function code(error: unknown) {
  return (error as { code?: string }).code;
}

test("a clone of explore keeps its read-only stance and allowlist unless edited", () => {
  const explore = findPersona("explore");
  assert.ok(explore);
  const draft = buildPersonaDraft({ source: explore });
  assert.equal(draft.name, "Explore");
  assert.equal(draft.systemPrompt, explore.systemPrompt);
  assert.equal(draft.filesystemPolicy, "read_only");
  assert.deepEqual(draft.toolAllowlist, [...READ_ONLY_BUSINESS_TOOL_NAMES]);
  assert.ok(draft.toolAllowlist?.includes(AGENT_TOOL_NAMES.searchSources));
  assert.deepEqual(draft.modelSettings, {});

  const edited = buildPersonaDraft({
    source: explore,
    overrides: {
      name: "  Verifier ",
      toolAllowlist: null,
      filesystemPolicy: "default",
      modelSettings: { llmProfileAlias: " chat-fast ", llmModelAlias: "" },
    },
  });
  assert.equal(edited.name, "Verifier");
  assert.equal(edited.toolAllowlist, null);
  assert.equal(edited.filesystemPolicy, "default");
  assert.deepEqual(edited.modelSettings, { llmProfileAlias: "chat-fast" });
  assert.equal(filesystemPolicyOf(findPersona("general-purpose")!), "default");
});

test("edits are validated the same way a clone is", () => {
  const source = findPersona("general-purpose")!;
  assert.throws(
    () => buildPersonaDraft({ source, overrides: { name: "   " } }),
    (error) => code(error) === "PERSONA_INVALID",
  );
  assert.throws(
    () => buildPersonaDraft({ source, overrides: { systemPrompt: "" } }),
    (error) => code(error) === "PERSONA_INVALID",
  );
  assert.throws(
    () =>
      buildPersonaDraft({
        source,
        overrides: { toolAllowlist: ["search_sources", "rm_rf"] },
      }),
    (error) => code(error) === "PERSONA_TOOL_UNKNOWN",
  );
  assert.throws(
    () => buildPersonaPatch({ patch: {} }),
    (error) => code(error) === "PERSONA_INVALID",
  );
  assert.deepEqual(buildPersonaPatch({ patch: { description: " x " } }), {
    description: "x",
  });
});

test("tool allowlists are deduplicated and limited to the known business tools", () => {
  assert.ok(PERSONA_AVAILABLE_TOOLS.includes(AGENT_TOOL_NAMES.searchSources));
  assert.deepEqual(
    normalizeToolAllowlist([
      AGENT_TOOL_NAMES.searchSources,
      ` ${AGENT_TOOL_NAMES.searchSources} `,
      "",
    ]),
    [AGENT_TOOL_NAMES.searchSources],
  );
  assert.equal(normalizeToolAllowlist(null), null);
  assert.equal(normalizeToolAllowlist(undefined), null);
});

test("slugs are display-only, URL-safe, and unique per workspace", () => {
  assert.equal(derivePersonaSlug("  Proof Verifier #2 "), "proof-verifier-2");
  assert.equal(derivePersonaSlug("验证体"), "agent");
  assert.equal(uniquePersonaSlug("explore", []), "explore");
  assert.equal(
    uniquePersonaSlug("explore", ["explore", "explore-2"]),
    "explore-3",
  );
});

test("presentPersona flattens a spec to the wire shape for built-ins and rows alike", () => {
  const explore = presentPersona(findPersona("explore")!);
  assert.equal(explore.id, "explore");
  assert.equal(explore.filesystemPolicy, "read_only");
  assert.equal(explore.modelSettings, null);
  assert.equal(explore.clonedFrom, null);

  const custom = presentPersona({
    slug: "persona_1",
    name: "Verifier",
    description: "",
    systemPrompt: "Verify.",
    modelSettings: { llmProfileAlias: "chat-fast" },
    trust: "user",
    clonedFrom: "explore",
    createdBy: "user_1",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(custom.id, "persona_1");
  assert.equal(custom.trust, "user");
  assert.equal(custom.filesystemPolicy, "default");
  assert.deepEqual(custom.modelSettings, { llmProfileAlias: "chat-fast" });
  assert.equal(custom.toolAllowlist, null);
  assert.equal(custom.clonedFrom, "explore");
});
