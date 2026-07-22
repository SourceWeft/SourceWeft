/**
 * The isomorphic index: tool names, presentation metadata and the static tool
 * table. Both the web client and the backend import this, so it must stay free
 * of React (that is `./ui`) and of capability entry modules (that is
 * `./server`, whose graph is node-only).
 */
export * from "./registry";
export type { AgentToolSlashCommand } from "@sourceweft/contracts/agent-tools";
