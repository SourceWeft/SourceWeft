import assert from "node:assert/strict";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver, Overwrite } from "@langchain/langgraph";
import { CompositeBackend, StateBackend, createDeepAgent } from "deepagents";
import { test } from "vitest";
import { SelectedSkillsBackend } from "../../skills/backend";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { skillMetadataForTurn } from "./turn/turn-assembly";

class SkillPromptCaptureModel extends BaseChatModel {
  prompts: string[] = [];

  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }

  _llmType() {
    return "skill-prompt-capture";
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.prompts.push(
      messages
        .filter((message) => message.getType() === "system")
        .map((message) => String(message.content))
        .join("\n"),
    );
    const message = new AIMessage("done");
    return { generations: [{ text: "done", message }] };
  }
}

function selectedSkill(name: string): EnabledSkillDescriptor {
  const description = `${name} unique turn-scoped instructions`;
  const markdown = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}`;
  return {
    workspaceSkillId: `workspace-${name}`,
    sourceType: "workspace_custom",
    name,
    version: "1.0.0",
    description,
    files: [
      {
        path: "SKILL.md",
        contentText: markdown,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(markdown),
        contentHash: `hash-${name}`,
      },
    ],
  };
}

test("skills metadata is overwritten per turn on a reused checkpoint", async () => {
  const model = new SkillPromptCaptureModel();
  const checkpointer = new MemorySaver();
  const config = { configurable: { thread_id: "skills-metadata-reuse" } };

  const invoke = async (skills: EnabledSkillDescriptor[]) => {
    const backend = new CompositeBackend(new StateBackend(), {
      "/skills/": new SelectedSkillsBackend(skills),
    });
    const agent = createDeepAgent({
      model: model as never,
      backend,
      checkpointer,
      ...(skills.length > 0 ? { skills: ["/skills/"] } : {}),
    });
    const effectiveConfig =
      skills.length > 0
        ? await agent.updateState(config, {
            skillsMetadata: new Overwrite(skillMetadataForTurn(skills)),
          })
        : config;
    await agent.invoke(
      {
        messages: [
          { role: "user", content: `use ${skills[0]?.name ?? "none"}` },
        ],
      },
      effectiveConfig,
    );
    return model.prompts.at(-1) ?? "";
  };

  const alpha = selectedSkill("alpha-skill");
  const beta = selectedSkill("beta-skill");
  const alphaPrompt = await invoke([alpha]);
  const betaPrompt = await invoke([beta]);
  const noSkillPrompt = await invoke([]);
  const alphaAgainPrompt = await invoke([alpha]);

  assert.ok(alphaPrompt.includes(alpha.description));
  assert.ok(!alphaPrompt.includes(beta.description));
  assert.ok(betaPrompt.includes(beta.description));
  assert.ok(!betaPrompt.includes(alpha.description));
  assert.ok(!noSkillPrompt.includes(alpha.description));
  assert.ok(!noSkillPrompt.includes(beta.description));
  assert.ok(alphaAgainPrompt.includes(alpha.description));
  assert.ok(!alphaAgainPrompt.includes(beta.description));
});
