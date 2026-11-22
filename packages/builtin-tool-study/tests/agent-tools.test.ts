import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentToolGroundedArtifactServices } from "@sourceweft/contracts/agent-tools";
import { STUDY_LIMITS } from "@sourceweft/contracts/study";
import {
  createCapabilityAgentTools,
  generateFlashcardsAgentTool,
  generateMindmapAgentTool,
  generateQuizAgentTool,
  STUDY_TOOL_NAMES,
  studyAgentToolDefs,
} from "../src/index";

type Call = Parameters<AgentToolGroundedArtifactServices["requestGeneration"]>[0];

function groundedArtifacts(
  sourceIds: readonly string[] = ["s1", "s2"],
  receipt: { reused: boolean } = { reused: false },
) {
  const calls: Call[] = [];
  let listed = 0;
  const service: AgentToolGroundedArtifactServices = {
    listTurnSourceIds: async () => {
      listed += 1;
      return sourceIds;
    },
    requestGeneration: async (input) => {
      calls.push(input);
      return { artifactId: "artifact-1", versionNo: 1, status: "pending", reused: receipt.reused };
    },
  };
  return { service, calls, listed: () => listed };
}

/** A gateway that fails the test if a tool ever reaches for a model. */
const forbiddenModelGateway = {
  getClient: async () => {
    throw new Error("a study tool must never call a model");
  },
};

const ALL_TOOLS = Object.values(STUDY_TOOL_NAMES) as string[];

function bind(
  service?: AgentToolGroundedArtifactServices,
  options: { toolIds?: string[]; selected?: readonly string[] } = {},
) {
  const selected = options.selected ?? ALL_TOOLS;
  const result = createCapabilityAgentTools({
    ...(options.toolIds ? { toolIds: options.toolIds } : {}),
    context: {
      threadId: "thread-1",
      isToolDenied: () => false,
      shouldBindAgentTool: (name: string) => selected.includes(name),
    },
    services: {
      ...(service ? { groundedArtifacts: service } : {}),
      modelGateway: forbiddenModelGateway,
    } as never,
  });
  return result.tools.map((entry) => entry.tool);
}

function toolNamed(service: AgentToolGroundedArtifactServices, name: string) {
  const found = bind(service, { selected: [name] });
  assert.deepEqual(
    found.map((tool) => tool.name),
    [name],
  );
  return found[0]!;
}

test("one artifact tool per study type, each driven by its own command", () => {
  assert.deepEqual(STUDY_TOOL_NAMES, {
    flashcards: "generate_flashcards",
    quiz: "generate_quiz",
    mindmap: "generate_mindmap",
  });
  assert.deepEqual(studyAgentToolDefs, [
    generateFlashcardsAgentTool,
    generateQuizAgentTool,
    generateMindmapAgentTool,
  ]);
  assert.deepEqual(
    studyAgentToolDefs.map((def) => [def.name, def.slash.aliases]),
    [
      ["generate_flashcards", ["flashcards"]],
      ["generate_quiz", ["quiz"]],
      ["generate_mindmap", ["mindmap"]],
    ],
  );
  for (const def of studyAgentToolDefs) {
    assert.equal(def.domain, "artifact");
    assert.equal(def.defaultPermission, "allow");
    assert.equal(def.riskLevel, "low");
    assert.equal(def.activation.default, "off");
    assert.equal(def.activation.userControl, "none");
    assert.equal(def.slash?.supportsCommand, true);
  }
});

test("the manifest declares the three tools as write-risk commands with workflows", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../sourceweft.capability.json", import.meta.url), "utf8"),
  ) as {
    tools: {
      id: string;
      risk: string;
      command: {
        aliases: string[];
        category: string;
        workflow: {
          defaultTools: string[];
          initialToolPolicy: string;
          successCriteria: { kind: string };
          additionalPromptLines: string[];
        };
      };
    }[];
  };
  assert.deepEqual(
    manifest.tools.map((entry) => [entry.id, entry.command.aliases]),
    [
      ["generate_flashcards", ["flashcards"]],
      ["generate_quiz", ["quiz"]],
      ["generate_mindmap", ["mindmap"]],
    ],
  );
  for (const entry of manifest.tools) {
    assert.equal(entry.risk, "write");
    assert.equal(entry.command.category, "Artifacts");
    assert.deepEqual(entry.command.workflow.defaultTools, [entry.id]);
    // Not forced: with no sources the agent must be free to ask instead.
    assert.equal(entry.command.workflow.initialToolPolicy, "auto");
    assert.deepEqual(entry.command.workflow.successCriteria, { kind: "none" });
    const prompt = entry.command.workflow.additionalPromptLines.join("\n");
    assert.match(prompt, /no sources/);
    assert.match(prompt, /select or @mention/);
    assert.match(prompt, /Artifacts tab/);
  }
});

