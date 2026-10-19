// Recovery query guards, not a conversation-wide model execution budget.
// 512 exceeds the default 440 business decisions plus initial/fork references.
export const MAX_AGENT_REFRESH_GRAPH_ORIGINS = 512;
export const MAX_AGENT_REFRESH_HISTORY_CHECKPOINTS = 50_000;
