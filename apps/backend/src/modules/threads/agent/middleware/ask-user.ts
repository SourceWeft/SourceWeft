/**
 * `askUser` middleware — proactive clarifying questions.
 *
 * Ported from deepagents' own `AskUserMiddleware` pattern: a tool whose body
 * calls LangGraph `interrupt()` to pause the turn (checkpointed), then resumes
 * with the user's answer and returns it to the model as a `ToolMessage`.
 *
 * This deliberately does NOT use `interruptOn` / the langchain HITL decision
 * vocabulary (`approve|edit|reject`) — JS `langchain` has no `respond` decision,
 * and a question is not an approval of a side-effecting call. See
 * `docs/architecture/proactive-ask-user.md`.
 *
 * The tool node re-runs from the top on resume, so all work before `interrupt()`
 * must be idempotent; `interrupt()` is the checkpoint boundary and its return
 * value is the resume payload.
 */

import { createMiddleware, tool } from "langchain";
import { Command, interrupt } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";
import type { ToolRuntime } from "@langchain/core/tools";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { z } from "zod";

// Sourced from the typed tool registry so the name is defined in exactly one
// place. Re-exported under the historical name so existing importers
// (ask-user-stream-handler.ts, tests) keep working unchanged.
export const ASK_USER_TOOL_NAME = AGENT_TOOL_NAMES.askUser;

const askUserChoiceSchema = z.object({
  label: z.string().min(1).describe("The display label for this choice."),
  description: z.string().optional(),
});

const askUserQuestionSchema = z.object({
  question: z.string().min(1).describe("The question text to display."),
  header: z
    .string()
    .max(12)
    .optional()
    .describe("Short (<=12 char) label/chip for this question."),
  type: z
    .enum(["text", "multiple_choice"])
    .describe(
      "'text' for free-form input, 'multiple_choice' for predefined options.",
    ),
  choices: z
    .array(askUserChoiceSchema)
    .optional()
    .describe(
      "Options for multiple_choice questions. An 'Other' free-form option is always available.",
    ),
  multiSelect: z.boolean().optional(),
  required: z.boolean().optional(),
});

export const askUserToolSchema = z.object({
  questions: z.array(askUserQuestionSchema).min(1).max(4),
});

export type AskUserQuestion = z.infer<typeof askUserQuestionSchema>;

/** Value passed to `interrupt()`; discriminates against the HITL request shape. */
export interface AskUserInterruptValue {
  type: "ask_user";
  questions: AskUserQuestion[];
  toolCallId: string;
}

/** Resume payload (client -> `Command.resume`). */
export type AskUserResume =
  | { status: "answered"; answers: string[] }
  | { status: "cancelled" }
  | { status: "error"; error?: string };

export const ASK_USER_CANCELLED_ANSWER = "(cancelled)";

export function isAskUserInterruptValue(
  value: unknown,
): value is AskUserInterruptValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ask_user"
  );
}

/** True if any pending interrupt in an `updates` payload is an ask_user request. */
export function payloadHasAskUserInterrupt(payload: unknown): boolean {
  const interrupts = (payload as { __interrupt__?: unknown })?.__interrupt__;
  if (!Array.isArray(interrupts)) {
    return false;
  }
  return interrupts.some((entry) =>
    isAskUserInterruptValue((entry as { value?: unknown })?.value),
  );
}

function validateQuestions(questions: AskUserQuestion[]): void {
  if (questions.length === 0) {
    throw new Error("askUser requires at least one question");
  }
  for (const q of questions) {
    if (!q.question.trim()) {
      throw new Error("askUser questions must have non-empty 'question' text");
    }
    if (q.type === "multiple_choice" && !q.choices?.length) {
      throw new Error(
        `multiple_choice question ${JSON.stringify(q.question)} requires a non-empty 'choices' list`,
      );
    }
    if (q.type === "text" && q.choices?.length) {
      throw new Error(
        `text question ${JSON.stringify(q.question)} must not define 'choices'`,
      );
    }
  }
}

