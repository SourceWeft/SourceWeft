import type { TableVersionRef } from "@sourceweft/builtin-tool-table/ui";

/**
 * The table viewer asks the app to regenerate a table through its host, a
 * plain object installed once, while the dialog that does it lives in the
 * React tree. This is where the request lands: `requestTableRegenerate` (the
 * host's `onRegenerate`) records it and `TableRegenerateDialogHost`, mounted
 * next to every capability-owned preview, opens the dialog.
 *
 * The preview can be mounted more than once at a time (the hub panel and its
 * expanded dialog), so only the first mounted host answers: one request, one
 * dialog.
 */

export type TableRegenerateRequest = TableVersionRef & {
  /** Distinguishes two requests for the same table. */
  readonly token: number;
};

type State = {
  readonly request: TableRegenerateRequest | null;
  readonly owner: symbol | null;
};

let state: State = { request: null, owner: null };
let nextToken = 1;
const hosts: symbol[] = [];
const listeners = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribeTableRegenerate(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function tableRegenerateState(): State {
  return state;
}

export function requestTableRegenerate(ref: TableVersionRef) {
  setState({
    request: {
      workspaceId: ref.workspaceId,
      artifactId: ref.artifactId,
      artifactVersionId: ref.artifactVersionId,
      token: nextToken++,
    },
  });
}

/** Ends the request (dialog closed, or the table could not be loaded). */
export function clearTableRegenerate(token: number) {
  if (state.request?.token === token) setState({ request: null });
}

/** Registers a mounted dialog host; the first one registered answers. */
export function registerTableRegenerateHost(id: symbol) {
  hosts.push(id);
  setState({ owner: hosts[0] ?? null });
  return () => {
    const index = hosts.indexOf(id);
    if (index >= 0) hosts.splice(index, 1);
    setState({ owner: hosts[0] ?? null });
  };
}
