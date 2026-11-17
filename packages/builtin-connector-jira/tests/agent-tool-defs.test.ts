import assert from "node:assert/strict";
import test from "node:test";
import { jiraAgentToolDefs } from "../src/agent-tool-defs";

test("Jira agent tool slash commands use the generic tool icon until Jira artwork is added (R13/C3)", () => {
  assert.equal(jiraAgentToolDefs.length, 3);
  for (const def of jiraAgentToolDefs) {
    assert.equal(def.slash?.iconName, "tool");
    assert.equal(def.slash?.iconTone, "mono");
  }
});
