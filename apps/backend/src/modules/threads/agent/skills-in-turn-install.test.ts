import assert from "node:assert/strict";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { Command, MemorySaver, Overwrite } from "@langchain/langgraph";
import { CompositeBackend, StateBackend, createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { test } from "vitest";
import { z } from "zod";
import { SelectedSkillsBackend } from "../../skills/backend";
import { inlineSkillContent } from "../../skills/file-content";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { skillMetadataForTurn } from "./turn/turn-assembly";

// A skill mounted by a tool call must be readable by the NEXT tool call of the
// same agent run — that is what lets `install_skill` be followed by use within
// one turn. Runs the installed deepagents with a scripted model; no network.
//
// It also pins a deepagents behaviour we rely on knowing: the available-skills
// list in the prompt only picks up the new skill mid-run when the run started
// with none (the middleware caches a non-empty list per run), which is why the
// install result hands the model the path instead of pointing at that list.

function skill(name: string): EnabledSkillDescriptor {
  const description = `${name} unique instructions`;
  const markdown = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nBODY-OF-${name}`;
  return {
    workspaceSkillId: `workspace-${name}`,
    sourceType: "workspace_custom",
    name,
    version: "1.0.0",
    description,
    ...inlineSkillContent([
      {
        path: "SKILL.md",
        contentText: markdown,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(markdown),
        contentHash: `hash-${name}`,
      },
    ]),
  };
}

class ScriptedModel extends BaseChatModel {
  prompts: string[] = [];
  step = 0;

  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "scripted";
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
    this.step += 1;
    const message =
      this.step === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              { id: "call-install", name: "install_skill", args: {} },
            ],
          })
        : this.step === 2
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "call-read",
                  name: "read_file",
                  args: { file_path: "/skills/new-skill/SKILL.md" },
                },
              ],
            })
          : new AIMessage("done");
    return { generations: [{ text: String(message.content), message }] };
  }
}

async function run(initial: EnabledSkillDescriptor[]) {
  const model = new ScriptedModel();
  const skillsBackend = new SelectedSkillsBackend([...initial]);
  const installed = skill("new-skill");
  const installSkill = tool(
    async (_input, runtime) => {
      skillsBackend.addSkill(installed);
      return new Command({
        update: {
          skillsMetadata: skillMetadataForTurn([installed]),
          messages: [
            new ToolMessage({
              content: "Installed new-skill. Read /skills/new-skill/SKILL.md.",
              tool_call_id: runtime.toolCall?.id ?? "call-install",
            }),
          ],
        },
      });
    },
    { name: "install_skill", description: "install", schema: z.object({}) },
  );
  const agent = createDeepAgent({
    model: model as never,
    tools: [installSkill],
    backend: new CompositeBackend(new StateBackend(), {
      "/skills/": skillsBackend,
    }),
    checkpointer: new MemorySaver(),
    skills: ["/skills/"],
  });
  const config = { configurable: { thread_id: `spike-${initial.length}` } };
  const effective = await agent.updateState(config, {
    skillsMetadata: new Overwrite(skillMetadataForTurn(initial)),
  });
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "install and use new-skill" }] },
    effective,
  );
  const readResult = (result.messages as BaseMessage[]).find(
    (message) =>
      message.getType() === "tool" &&
      (message as ToolMessage).tool_call_id === "call-read",
  );
  return {
    prompts: model.prompts,
    readResult: JSON.stringify(readResult?.content ?? null),
  };
}

for (const [label, initial] of [
  ["workspace had no skills at turn start", []],
  ["workspace already had a skill at turn start", [skill("old-skill")]],
] as const) {
  test(`in-turn install — ${label}`, async () => {
    const { prompts, readResult } = await run([...initial]);
    assert.ok(
      readResult.includes("BODY-OF-new-skill"),
      readResult.slice(0, 300),
    );
    assert.equal(prompts[0]?.includes("new-skill unique instructions"), false);
    assert.equal(
      prompts[1]?.includes("new-skill unique instructions"),
      initial.length === 0,
    );
  });
}
