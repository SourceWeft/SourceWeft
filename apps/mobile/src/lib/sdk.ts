import { createSourceweftClient } from "@sourceweft/sdk";

export const client = createSourceweftClient("http://localhost:3001");

// Backward-compatible re-exports (Desktop and Mobile share these via @sourceweft/sdk)
export { HttpClient, WorkspaceClient } from "@sourceweft/sdk";
