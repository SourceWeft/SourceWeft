export type SourceStatus = "created" | "indexed";

export type SourceRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  title: string;
  contentText: string;
  status: SourceStatus;
  estimatedPages: number | null;
  parsedTokens: number | null;
  createdBy: string;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageRole = "user" | "assistant" | "system";

export type MessageRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdBy: string | null;
  model: string | null;
  creditsConsumed: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};
