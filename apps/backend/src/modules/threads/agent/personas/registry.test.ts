import assert from "node:assert/strict";
import { test } from "vitest";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { BUILTIN_PERSONAS } from "./builtin";
import { READ_ONLY_BUSINESS_TOOL_NAMES } from "../subagents/read-only";
import {
  applyPersonaToolAllowlist,
  filterToolsForPersona,
  findPersona,
  listPersonas,
} from "./registry";

test("built-in roster mirrors the three task delegates and is read-only", () => {
  const slugs = BUILTIN_PERSONAS.map((persona) => persona.slug);
  assert.deepEqual(slugs, ["general-purpose", "explore", "plan"]);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const persona of BUILTIN_PERSONAS) {
    assert.equal(persona.trust, "system");
    assert.ok(persona.name.length > 0);
    assert.ok(persona.description.length > 0);
    assert.ok(persona.systemPrompt.length > 0);
  }
});

test("listPersonas returns a copy so callers cannot mutate the roster", () => {
  const first = listPersonas();
  first.pop();
  assert.equal(listPersonas().length, BUILTIN_PERSONAS.length);
});

test("findPersona resolves by slug and tolerates blanks", () => {
  assert.equal(findPersona("explore")?.slug, "explore");
  assert.equal(findPersona(" plan ")?.slug, "plan");
  assert.equal(findPersona("nope"), null);
  assert.equal(findPersona(null), null);
  assert.equal(findPersona(""), null);
});

test("read-scoped personas allow only the read-only business tools", () => {
  const explore = findPersona("explore");
  assert.deepEqual(explore?.toolAllowlist, [...READ_ONLY_BUSINESS_TOOL_NAMES]);
  assert.ok(explore?.toolAllowlist?.includes(AGENT_TOOL_NAMES.searchSources));
  assert.ok(explore?.filesystemPermissions?.length);
  assert.equal(findPersona("general-purpose")?.toolAllowlist, undefined);
});

test("applyPersonaToolAllowlist denies every known tool outside the allowlist", () => {
  const explore = findPersona("explore");
  const narrowed = applyPersonaToolAllowlist(
    {
      [AGENT_TOOL_NAMES.searchSources]: "allow",
      [AGENT_TOOL_NAMES.webSearch]: "allow",
      "connector.notion.create_page": "ask",
    },
    explore,
  );
  assert.equal(narrowed[AGENT_TOOL_NAMES.searchSources], "allow");
  assert.equal(narrowed[AGENT_TOOL_NAMES.webSearch], "deny");
  assert.equal(narrowed[AGENT_TOOL_NAMES.generateImage], "deny");
  assert.equal(narrowed["connector.notion.create_page"], "deny");
});

test("applyPersonaToolAllowlist is a no-op without a persona or an allowlist", () => {
  const permissions = { [AGENT_TOOL_NAMES.webSearch]: "allow" as const };
  assert.equal(applyPersonaToolAllowlist(permissions, null), permissions);
  assert.equal(
    applyPersonaToolAllowlist(permissions, findPersona("general-purpose")),
    permissions,
  );
});

test("filterToolsForPersona keeps only allowlisted bound tools", () => {
  const tools = [
    { name: AGENT_TOOL_NAMES.searchSources },
    { name: "mcp__github__search" },
    { name: "execute" },
  ];
  assert.deepEqual(
    filterToolsForPersona(findPersona("plan"), tools).map((tool) => tool.name),
    [AGENT_TOOL_NAMES.searchSources],
  );
  assert.equal(filterToolsForPersona(null, tools).length, 3);
});