test("each tool queues its own type through the host service and returns the receipt", async () => {
  for (const [kind, name] of Object.entries(STUDY_TOOL_NAMES)) {
    const grounded = groundedArtifacts();
    const tool = toolNamed(grounded.service, name);
    const result = (await tool.invoke({ userLanguage: "zh-CN" })) as Record<string, unknown>;

    assert.deepEqual(grounded.calls, [
      {
        artifactType: kind,
        // No options when the user asked for none; the thread is the host's.
        request: { artifactType: kind, sourceIds: ["s1", "s2"] },
        uiLocale: "zh-CN",
      },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.status, "pending");
    assert.equal(result.artifactType, kind);
    assert.equal(result.artifactId, "artifact-1");
    assert.equal(result.versionNo, 1);
    assert.equal(result.reused, false);
    assert.equal(result.sources, 2);
    assert.match(String(result.nextStep), /Artifacts tab/);
    assert.match(String(result.nextStep), /do not/i);
  }
});

test("the user's size, count, difficulty, focus and language become the request's options", async () => {
  const grounded = groundedArtifacts();
  const tool = toolNamed(grounded.service, "generate_quiz");
  await tool.invoke({
    size: "more",
    count: 12,
    difficulty: "hard",
    focus: "  chapter 3: photosynthesis  ",
    language: "en",
    userLanguage: "zh-CN",
  });
  assert.deepEqual(grounded.calls[0]!.request, {
    artifactType: "quiz",
    sourceIds: ["s1", "s2"],
    options: {
      size: "more",
      count: 12,
      difficulty: "hard",
      language: "en",
      focus: "chapter 3: photosynthesis",
    },
  });
  assert.equal(grounded.calls[0]!.uiLocale, "zh-CN");
});

test("a mind map takes no difficulty", async () => {
  const grounded = groundedArtifacts();
  const tool = toolNamed(grounded.service, "generate_mindmap");
  await tool.invoke({ size: "fewer", difficulty: "hard", userLanguage: "en" } as never);
  assert.deepEqual(grounded.calls[0]!.request.options, { size: "fewer" });
});

test("a repeated request reports the reused artifact", async () => {
  const grounded = groundedArtifacts(["s1"], { reused: true });
  const tool = toolNamed(grounded.service, "generate_flashcards");
  const result = (await tool.invoke({ userLanguage: "en" })) as Record<string, unknown>;
  assert.equal(result.reused, true);
  assert.match(String(result.nextStep), /requested a moment ago and are reused/);
});

test("a study tool never writes items: the receipt carries none, and the tool reaches no engine or model", async () => {
  const grounded = groundedArtifacts();
  const tool = toolNamed(grounded.service, "generate_flashcards");
  const result = (await tool.invoke({ userLanguage: "en" })) as Record<string, unknown>;
  assert.equal(result.items, undefined);
  assert.equal(result.root, undefined);
  const source = readFileSync(new URL("../src/agent-tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /modelGateway|createStudyCapability|\.\/engine|billing/);
});

test("no tool binds without the grounded-artifact service, context or the turn's selection", () => {
  const service = groundedArtifacts().service;
  // The turn selected none (no command, no skill).
  assert.deepEqual(bind(service, { selected: [] }), []);
  // A /quiz turn binds the quiz tool only.
  assert.deepEqual(
    bind(service, { selected: ["generate_quiz"] }).map((tool) => tool.name),
    ["generate_quiz"],
  );
  assert.deepEqual(bind(undefined), []);
  assert.deepEqual(bind(service, { toolIds: ["web_search"] }), []);
  assert.deepEqual(createCapabilityAgentTools({ services: { groundedArtifacts: service } }).tools, []);
  assert.deepEqual(
    createCapabilityAgentTools({
      context: {
        threadId: "thread-1",
        shouldBindAgentTool: () => true,
        isToolDenied: (name: string) => name === "generate_flashcards",
      },
      services: { groundedArtifacts: service },
    }).tools.map((entry) => entry.tool.name),
    ["generate_quiz", "generate_mindmap"],
  );
});

async function rejected(name: string, args: Record<string, unknown>, sourceIds?: string[]) {
  const grounded = groundedArtifacts(sourceIds);
  const tool = toolNamed(grounded.service, name);
  // Deliberately invalid input, so the typed schema is bypassed here.
  await assert.rejects(tool.invoke(args as never));
  assert.equal(grounded.calls.length, 0, "nothing was requested");
}

test("a count above the type's ceiling, a long focus or no user language are rejected", async () => {
  await rejected("generate_quiz", {
    count: STUDY_LIMITS.maxCount.quiz + 1,
    userLanguage: "en",
  });
  await rejected("generate_flashcards", {
    count: STUDY_LIMITS.maxCount.flashcards + 1,
    userLanguage: "en",
  });
  await rejected("generate_mindmap", {
    focus: "x".repeat(STUDY_LIMITS.focusChars + 1),
    userLanguage: "en",
  });
  await rejected("generate_quiz", {});
  await rejected("generate_quiz", { size: "huge", userLanguage: "en" });
});

test("more sources than the study contract allows are rejected before anything is requested", async () => {
  const sourceIds = Array.from({ length: STUDY_LIMITS.maxSources + 1 }, (_, index) => `s${index}`);
  await rejected("generate_flashcards", { userLanguage: "en" }, sourceIds);
});

test("with no sources in the turn the tool asks for them and requests nothing", async () => {
  for (const [kind, name] of Object.entries(STUDY_TOOL_NAMES)) {
    const grounded = groundedArtifacts([]);
    const tool = toolNamed(grounded.service, name);
    const result = (await tool.invoke({ userLanguage: "en" })) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, "NO_SOURCES");
    assert.match(String(result.message), /select or @mention/i);
    assert.match(String(result.message), new RegExp(`/${kind}`));
    assert.equal(grounded.listed(), 1);
    assert.deepEqual(grounded.calls, []);
  }
});
