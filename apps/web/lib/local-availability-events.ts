const listeners = new Set<(path: string) => void>();
const codes = new Set([
  "DEVICE_OFFLINE",
  "LOCAL_CONNECTION_REQUIRED",
  "REMOTE_ACCESS_DISABLED",
  "NATIVE_PROOF_EXPIRED",
  "LOCAL_BINDING_INVALID",
  "LOCAL_FOLDER_REVOKED",
  "LOCAL_DIRECTORY_UNAVAILABLE",
  "LOCAL_EXECUTION_TIMEOUT",
  "LOCAL_EXECUTION_OUTCOME_UNKNOWN",
]);
export function reportLocalAvailabilityError(path: string, error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (error instanceof TypeError || (code && codes.has(code)))
    for (const listener of listeners) listener(path);
}
export function subscribeLocalAvailabilityErrors(
  listener: (path: string) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
