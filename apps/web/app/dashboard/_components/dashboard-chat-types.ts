export type ChatItem = {
  id: string;
  title: string;
  updatedAt: string;
  sourceCount: number;
  status?: "ready" | "running" | "attention";
};
