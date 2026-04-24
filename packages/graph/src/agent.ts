import { createDeepAgent } from "deepagents";
import { CHAT_SYSTEM_PROMPT } from "./prompts/chat";
import { createRetrievalTool, type RetrievalChunk } from "./tools/retrieval-tool";

export function createWorkspaceChatAgent(input: {
  model: unknown;
  checkpointer?: unknown;
  retrieve: (query: string) => Promise<RetrievalChunk[]>;
  systemPrompt?: string;
}) : unknown {
  const retrievalTool = createRetrievalTool({
    retrieve: input.retrieve,
  });

  return createDeepAgent({
    model: input.model as never,
    checkpointer: input.checkpointer as never,
    tools: [retrievalTool],
    systemPrompt: input.systemPrompt ?? CHAT_SYSTEM_PROMPT,
  });
}
