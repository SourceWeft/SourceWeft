import { z } from "zod";

/**
 * Proactive `askUser` question requests.
 *
 * A sibling of `toolConfirmationRequestSchema` (approvals) that rides the same
 * SSE tool-output channel — it is forwarded verbatim by the stream event mapper
 * just like a confirmation, and surfaces in the same intervention UI with a
 * distinct renderer. It is deliberately NOT an approval: no `decisionOptions`,
 * no `requiresApproval`, no side effect. See
 * `docs/architecture/proactive-ask-user.md`.
 */

export const agentQuestionChoiceSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

export const agentQuestionItemSchema = z.object({
  question: z.string().min(1),
  /** Short (<=12 char) chip label; optional. */
  header: z.string().optional(),
  type: z.enum(["text", "multiple_choice"]),
  /** Required for `multiple_choice`. An "Other" free-form option is implied. */
  choices: z.array(agentQuestionChoiceSchema).optional(),
  multiSelect: z.boolean().optional(),
  /** Defaults to true when omitted. */
  required: z.boolean().optional(),
});

export const agentQuestionRequestSchema = z.object({
  type: z.literal("user_question_request"),
  schemaVersion: z.literal(1),
  /** Stable, payload-derived id used to route the answer back on resume. */
  id: z.string().min(1),
  /** Originating tool-call id of the askUser call. */
  toolCallId: z.string().min(1),
  /**
   * LangGraph interrupt id, when the runtime exposed one. The resume keys the
   * `Command.resume` by this id so a question raised inside a sub-agent subgraph
   * (or one of several parallel pending interrupts) resumes the right task
   * rather than relying on a bare, single-interrupt resume.
   */
  interruptId: z.string().min(1).optional(),
  questions: z.array(agentQuestionItemSchema).min(1).max(4),
});

export type AgentQuestionChoice = z.infer<typeof agentQuestionChoiceSchema>;
export type AgentQuestionItem = z.infer<typeof agentQuestionItemSchema>;
export type AgentQuestionRequest = z.infer<typeof agentQuestionRequestSchema>;

export function isAgentQuestionRequest(
  value: unknown,
): value is AgentQuestionRequest {
  return agentQuestionRequestSchema.safeParse(value).success;
}
