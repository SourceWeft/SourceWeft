import { agentQuestionItemSchema } from "@sourceweft/contracts";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { toObjectRecord } from "../../../../../lib/records";
import { getUserQuestionOutput } from "./tool-confirmation-state";
import type { ToolCallRecord } from "./types";

export function isUserQuestionTool(toolName: string) {
  return toolName === AGENT_TOOL_NAMES.askUser;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readQuestions(value: unknown) {
  const parsed = agentQuestionItemSchema.array().min(1).max(4).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function readQuestionInterrupt(toolCall: ToolCallRecord) {
  // Older traces retain LangGraph's normal pause in the tool's error field.
  // Recognize only a question interrupt belonging to this exact tool call.
  const interrupts = parseJson(toolCall.error);
  if (!Array.isArray(interrupts)) return null;
  for (const interrupt of interrupts) {
    const value = toObjectRecord(toObjectRecord(interrupt)?.value);
    if (value?.type !== "ask_user" || value.toolCallId !== toolCall.id)
      continue;
    const questions = readQuestions(value.questions);
    if (questions.length) return questions;
  }
  return null;
}

function readAnswerTranscript(toolCall: ToolCallRecord): string | null {
  const output = parseJson(toolCall.output) ?? toolCall.output;
  const record = toObjectRecord(output);
  const update = toObjectRecord(record?.update);
  const messages = Array.isArray(update?.messages) ? update.messages : [];
  for (const message of messages) {
    const entry = toObjectRecord(message);
    const fields = toObjectRecord(entry?.kwargs) ?? entry;
    if (
      fields?.tool_call_id === toolCall.id &&
      typeof fields.content === "string"
    ) {
      return fields.content;
    }
  }
  const content = typeof output === "string" ? output : record?.content;
  return typeof content === "string" && content.startsWith("Q: ")
    ? content
    : null;
}

export function getUserQuestionDisplay(toolCall: ToolCallRecord) {
  const pendingRequest = getUserQuestionOutput(toolCall.output);
  const request =
    pendingRequest?.toolCallId === toolCall.id ? pendingRequest : null;
  const interrupt = readQuestionInterrupt(toolCall);
  const questions =
    request?.questions ?? interrupt ?? readQuestions(toolCall.input?.questions);
  const transcript = readAnswerTranscript(toolCall);
  const failed = toolCall.status === "error" && !interrupt;
  const waiting =
    !failed &&
    !transcript &&
    (toolCall.status === "approval_requested" ||
      Boolean(request) ||
      Boolean(interrupt));
  const asking = waiting || toolCall.status === "running";
  const count = questions.length;
  const noun = count > 1 ? "questions" : "question";
  return {
    title: asking
      ? `Asking ${noun}`
      : count
        ? `Asked ${count} ${noun}`
        : "Asked a question",
    questions,
    transcript:
      transcript?.replace(/^A: \(cancelled\)$/gm, "A: No answer provided") ??
      null,
    waiting,
    failed,
    error: failed ? (toolCall.error ?? "Unable to get your answer.") : null,
  };
}
