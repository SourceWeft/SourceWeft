/**
 * Query parameters that shape a thread page:
 *
 * - `embed=1` renders the conversation alone (no dashboard sidebar, no hub),
 *   which is what the sub-agent panel loads in an iframe.
 * - `agent=<threadId>` on a parent thread opens that sub-agent conversation in
 *   the side panel, so a panel can be linked to and survives a reload.
 */
export const EMBED_PARAM = "embed";
export const AGENT_PARAM = "agent";

type SearchInput =
  | URLSearchParams
  | { get(name: string): string | null }
  | string
  | null
  | undefined;

function toParams(search: SearchInput): { get(name: string): string | null } {
  if (!search) {
    return new URLSearchParams();
  }
  if (typeof search === "string") {
    return new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    );
  }
  return search;
}

export function isEmbedMode(search: SearchInput): boolean {
  const value = toParams(search).get(EMBED_PARAM);
  return value === "1" || value === "true";
}

export function readAgentParam(search: SearchInput): string | null {
  const value = toParams(search).get(AGENT_PARAM)?.trim();
  return value ? value : null;
}

/**
 * The query string (without `?`) with `agent` set to `agentId`, or removed
 * when null. Every other parameter is preserved.
 */
export function withAgentParam(
  search: SearchInput,
  agentId: string | null,
): string {
  const params = new URLSearchParams(
    typeof search === "string"
      ? search.startsWith("?")
        ? search.slice(1)
        : search
      : (search?.toString?.() ?? ""),
  );
  if (agentId) {
    params.set(AGENT_PARAM, agentId);
  } else {
    params.delete(AGENT_PARAM);
  }
  return params.toString();
}

/** The route a sub-agent panel loads: the child's own thread, embedded. */
export function buildEmbedThreadPath(threadId: string): string {
  return `/dashboard/chat/${encodeURIComponent(threadId)}?${EMBED_PARAM}=1`;
}

/** Joins a pathname and a query string, omitting the `?` when empty. */
export function joinPathAndQuery(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname;
}
