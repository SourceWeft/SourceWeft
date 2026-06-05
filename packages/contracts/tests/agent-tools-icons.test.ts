import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TOOL_NAMES, getAgentToolSlashCommand } from "../src/agent-tools";

test("artifact tools expose global slash icon names", () => {
  assert.equal(
    getAgentToolSlashCommand(AGENT_TOOL_NAMES.generateImage)?.iconName,
    "image",
  );
  assert.equal(
    getAgentToolSlashCommand(AGENT_TOOL_NAMES.generatePptx)?.iconName,
    "presentation",
  );
  assert.equal(
    getAgentToolSlashCommand(AGENT_TOOL_NAMES.generateVideoPresentation)
      ?.iconName,
    "video-presentation",
  );
});

test("notion connector tools expose global brand icon metadata", () => {
  const slash = getAgentToolSlashCommand(AGENT_TOOL_NAMES.searchNotionPages);
  assert.equal(slash?.iconName, "notion");
  assert.equal(slash?.iconTone, "brand");
  assert.match(slash?.description ?? "", /non-empty search query/);
});
