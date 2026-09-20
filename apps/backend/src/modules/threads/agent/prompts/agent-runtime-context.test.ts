import assert from "node:assert/strict";
import { test } from "vitest";
import { buildAgentRuntimeContext } from "./agent-runtime-context";

// The catalog rule costs tokens and changes behaviour, so it appears only when
// the turn can actually act on it.
test("the skill catalog rule is present only when the catalog tools are bound", () => {
  const without = buildAgentRuntimeContext({ timezone: "UTC" });
  assert.equal(without.includes("<skill_catalog>"), false);

  const withCatalog = buildAgentRuntimeContext({
    timezone: "UTC",
    skillCatalogAvailable: true,
  });
  assert.match(
    withCatalog,
    /<skill_catalog>[\s\S]*search_skills[\s\S]*install_skill[\s\S]*<\/skill_catalog>/,
  );
  // Measured live: without an explicit carve-out the alternative failure is a
  // search on every turn.
  assert.match(withCatalog, /Do NOT search for ordinary questions/);
});
