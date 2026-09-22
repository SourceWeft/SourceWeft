/** Browser-local diagnostics. Never pass raw errors or application data to logs. */
export type ClientErrorSource =
  "window" | "promise" | "messages" | "chat-route" | "global";
const reported = new WeakSet<object>();
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);

export function buildClientErrorDiagnostic(
  error: unknown,
  source: ClientErrorSource,
  location: { origin: string; pathname: string },
  componentStack?: string | null,
) {
  const value = error instanceof Error ? error : null;
  // Keep only bundle coordinates, not function names, messages, query strings,
  // arbitrary source paths or serialized request/response bodies.
  const frames = [
    ...`${value?.stack ?? ""}\n${componentStack ?? ""}`.matchAll(
      /https?:\/\/[^\s)]+/g,
    ),
  ]
    .flatMap(([raw]) => {
      try {
        const url = new URL(raw);
        if (url.origin !== location.origin) return [];
        const match = url.pathname.match(
          /^\/_next\/static\/(?:chunks|[^/]+)\/[A-Za-z0-9_./-]+\.js(?::\d+){0,2}$/,
        );
        return match ? [match[0]] : [];
      } catch {
        return [];
      }
    })
    .slice(0, 20);
  const threadId = location.pathname.match(
    /^\/dashboard\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
  )?.[1];
  const digest =
    value &&
    "digest" in value &&
    typeof value.digest === "string" &&
    /^\d{1,20}$/.test(value.digest)
      ? value.digest
      : undefined;
  return {
    source,
    timestamp: new Date().toISOString(),
    name: value && errorNames.has(value.name) ? value.name : "UnknownError",
    threadId,
    digest,
    frames,
  };
}

export function reportClientError(
  error: unknown,
  source: ClientErrorSource,
  componentStack?: string | null,
) {
  if (typeof window === "undefined") return;
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  console.error(
    "[SourceWeft client error]",
    buildClientErrorDiagnostic(error, source, window.location, componentStack),
  );
}

export function listenForClientErrors(target: EventTarget = window) {
  const onError = (event: Event) =>
    reportClientError((event as ErrorEvent).error, "window");
  const onRejection = (event: Event) => {
    // Existing cancellation handling remains responsible for preventing default.
    if (!event.defaultPrevented)
      reportClientError((event as PromiseRejectionEvent).reason, "promise");
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
