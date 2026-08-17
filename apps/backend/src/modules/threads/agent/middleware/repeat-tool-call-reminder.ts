/**
 * Repeat-tool-call reminder — a generic, advisory loop guard.
 *
 * Ported in spirit from DeepSeek Harness's `repeat-tool-reminder` guard and
 * deepagents' Nemotron `_tool_call_signature` dedupe: when the model calls the
 * same tool with identical (canonicalized) arguments several times in a row, it
 * is usually stuck. This nudges it — via a system-prompt note on the next model
 * call — to try a different approach or, if it genuinely needs input, to ask the
 * user once rather than loop.
 *
 * Design choices (matching the references):
 * - **Advisory, never a veto.** It only appends guidance; it never blocks or
 *   rewrites a tool call. Context may have changed such that a repeat is
 *   legitimate, so a hard block would misfire. Hard per-turn ceilings live
 *   elsewhere (`toolCallLimitMiddleware`).
 * - **Stateless.** It derives the consecutive-repeat count from the message
 *   history on each model call (`wrapModelCall`), so there is no cross-call
 *   bookkeeping and no interaction with tool-execution interrupts.
 * - **Resets on the user's turn.** Only tool calls since the last human message
 *   are counted, so a repeat across a new user request is not treated as a loop.
 */

import { createMiddleware } from "langchain";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

/** Default escalation thresholds (consecutive identical calls). */
const GENTLE_THRESHOLD = 3;
const STRONG_THRESHOLD = 5;

type ToolCallLike = { name?: unknown; args?: unknown };

/** Deep key-sort so argument property order doesn't change the signature. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function toolCallSignature(call: ToolCallLike): string {
  const name = typeof call.name === "string" ? call.name : "";
  let argsJson = "{}";
  try {
    argsJson = JSON.stringify(canonicalize(call.args ?? {}));
  } catch {
    argsJson = "{}";
  }
  return `${name}:${argsJson}`;
}

function toolCallsOf(message: BaseMessage): ToolCallLike[] {
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(calls) ? (calls as ToolCallLike[]) : [];
}

/**
 * The tail run of identical tool-call signatures since the last human message.
 * Returns the repeated tool's name and how many times in a row it was called.
 */
export function maxConsecutiveRepeatSinceLastUser(messages: BaseMessage[]): {
  name: string;
  signature: string;
  count: number;
} | null {
  // Collect tool-call signatures emitted after the last HumanMessage, oldest
  // first, so the "consecutive at the tail" run reflects the current attempt.
  const signatures: Array<{ name: string; signature: string }> = [];
  for (const message of messages) {
    if (message instanceof HumanMessage) {
      signatures.length = 0;
      continue;
    }
    for (const call of toolCallsOf(message)) {
      const name = typeof call.name === "string" ? call.name : "";
      if (name) {
        signatures.push({ name, signature: toolCallSignature(call) });
      }
    }
  }

  if (signatures.length === 0) {
    return null;
  }
  const tail = signatures[signatures.length - 1]!;
  let count = 0;
  for (let i = signatures.length - 1; i >= 0; i -= 1) {
    if (signatures[i]!.signature === tail.signature) {
      count += 1;
    } else {
      break;
    }
  }
  return { name: tail.name, signature: tail.signature, count };
}

function buildReminder(name: string, count: number): string {
  if (count >= STRONG_THRESHOLD) {
    return `<repeated_tool_call>
You have called \`${name}\` ${count} times in a row with identical arguments. This is almost certainly a loop. Stop repeating it: either take a different approach, use the evidence you already have, or — if you genuinely cannot proceed without input the user alone can give — ask them once. Do not call \`${name}\` with the same arguments again.
</repeated_tool_call>`;
  }
  return `<repeated_tool_call>
You have called \`${name}\` ${count} times in a row with the same arguments. If it is not making progress, try a different approach rather than repeating it.
</repeated_tool_call>`;
}

/**
 * Middleware that nudges the model out of identical-tool-call loops. Generic:
 * applies to every tool (a looping search is as wasteful as a repeated
 * question), and complements the `askUser` per-turn cap.
 */
export function createRepeatToolCallReminderMiddleware(options?: {
  gentleThreshold?: number;
}) {
  const threshold = Math.max(2, options?.gentleThreshold ?? GENTLE_THRESHOLD);
  return createMiddleware({
    name: "SourceWeftRepeatToolCallReminder",
    wrapModelCall: (request, handler) => {
      const repeat = maxConsecutiveRepeatSinceLastUser(request.messages);
      if (!repeat || repeat.count < threshold) {
        return handler(request);
      }
      const note = buildReminder(repeat.name, repeat.count);
      const systemPrompt = request.systemPrompt
        ? `${request.systemPrompt}\n\n${note}`
        : note;
      return handler({ ...request, systemPrompt });
    },
  });
}
