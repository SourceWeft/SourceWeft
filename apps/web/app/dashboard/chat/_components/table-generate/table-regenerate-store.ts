import type { TableVersionRef } from "@sourceweft/builtin-tool-table/ui";
import {
  createRegenerateRequestStore,
  type RegenerateRequest,
} from "../artifact-preview/regenerate-request-store";

/**
 * Where the table viewer's "regenerate" lands: `requestTableRegenerate` (the
 * host's `onRegenerate`) records it and `TableRegenerateDialogHost`, mounted
 * next to every capability-owned preview, opens the dialog.
 */

export type TableRegenerateRequest = RegenerateRequest;

const store = createRegenerateRequestStore();

export const subscribeTableRegenerate = store.subscribe;
export const tableRegenerateState = store.getState;
export const answerTableRegenerate = store.answer;
export const clearTableRegenerate = store.clear;
export const registerTableRegenerateHost = store.registerHost;

export function requestTableRegenerate(ref: TableVersionRef): Promise<void> {
  return store.request(ref);
}
