/**
 * Shared read-only scope for the read-scoped delegates (`explore`, `plan`).
 *
 * Mirrors Claude's Explore/Plan: same read-only tool surface, different purpose
 * and output. Read-only is enforced two ways — a small business-tool allowlist
 * plus Deep Agents' filesystem middleware in a deny-write configuration — so a
 * delegate can search the thread's sources and read working files, but never
 * write, execute, or publish.
 */
import {
  createFilesystemMiddleware,
  type AnyBackendProtocol,
  type FilesystemPermission,
} from "deepagents";
import type { AgentMiddleware } from "langchain";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";

/**
 * Business (non-filesystem) tools a read-scoped delegate may use. The filesystem
 * read tools come from {@link readOnlyChildMiddleware}, not this set.
 */
export const READ_ONLY_BUSINESS_TOOL_NAMES = new Set<string>([
  AGENT_TOOL_NAMES.searchSources,
]);

/** Deny-write filesystem policy: read the knowledge base and working files only. */
export const READ_ONLY_FILESYSTEM_PERMISSIONS: FilesystemPermission[] = [
  { operations: ["read"], paths: ["/"], mode: "allow" },
  {
    operations: ["read"],
    paths: ["/kb", "/kb/**", "/workfiles", "/workfiles/**"],
    mode: "allow",
  },
  { operations: ["read"], paths: ["/**"], mode: "deny" },
  { operations: ["write"], paths: ["/**"], mode: "deny" },
];

/** The filesystem read tools a read-scoped delegate is granted. */
export const READ_ONLY_FILESYSTEM_TOOLS = [
  "read_file",
  "ls",
  "glob",
  "grep",
] as const;

/** Select the read-only business tools from the turn's bound tools. */
export function filterReadOnlyBusinessTools(
  availableTools: readonly { readonly name: string }[],
) {
  return availableTools.filter((tool) =>
    READ_ONLY_BUSINESS_TOOL_NAMES.has(tool.name),
  );
}

/**
 * Build a read-scoped child middleware stack: the deny-write filesystem tools
 * followed by the shared child governance (retries, limits, billing, etc.).
 */
export function readOnlyChildMiddleware(input: {
  backend: AnyBackendProtocol;
  middleware: readonly AgentMiddleware[];
}): AgentMiddleware[] {
  return [
    createFilesystemMiddleware({
      backend: input.backend,
      tools: [...READ_ONLY_FILESYSTEM_TOOLS],
      permissions: READ_ONLY_FILESYSTEM_PERMISSIONS,
    }),
    ...input.middleware,
  ];
}
