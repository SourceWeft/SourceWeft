import { OpenAICompatibleChatAdapter } from "./openai-compatible-chat";

export class SiliconflowCNChatAdapter extends OpenAICompatibleChatAdapter {
  override readonly kind = "siliconflow-cn" as const;
}
