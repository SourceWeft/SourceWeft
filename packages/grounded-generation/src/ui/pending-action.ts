import { useCallback, useState } from "react";

/**
 * Pending state for a host action that may take a moment before anything
 * shows (regenerate loads the artifact before its dialog opens). A host that
 * returns a promise keeps the button busy until it settles; one that returns
 * nothing leaves it as it was.
 */
export function usePendingAction(): readonly [
  pending: boolean,
  track: (result: void | Promise<unknown>) => void,
] {
  const [pending, setPending] = useState(false);
  const track = useCallback((result: void | Promise<unknown>) => {
    if (!result || typeof result.then !== "function") return;
    setPending(true);
    result.then(
      () => setPending(false),
      () => setPending(false),
    );
  }, []);
  return [pending, track] as const;
}
