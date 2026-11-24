/** The artifact version a viewer asks to regenerate (the viewers' version ref). */
type GroundedVersionRef = {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string | null;
};

/**
 * An artifact viewer asks the app to regenerate through its host, a plain
 * object installed once, while the dialog that does it lives in the React
 * tree. A store made here is where such a request lands: `request` (the
 * host's regenerate) records it and a dialog host, mounted next to every
 * capability-owned preview, opens the dialog. Each artifact family (tables,
 * study sets) makes its own store.
 *
 * The preview can be mounted more than once at a time (the hub panel and its
 * expanded dialog), so only the first mounted dialog host answers: one
 * request, one dialog.
 */

export type RegenerateRequest = GroundedVersionRef & {
  /** Distinguishes two requests for the same artifact. */
  readonly token: number;
};

export type RegenerateRequestState = {
  readonly request: RegenerateRequest | null;
  readonly owner: symbol | null;
};

export type RegenerateRequestStore = {
  subscribe(listener: () => void): () => void;
  getState(): RegenerateRequestState;
  /**
   * Asks for the regenerate dialog. The promise settles once the request is
   * answered (the dialog is open, or the artifact could not be loaded), so the
   * viewer's button can stay busy meanwhile. With no dialog host mounted
   * nothing can answer, so it settles at once.
   */
  request(ref: GroundedVersionRef): Promise<void>;
  /** The dialog for this request is showing. */
  answer(token: number): void;
  /** Ends the request (dialog closed, or the artifact could not be loaded). */
  clear(token: number): void;
  /** Registers a mounted dialog host; the first one registered answers. */
  registerHost(id: symbol): () => void;
};

/** What a store reports during server rendering: nothing requested. */
export const EMPTY_REGENERATE_REQUEST_STATE: RegenerateRequestState = {
  request: null,
  owner: null,
};

export function createRegenerateRequestStore(): RegenerateRequestStore {
  let state: RegenerateRequestState = EMPTY_REGENERATE_REQUEST_STATE;
  let nextToken = 1;
  const hosts: symbol[] = [];
  /** Settles the promise `request` returned, by request token. */
  const settlers = new Map<number, () => void>();
  const listeners = new Set<() => void>();

  function settle(token: number) {
    settlers.get(token)?.();
    settlers.delete(token);
  }

  function setState(next: Partial<RegenerateRequestState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    request(ref) {
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
    },
    answer: settle,
    clear(token) {
      settle(token);
      if (state.request?.token === token) setState({ request: null });
    },
    registerHost(id) {
      hosts.push(id);
      setState({ owner: hosts[0] ?? null });
      return () => {
        const index = hosts.indexOf(id);
        if (index >= 0) hosts.splice(index, 1);
        setState({ owner: hosts[0] ?? null });
      };
    },
  };
}
