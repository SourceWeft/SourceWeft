import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export type ScriptedReply = string | AIMessage | ChatResult;

/**
 * A chat model whose only behaviour is `respond`: given the conversation so
 * far, return the assistant's next message (a string, an AIMessage with
 * tool_calls, or a full ChatResult). Tests keep counters or captured prompts
 * in the closure. `bindTools` returns the model itself, as the hand-written
 * test models did, so tool binding is a no-op.
 */
export class ScriptedChatModel extends BaseChatModel {
  readonly respond: (
    messages: BaseMessage[],
  ) => ScriptedReply | Promise<ScriptedReply>;
  private readonly llmType: string;

  constructor(
    respond: (
      messages: BaseMessage[],
    ) => ScriptedReply | Promise<ScriptedReply>,
    options: BaseChatModelParams & { name?: string } = {},
  ) {
    const { name, ...params } = options;
    super(params);
    this.respond = respond;
    this.llmType = name ?? "scripted";
  }

  _llmType() {
    return this.llmType;
  }

  getName() {
    return `Chat${this.llmType[0]!.toUpperCase()}${this.llmType.slice(1)}`;
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const reply = await this.respond(messages);
    if (typeof reply === "string") {
      const message = new AIMessage(reply);
      return { generations: [{ text: reply, message }] };
    }
    if (reply instanceof AIMessage) {
      const text = typeof reply.content === "string" ? reply.content : "";
      return { generations: [{ text, message: reply }] };
    }
    return reply;
  }
}

/** The common case: reply with these tool calls once, then say "done". */
export function toolCallsThenDone(
  calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
) {
  let issued = false;
  return (): ScriptedReply => {
    if (issued) return "done";
    issued = true;
    return new AIMessage({
      content: "",
      tool_calls: calls.map((call, index) => ({
        id: call.id ?? `call-${index + 1}`,
        name: call.name,
        args: call.args,
      })),
    });
  };
}
