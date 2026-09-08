/** Policy names are selected by registered format handlers, never by HTML. */
export type ArtifactExecutionPolicy = "sandboxed-html";

export const ARTIFACT_EXECUTION_POLICY_HEADER =
  "X-SourceWeft-Artifact-Execution";
export const HTML_IFRAME_SANDBOX = "allow-scripts allow-forms allow-modals";

export function artifactExecutionCsp(
  policy: ArtifactExecutionPolicy,
  frameOrigins: readonly string[] = [],
): string {
  if (policy !== "sandboxed-html")
    throw new Error("Unknown artifact execution policy");
  const origins = frameOrigins.map((value) => new URL(value).origin);
  return [
    `sandbox ${HTML_IFRAME_SANDBOX}`,
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    `frame-ancestors 'self'${origins.length ? ` ${origins.join(" ")}` : ""}`,
  ].join("; ");
}

/** Inert file responses must remain safe even when opened outside an iframe. */
export function inertArtifactCsp(frameOrigins: readonly string[] = []): string {
  return artifactExecutionCsp("sandboxed-html", frameOrigins)
    .replace(`sandbox ${HTML_IFRAME_SANDBOX}`, "sandbox")
    .replace("script-src 'unsafe-inline'", "script-src 'none'");
}
