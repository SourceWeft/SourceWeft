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
/** Settles the promise `requestTableRegenerate` returned, by request token. */
const settlers = new Map<number, () => void>();

function settle(token: number) {
  settlers.get(token)?.();
  settlers.delete(token);
}
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

/**
 * Asks for the regenerate dialog. The promise settles once the request is
 * answered (the dialog is open, or the table could not be loaded), so the
 * viewer's button can stay busy meanwhile. With no dialog host mounted
 * nothing can answer, so it settles at once.
 */
export function requestTableRegenerate(ref: TableVersionRef): Promise<void> {
  if (state.request) settle(state.request.token);
  const token = nextToken++;
  const answered = new Promise<void>((resolve) => {
    settlers.set(token, resolve);
  });
  setState({
    request: {
      workspaceId: ref.workspaceId,
      artifactId: ref.artifactId,
      artifactVersionId: ref.artifactVersionId,
      token,
    },
  });
  if (!state.owner) settle(token);
  return answered;
}

/** The dialog for this request is showing. */
export function answerTableRegenerate(token: number) {
  settle(token);
}

/** Ends the request (dialog closed, or the table could not be loaded). */
export function clearTableRegenerate(token: number) {
  settle(token);
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
