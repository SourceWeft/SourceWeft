import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ContentError } from "../errors";
import {
  SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT,
  SOURCEWEFT_SUMMARY_SECTIONS,
  SOURCEWEFT_TOOL_OUTPUT_PLACEHOLDER,
  assertSourceWeftCurrentUserMessageFits,
  createSourceWeftContextCompressionMiddleware,
  createSourceWeftToolOutputEdit,
  estimateSourceWeftMessageTokens,
  fallbackSourceWeftMessagesToRecentWindow,
  resolveSourceWeftContextCompressionBudget,
  sanitizeSourceWeftSummaryText,
} from "./context-compression";

test("summary prompt requires the fixed SourceWeft sections", () => {
  let previousIndex = -1;
  for (const section of SOURCEWEFT_SUMMARY_SECTIONS) {
    const index = SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT.indexOf(section);
    assert.ok(index > previousIndex, `${section} should appear in order`);
    previousIndex = index;
  }
  assert.match(SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT, /not source evidence/i);
  assert.match(SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT, /\{messages\}/);
});

test("summary sanitizer removes reusable citation markers", () => {
  assert.equal(
    sanitizeSourceWeftSummaryText(
      "The old answer used [citation:c12] and citation:c7.",
    ),
    "The old answer used old citation marker c12 removed and old citation marker c7.",
  );
});

test("context budget uses active chat profile context length", () => {
  assert.deepEqual(
    resolveSourceWeftContextCompressionBudget({ contextLength: 20_000 }),
    {
      contextLength: 20_000,
      reservedOutputTokens: 5_000,
      usableInputTokens: 15_000,
      contextEditingTriggerTokens: 8_250,
      contextEditingClearAtLeastTokens: 2_250,
      summarizationTriggerTokens: 12_000,
      recentToolResultsToKeep: 5,
      recentMessagesToKeep: 20,
      summaryMessageTrigger: 40,
      historyPathPrefix: "/conversation_history",
    },
  );
});

test("context compression does not add a second summarization middleware", async () => {
  const previousCompaction = process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
  process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = "1";

  try {
    const middleware = await createSourceWeftContextCompressionMiddleware({
      modelAlias: "chat-default",
    });
    const names = middleware.map((item) => item.name);

    assert.ok(names.includes("SourceWeftContextCompressionTrace"));
    assert.equal(names.includes("SummarizationMiddleware"), false);
  } finally {
    if (previousCompaction === undefined) {
      delete process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
    } else {
      process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = previousCompaction;
    }
  }
});

test("tool output edit clears old tool outputs and keeps the recent five", async () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 2_000,
  });
  const messages = [
    new HumanMessage("Find project facts"),
    ...Array.from({ length: 7 }, (_, index) => [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: `tool-${index}`,
            name: "search_sources",
            args: { query: `query ${index}` },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: `tool-${index}`,
        name: "search_sources",
        content: "large tool output ".repeat(80),
      }),
    ]).flat(),
    new HumanMessage("Current turn must stay untouched"),
  ];

  await createSourceWeftToolOutputEdit(budget).apply({
    messages,
    countTokens: estimateSourceWeftMessageTokens,
    model: {} as never,
  });

  const toolMessages = messages.filter((message) =>
    ToolMessage.isInstance(message),
  );
  const cleared = toolMessages.filter(
    (message) => message.content === SOURCEWEFT_TOOL_OUTPUT_PLACEHOLDER,
  );

  assert.equal(toolMessages.length, 7);
  assert.equal(cleared.length, 2);
  assert.equal(toolMessages.at(-1)?.content, "large tool output ".repeat(80));
});

test("tool output edit does not clear current turn tool output", async () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 2_000,
  });
  const messages = [
    new HumanMessage("Old turn"),
    new AIMessage({
      content: "",
      tool_calls: [
        { id: "old-tool", name: "search_sources", args: { query: "old" } },
      ],
    }),
    new ToolMessage({
      tool_call_id: "old-tool",
      name: "search_sources",
      content: "old output ".repeat(400),
    }),
    new HumanMessage("Current turn"),
    new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "current-tool",
          name: "search_sources",
          args: { query: "current" },
        },
      ],
    }),
    new ToolMessage({
      tool_call_id: "current-tool",
      name: "search_sources",
      content: "current output ".repeat(400),
    }),
  ];

  await createSourceWeftToolOutputEdit(budget).apply({
    messages,
    countTokens: estimateSourceWeftMessageTokens,
    model: {} as never,
  });

  assert.equal(
    (messages.at(-1) as ToolMessage).content,
    "current output ".repeat(400),
  );
});

test("single current user message over the input budget returns MESSAGE_TOO_LARGE", () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 100,
  });

  assert.throws(
    () =>
      assertSourceWeftCurrentUserMessageFits(
        [new HumanMessage("oversized ".repeat(300))],
        budget,
      ),
    (error) =>
      error instanceof ContentError && error.code === "MESSAGE_TOO_LARGE",
  );
});

test("overflow fallback keeps recent messages without splitting tool pairs", () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 4_000,
  });
  const messages = [
    ...Array.from({ length: 30 }, (_, index) => [
      new HumanMessage(`Old user ${index}`),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: `old-tool-${index}`,
            name: "search_sources",
            args: { query: `old ${index}` },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: `old-tool-${index}`,
        name: "search_sources",
        content: `old output ${index}`,
      }),
    ]).flat(),
    new HumanMessage("Current turn"),
  ];

  fallbackSourceWeftMessagesToRecentWindow(messages, budget);

  assert.equal(messages.at(-1)?.content, "Current turn");
  assert.ok(messages.length <= budget.recentMessagesToKeep + 1);
  for (const [index, message] of messages.entries()) {
    if (!ToolMessage.isInstance(message)) {
      continue;
    }
    assert.ok(
      messages
        .slice(0, index)
        .some(
          (candidate) =>
            AIMessage.isInstance(candidate) &&
            candidate.tool_calls?.some(
              (toolCall) => toolCall.id === message.tool_call_id,
            ),
        ),
    );
  }
});
