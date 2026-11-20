import assert from "node:assert/strict";
import test from "node:test";
import { confluenceAgentToolDefs } from "../src/agent-tool-defs";

test("Confluence agent tool slash commands use the generic tool icon until Atlassian artwork is added", () => {
  assert.equal(confluenceAgentToolDefs.length, 3);
  assert.deepEqual(
    confluenceAgentToolDefs.map((def) => def.name),
    ["search_confluence", "read_confluence_page", "list_confluence_spaces"],
  );
  assert.deepEqual(
    confluenceAgentToolDefs.map((def) => def.id),
    ["searchConfluence", "readConfluencePage", "listConfluenceSpaces"],
  );
  assert.deepEqual(
    confluenceAgentToolDefs.map((def) => def.slash?.displayName),
    ["Search Confluence", "Read Confluence page", "List Confluence spaces"],
  );
  for (const def of confluenceAgentToolDefs) {
    assert.deepEqual(def.capabilities, [
      "connector",
      "confluence",
      "connector_read",
    ]);
    assert.equal(def.riskLevel, "low");
    assert.equal(def.defaultPermission, "allow");
    assert.equal(def.slash?.iconName, "tool");
    assert.equal(def.slash?.iconTone, "mono");
  }
});
