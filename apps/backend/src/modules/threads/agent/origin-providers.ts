/**
 * Per-origin turn providers: how a host-owned kind of conversation adds its
 * own tools and instructions to a turn without the threads module knowing
 * who the host is.
 *
 * A host (for example the workspace assistant) registers one provider per
 * thread origin when the worker starts. When a turn runs in a conversation of
 * that origin, turn assembly asks the provider for the turn's extra tools and
 * a runtime-prompt fragment. Threads never imports the host; the host imports
 * this registry.
 *
 * - `replaceTools: true` (a Router): the turn binds the provider's tools and
 *   nothing else — no business tools, no sub-agents, no `askUser`, no
 *   `write_todos` and no filesystem tools.
 * - `replaceTools: false` (a Worker): the provider's tools are bound next to
 *   the turn's own; in an unattended run they are allowed on top of the
 *   unattended allow-list.
 */
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import type { ThreadOrigin } from "@sourceweft/contracts";

/**
 * Deep Agents' delegation tool. Same value as `turn/subagent-projection`'s
 * constant; not imported from there because that file pulls in the agent
 * factory, and hosts import this registry at worker startup.
 */
const TASK_TOOL_NAME = "task";

/**
 * Deep Agents' filesystem tools. Its filesystem middleware is always mounted
 * and refuses a tool list without `read_file`, so a replace-tools turn keeps
 * the (read-only) middleware and these are excluded instead.
 */
const FILESYSTEM_TOOL_NAMES = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "delete",
  "glob",
  "grep",
  "execute",
] as const;

/** What a provider learns about the turn it is equipping. */
export type OriginTurnContext = {
  workspaceId: string;
  teamId: string;
  threadId: string;
  /** The durable chat run (`chat_thread_runs.id`). */
  runId: string;
  /** Whose identity the turn runs as, and who pays for it. */
  userId: string;
  /** Host-set values the run was started with; see `startHostTurn`. */
  hostContext: Record<string, string>;
};

export type OriginTurnProvider = {
  /** The tools this turn binds in addition to (or instead of) its own. */
  tools(ctx: OriginTurnContext): Promise<StructuredToolInterface[]>;
  /**
   * true: every other tool and every sub-agent is dropped (a Router).
   * false: added on top of the unattended allow-list (a Worker).
   */
  replaceTools: boolean;
  /** Appended at the end of the runtime prompt; empty adds nothing. */
  prompt(ctx: OriginTurnContext): Promise<string>;
};

const providers = new Map<ThreadOrigin, OriginTurnProvider>();

/**
 * Registers the provider for one origin. A second registration for the same
 * origin is a wiring error and throws rather than silently replacing the
 * first.
 */
export function registerOriginTurnProvider(
  origin: ThreadOrigin,
  provider: OriginTurnProvider,
): void {
  if (providers.has(origin)) {
    throw new Error(
      `An origin turn provider is already registered for '${origin}'.`,
    );
  }
  providers.set(origin, provider);
}

/** Removes an origin's provider (tests, shutdown). */
export function unregisterOriginTurnProvider(origin: ThreadOrigin): void {
  providers.delete(origin);
}

export function getOriginTurnProvider(
  origin: ThreadOrigin | null | undefined,
): OriginTurnProvider | undefined {
  return origin ? providers.get(origin) : undefined;
}

/**
 * Keeps the tools Deep Agents always binds away from a replace-tools turn:
 * `task` (it adds its own general-purpose delegate whenever the roster does
 * not name one, so an empty roster alone still binds it) and the filesystem
 * tools. Hides them from the model and refuses a call to them, the same way
 * Deep Agents' own profile tool exclusion does.
 */
export function createOriginToolExclusionMiddleware() {
  const excluded = new Set<string>([TASK_TOOL_NAME, ...FILESYSTEM_TOOL_NAMES]);
  const toolName = (tool: unknown) =>
    tool && typeof tool === "object" && "name" in tool
      ? (tool as { name?: unknown }).name
      : undefined;
  return createMiddleware({
    name: "SourceWeftOriginToolExclusion",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        tools: request.tools?.filter((tool) => {
          const name = toolName(tool);
          return typeof name !== "string" || !excluded.has(name);
        }),
      }),
    wrapToolCall: (request, handler) => {
      const { name, id } = request.toolCall;
      if (!excluded.has(name)) return handler(request);
      return new ToolMessage({
        content: `Error: ${name} is not available.`,
        tool_call_id: id ?? "",
        name,
        status: "error",
      });
    },
  });
}
