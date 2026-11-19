import assert from "node:assert/strict";
import test from "node:test";
import { confluenceAgentToolDefs } from "../src/agent-tool-defs";

test("Confluence agent tool slash commands use the generic tool icon until Atlassian artwork is added", () => {
  assert.equal(confluenceAgentToolDefs.length, 3);
  assert.deepEqual(
    confluenceAgentToolDefs.map((def) => def.name),
    ["search_confluence", "read_confluence_page", "list_confluence_spaces"],
  );
  for (const def of confluenceAgentToolDefs) {
    assert.equal(def.slash?.iconName, "tool");
    assert.equal(def.slash?.iconTone, "mono");
  }
});