/** Render `Q:/A:` transcript — the authoritative text handed back to the model. */
export function formatAskUserTranscript(
  questions: AskUserQuestion[],
  answers: string[],
): string {
  return questions
    .map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? "(no answer)"}`)
    .join("\n\n");
}

/**
 * Normalize a resume payload into a `Command` carrying a status-tagged
 * `ToolMessage`. Answer count must equal question count on the answered path —
 * a mismatch is an error, never padded or truncated (would mis-attribute
 * answers to the wrong question).
 */
export function parseAskUserAnswer(
  response: unknown,
  questions: AskUserQuestion[],
  toolCallId: string,
): Command {
  let status: AskUserResume["status"] = "answered";
  let errorText: string | undefined;
  let answers: string[] = [];

  if (typeof response !== "object" || response === null) {
    status = "error";
    errorText = "invalid askUser response payload";
  } else {
    const record = response as Record<string, unknown>;
    if (typeof record.status === "string") {
      status = record.status as AskUserResume["status"];
    }
    const rawAnswers = record.answers;
    if (Array.isArray(rawAnswers)) {
      answers = rawAnswers.map((a) => String(a));
    }
    if (typeof record.error === "string" && record.error) {
      errorText = record.error;
    }

    if (status === "cancelled") {
      answers = questions.map(() => ASK_USER_CANCELLED_ANSWER);
    } else if (status === "answered") {
      if (answers.length !== questions.length) {
        status = "error";
        errorText = `askUser answer count mismatch (expected ${questions.length}, got ${answers.length})`;
      }
    } else if (status !== "error") {
      status = "error";
      errorText = `askUser received unknown status ${JSON.stringify(record.status)}`;
    }
  }

  if (status === "error") {
    answers = questions.map(
      () => `(error: ${errorText ?? "askUser interaction failed"})`,
    );
  }

  return new Command({
    update: {
      messages: [
        new ToolMessage({
          content: formatAskUserTranscript(questions, answers),
          name: ASK_USER_TOOL_NAME,
          tool_call_id: toolCallId,
          status: status === "error" ? "error" : "success",
        }),
      ],
    },
  });
}

export const ASK_USER_SYSTEM_PROMPT = `<asking_the_user>
- Use ${ASK_USER_TOOL_NAME} only when genuinely blocked on a user-owned decision you cannot infer from the request, the selected sources, workspace context, or a sensible default.
- If a conventional default exists or you can verify the answer yourself, do not ask: pick the sensible option, say you are proceeding with it, and continue.
- Decision test: would the answer change your next action? If not, decide it yourself.
- ${ASK_USER_TOOL_NAME} has no side effect and is not an approval. Do not use it for yes/no confirmations of side-effecting tools, and do not narrate it in prose.
- Batch related questions into a single ${ASK_USER_TOOL_NAME} call, and ask before acting, not mid-way.
- Use multiple_choice when there are clear options; use text for free-form input.
</asking_the_user>`;

const ASK_USER_TOOL_DESCRIPTION = `Ask the user one or more questions when you need clarification or input before proceeding.

Each question is either "text" (free-form) or "multiple_choice" (an "Other" option is always available). Use sparingly — only when you genuinely need information you cannot determine from context. Do NOT use for simple yes/no confirmations or trivial decisions; just proceed with your best judgment.`;

/**
 * Middleware providing the `askUser` tool. Do NOT also register `askUser` in
 * `interruptOn` — it interrupts from inside the tool body.
 */
export function createAskUserMiddleware() {
  const askUser = tool(
    async (
      { questions }: z.infer<typeof askUserToolSchema>,
      runtime: ToolRuntime,
    ) => {
      validateQuestions(questions);
      const toolCallId = runtime.toolCall?.id ?? "";
      const response = interrupt<AskUserInterruptValue, AskUserResume>({
        type: "ask_user",
        questions,
        toolCallId,
      });
      return parseAskUserAnswer(response, questions, toolCallId);
    },
    {
      name: ASK_USER_TOOL_NAME,
      description: ASK_USER_TOOL_DESCRIPTION,
      schema: askUserToolSchema,
    },
  );

  return createMiddleware({
    name: "SourceWeftAskUser",
    tools: [askUser],
    wrapModelCall: (request, handler) => {
      // SourceWeft drives the agent with `systemPrompt` (a string), so append
      // our policy block there. Spread is the documented override idiom in JS
      // langchain (`{ ...request, systemPrompt }`), there is no `.override()`.
      const systemPrompt = request.systemPrompt
        ? `${request.systemPrompt}\n\n${ASK_USER_SYSTEM_PROMPT}`
        : ASK_USER_SYSTEM_PROMPT;
      return handler({ ...request, systemPrompt });
    },
  });
}
