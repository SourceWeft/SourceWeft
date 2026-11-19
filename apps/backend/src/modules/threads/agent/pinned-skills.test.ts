import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { CompositeBackend, StateBackend, createDeepAgent } from "deepagents";
import { test } from "vitest";
import { ScriptedChatModel } from "../../../test/chat-model";
import { SelectedSkillsBackend } from "../../skills/backend";
import { inlineSkillContent } from "../../skills/file-content";
import type { EnabledSkillDescriptor } from "../../skills/types";
import {
  fallbackSourceWeftMessagesToRecentWindow,
  resolveSourceWeftContextCompressionBudget,
} from "./middleware/context-compression";
import {
  isPinnedSkillMessage,
  isUserRequestMessage,
} from "./middleware/pinned-skill-message";
import { buildAgentStepSummaryInput } from "./middleware/step-budget";
import {
  pinnedSkillNamesForTurn,
  skillMetadataForTurn,
} from "./turn/turn-assembly";
import {
  adaptMessagesEvent,
  createAssistantMessageFilter,
} from "./turn/v3-protocol";

function selectedSkill(name: string): EnabledSkillDescriptor {
  const description = `${name} description`;
  const markdown = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBODY-OF-${name}`;
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

/** The pinned message Deep Agents writes, as the skills middleware tags it. */
function pinnedSkillMessage(name: string) {
  return new HumanMessage({
    content: `<skill name="${name}" path="/skills/${name}/SKILL.md">\nbody\n</skill>`,
    additional_kwargs: {
      lc_source: "pinned_skill",
      skill: { name, path: `/skills/${name}/SKILL.md`, description: name },
    },
  });
}

test("only invoked skills are pinned, by name", () => {
  const alpha = selectedSkill("alpha-skill");
  const beta = selectedSkill("beta-skill");
  assert.deepEqual(
    pinnedSkillNamesForTurn({
      enabledSkills: [alpha, beta],
      invokedSkillIds: [beta.workspaceSkillId],
    }),
    ["beta-skill"],
  );
  assert.deepEqual(
    pinnedSkillNamesForTurn({
      enabledSkills: [alpha, beta],
      invokedSkillIds: [],
    }),
    [],
  );
  // An id that is not among the turn's skills pins nothing.
  assert.deepEqual(
    pinnedSkillNamesForTurn({
      enabledSkills: [alpha],
      invokedSkillIds: ["workspace-missing"],
    }),
    [],
  );
});

test("an invoked skill's SKILL.md reaches the model without a read_file call", async () => {
  const seen: BaseMessage[][] = [];
  const model = new ScriptedChatModel(
    (messages) => {
      seen.push(messages);
      return "done";
    },
    { name: "pinned-skill-capture" },
  );
  const alpha = selectedSkill("alpha-skill");
  const beta = selectedSkill("beta-skill");
  const skills = [alpha, beta];
  const agent = createDeepAgent({
    model: model as never,
    backend: new CompositeBackend(new StateBackend(), {
      "/skills/": new SelectedSkillsBackend(skills),
    }),
    checkpointer: new MemorySaver(),
    skills: ["/skills/"],
  });
  const config = { configurable: { thread_id: "pinned-skill-turn" } };

  const run = async (text: string, invokedSkillIds: string[]) => {
    const effectiveConfig = await agent.updateState(config, {
      skillsMetadata: skillMetadataForTurn(skills),
    });
    const pinnedSkills = pinnedSkillNamesForTurn({
      enabledSkills: skills,
      invokedSkillIds,
    });
    return agent.invoke(
      {
        messages: [{ role: "user", content: text }],
        ...(pinnedSkills.length > 0 ? { pinnedSkills } : {}),
      } as never,
      effectiveConfig,
    );
  };

  await run("make it with alpha", [alpha.workspaceSkillId]);

  const firstCall = seen[0]!.filter(
    (message) => message.getType() !== "system",
  );
  assert.equal(firstCall.length, 2);
  assert.equal(firstCall[0]!.content, "make it with alpha");
  assert.ok(isUserRequestMessage(firstCall[0]));
  const pinned = firstCall[1]!;
  assert.ok(isPinnedSkillMessage(pinned));
  const pinnedText = String(pinned.content);
  assert.match(
    pinnedText,
    /^<skill name="alpha-skill" path="\/skills\/alpha-skill\/SKILL\.md">/,
  );
  assert.match(pinnedText, /BODY-OF-alpha-skill/);
  // The frontmatter is dropped; the selected-only skill is not delivered.
  assert.doesNotMatch(pinnedText, /^---/m);
  assert.ok(!seen[0]!.some((m) => String(m.content).includes("BODY-OF-beta")));

  // A later turn that invokes nothing adds no further copy.
  const result = (await run("and now something else", [])) as {
    messages: BaseMessage[];
  };
  assert.equal(result.messages.filter(isPinnedSkillMessage).length, 1);
  assert.equal(
    result.messages.filter(isUserRequestMessage).at(-1)?.content,
    "and now something else",
  );
});

test("a pinned skill's instructions never stream as the assistant's answer", async () => {
  // Found with a real turn: the skills middleware returns the pinned message
  // from a graph node, so it streams through `messages` like model output, and
  // the stored answer began with the whole SKILL.md.
  const alpha = selectedSkill("alpha-skill");
  const agent = createDeepAgent({
    model: new ScriptedChatModel(() => "the model's answer") as never,
    backend: new CompositeBackend(new StateBackend(), {
      "/skills/": new SelectedSkillsBackend([alpha]),
    }),
    checkpointer: new MemorySaver(),
    skills: ["/skills/"],
  });
  const config = await agent.updateState(
    { configurable: { thread_id: "pinned-skill-stream" } },
    { skillsMetadata: skillMetadataForTurn([alpha]) },
  );
  const stream = (await agent.streamEvents(
    {
      messages: [{ role: "user", content: "use alpha" }],
      pinnedSkills: ["alpha-skill"],
    } as never,
    { ...(config as Record<string, unknown>), version: "v3" } as never,
  )) as unknown as AsyncIterable<{
    method: string;
    params?: { namespace?: unknown; data?: unknown };
  }>;

  const isAssistantMessageEvent = createAssistantMessageFilter();
  let humanMessageStarts = 0;
  let unfilteredText = "";
  let assistantText = "";
  for await (const event of stream) {
    if (event.method !== "messages") continue;
    const data = event.params?.data as { event?: string; role?: string };
    if (data?.event === "message-start" && data.role === "human") {
      humanMessageStarts += 1;
    }
    const text = adaptMessagesEvent(data)
      .map(([chunk]) => String(chunk.content ?? ""))
      .join("");
    unfilteredText += text;
    if (isAssistantMessageEvent(event.params?.namespace, data)) {
      assistantText += text;
    }
  }

  // The stream does carry the pinned message; the filter is what keeps it out.
  assert.equal(humanMessageStarts, 1);
  assert.match(unfilteredText, /BODY-OF-alpha-skill/);
  assert.equal(assistantText, "the model's answer");
});

test("the step-budget summary quotes the user's request, not pinned skill instructions", () => {
  const [input] = buildAgentStepSummaryInput([
    new HumanMessage("the real request"),
    pinnedSkillMessage("alpha-skill"),
    new AIMessage("progress so far"),
  ]);
  const data = JSON.parse(String(input!.content)) as {
    requestExcerpt: string;
  };
  assert.equal(data.requestExcerpt, "the real request");
});

test("the recent-window fallback keeps the user's message with its pinned skill", () => {
  const budget = {
    ...resolveSourceWeftContextCompressionBudget({ contextLength: 2_000 }),
    recentMessagesToKeep: 2,
  };
  const messages: BaseMessage[] = [
    ...Array.from({ length: 6 }, (_, index) => [
      new HumanMessage(`old question ${index}`),
      new AIMessage(`old answer ${index}`),
    ]).flat(),
    new HumanMessage("current question"),
    pinnedSkillMessage("alpha-skill"),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call-1", name: "probe", args: {} }],
    }),
    new ToolMessage({ tool_call_id: "call-1", name: "probe", content: "ok" }),
  ];

  fallbackSourceWeftMessagesToRecentWindow(messages, budget);

  // The turn starts at what the user wrote; were the pinned message taken for
  // the turn start, the question itself would be trimmed as older history.
  const kept = messages.map((message) => String(message.content));
  assert.ok(kept.includes("current question"));
  assert.ok(messages.some(isPinnedSkillMessage));
  assert.equal(messages.at(-1)?.getType(), "tool");
  assert.ok(!kept.includes("old question 0"));
});
