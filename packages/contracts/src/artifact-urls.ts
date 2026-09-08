/**
 * Shared kernel for artifact URL construction.
 *
 * Three route families address the same five artifact resources, and every one
 * of them used to be spelled out by hand at each call site:
 *
 * | family  | shape                                                  | who serves it            |
 * | ------- | ------------------------------------------------------ | ------------------------ |
 * | REST    | `/v1/workspaces/{ws}/artifacts/{id}/file`               | the backend API          |
 * | proxy   | `/api/artifact-file?artifactId=…&workspaceId=…`         | the web app's route      |
 * | page    | `/artifact-preview?artifactId=…&workspaceId=…`          | the web app's page       |
 *
 * REST is the canonical form: it is the only one an origin actually serves
 * bytes from. The proxy family is *not* a competing vocabulary — it is a
 * same-origin forwarder in front of REST (`apps/web/app/api/artifact-file`),
 * and it exists for two reasons REST cannot cover from a browser: it forwards
 * the session cookie across the web/API origin split, and it stamps a
 * per-renderer `Content-Security-Policy` onto HTML artifacts before they are
 * framed. So the two families are kept, but the *mapping* between them lives
 * here once instead of being re-derived at each boundary.
 *
 * `buildArtifactPreviewUrl` alone had five byte-identical copies (three tool
 * packages, one inline copy inside the video pipeline's finalizer, and a method
 * on the backend artifacts service), and the REST asset/source.json shapes had
 * two more. Everything here is pure string construction over `workspaceId` /
 * `artifactId`, which is why it lives in `contracts` rather than in any one
 * capability package — producers (backend, tool packages) and consumers (web)
 * are both downstream of it.
 *
 * Byte-for-byte output is deliberate: these strings are persisted, both in
 * `artifacts.payload_json` (the video project payload carries `artifactUrl` and
 * `sourceJsonUrl`) and in stored tool-call outputs (`artifact_url`,
 * `download_url`, `preview_image_url`). Every builder here reproduces the
 * string its predecessors produced, so no stored row changes meaning.
 */

/* -------------------------------------------------------------------------- */
/* Route roots                                                                 */
/* -------------------------------------------------------------------------- */

/** Web app route that proxies artifact bytes to the REST family. */
export const ARTIFACT_FILE_PROXY_ROUTE = "/api/artifact-file";

/**
 * Superseded proxy route. Still parsed, never built: URLs of this shape are
 * present in stored payloads from before the proxy was renamed.
 */
export const LEGACY_ARTIFACT_PREVIEW_PROXY_ROUTE = "/api/artifact-preview";

/** Browser-visible page that renders an artifact. */
export const ARTIFACT_PREVIEW_PAGE_ROUTE = "/artifact-preview";

/* -------------------------------------------------------------------------- */
/* Resource selector                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which byte stream of an artifact a URL addresses.
 *
 * `sourceJson` is a distinct REST route (`/source.json`) but reaches the proxy
 * as a plain flat asset named `source.json` — the proxy has no dedicated verb
 * for it, and never had one.
 */
export type ArtifactResource =
  | { readonly kind: "file" }
  | { readonly kind: "download" }
  | { readonly kind: "previewImage" }
  | { readonly kind: "sourceJson" }
  | { readonly kind: "asset"; readonly fileName: string };

export type ArtifactUrlTarget = {
  readonly artifactVersionId?: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  /** Defaults to the artifact's primary file. */
  readonly resource?: ArtifactResource;
};

/**
 * Artifact assets are a flat namespace; anything that could traverse out of it
 * (or that is a path segment at all) is rejected rather than escaped, because
 * the same name is also a storage key suffix on the backend.
 */
export function isSafeFlatArtifactAssetFileName(fileName: string): boolean {
  const normalized = fileName.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    return false;
  }
  return (
    !normalized.includes("/") &&
    !normalized.includes("\\") &&
    !normalized.includes("..")
  );
}

/* -------------------------------------------------------------------------- */
/* REST family — the canonical form                                            */
/* -------------------------------------------------------------------------- */

function artifactRestRoot(workspaceId: string, artifactId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export type ArtifactVersionMediaResource = "video" | "cover";

function artifactVersionRestRoot(input: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
}) {
  return `${artifactRestRoot(input.workspaceId, input.artifactId)}/versions/${encodeURIComponent(input.artifactVersionId)}`;
}

export function buildArtifactVersionMediaProjectionRestUrl(input: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
}) {
  return `${artifactVersionRestRoot(input)}/media`;
}

export function buildArtifactVersionMediaRestUrl(input: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly resource: ArtifactVersionMediaResource;
  readonly download?: boolean;
}) {
  const url = `${artifactVersionRestRoot(input)}/media/${input.resource}`;
  return input.download ? `${url}?download=1` : url;
}

export function buildArtifactVersionMediaProxyUrl(input: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly resource: ArtifactVersionMediaResource;
  readonly download?: boolean;
}) {
  const params = new URLSearchParams({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    artifactVersionId: input.artifactVersionId,
    versionMedia: input.resource,
  });
  if (input.download) {
    params.set("download", "1");
  }
  return `${ARTIFACT_FILE_PROXY_ROUTE}?${params.toString()}`;
}

/**
 * Canonical backend-relative URL for an artifact resource.
 *
 * Returns `null` only for an asset whose file name is not a safe flat name.
 */
export function buildArtifactRestUrl(input: ArtifactUrlTarget): string | null {
  const root = artifactRestRoot(input.workspaceId, input.artifactId);
  const suffix = input.artifactVersionId
    ? `?artifactVersionId=${encodeURIComponent(input.artifactVersionId)}`
    : "";
  const resource = input.resource ?? { kind: "file" };
  if (input.artifactVersionId && resource.kind === "sourceJson") return null;

  switch (resource.kind) {
    case "file":
      return `${root}/file${suffix}`;
    case "download":
      return `${root}/download${suffix}`;
    case "previewImage":
      return `${root}/preview-image${suffix}`;
    case "sourceJson":
      return `${root}/source.json${suffix}`;
    case "asset":
      return isSafeFlatArtifactAssetFileName(resource.fileName)
        ? `${root}/assets/${encodeURIComponent(resource.fileName)}${suffix}`
        : null;
  }
}

/** `/v1/workspaces/{ws}/artifacts/{id}/source.json`. */
export function buildArtifactSourceJsonUrl(input: {
  readonly workspaceId: string;
  readonly artifactId: string;
}): string {
  return `${artifactRestRoot(input.workspaceId, input.artifactId)}/source.json`;
}

/** `/v1/workspaces/{ws}/artifacts/{id}/assets/{fileName}`. */
export function buildArtifactAssetUrl(input: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly fileName: string;
}): string {
  return `${artifactRestRoot(input.workspaceId, input.artifactId)}/assets/${encodeURIComponent(input.fileName)}`;
}

/* -------------------------------------------------------------------------- */
/* Proxy family — the web app's same-origin forwarder in front of REST         */
/* -------------------------------------------------------------------------- */

/**
 * Query parameters the proxy route reads, in the order it emits them. Order is
 * not semantically load-bearing (the proxy and every parser read via
 * `URLSearchParams`) but is pinned so that regenerating a URL for an unchanged
 * artifact yields an unchanged string.
 */
export function buildArtifactProxyQuery(
  input: ArtifactUrlTarget,
): URLSearchParams | null {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  if (input.artifactVersionId)
    params.set("artifactVersionId", input.artifactVersionId);
  const resource = input.resource ?? { kind: "file" };
  if (input.artifactVersionId && resource.kind === "sourceJson") return null;

  switch (resource.kind) {
    case "file":
      break;
    case "download":
      params.set("download", "1");
      break;
    case "previewImage":
      params.set("asset", "previewImage");
      break;
    case "sourceJson":
      params.set("assetFileName", "source.json");
      break;
    case "asset": {
      if (!isSafeFlatArtifactAssetFileName(resource.fileName)) {
        return null;
      }
      params.set("assetFileName", resource.fileName);
      break;
    }
  }

  return params;
}

/**
 * Same-origin URL for an artifact resource, served by the web app's proxy.
 *
 * Returns `null` only for an asset whose file name is not a safe flat name.
 */
export function buildArtifactProxyUrl(input: ArtifactUrlTarget): string | null {
  const params = buildArtifactProxyQuery(input);
  return params ? `${ARTIFACT_FILE_PROXY_ROUTE}?${params.toString()}` : null;
}

/**
 * `buildArtifactProxyUrl` for the resource kinds that can never be rejected —
 * only `asset` carries a name that can fail validation.
 */
function proxyUrlFor(
  input: {
    readonly workspaceId: string;
    readonly artifactId: string;
    readonly artifactVersionId?: string;
  },
  kind: Exclude<ArtifactResource["kind"], "asset">,
): string {
  return buildArtifactProxyUrl({ ...input, resource: { kind } }) ?? "";
}

/** Proxy URL for an artifact's stored preview image. */
export function buildArtifactPreviewImageUrl(input: {
  readonly artifactVersionId?: string;
  readonly workspaceId: string;
  readonly artifactId: string;
}): string {
  return proxyUrlFor(input, "previewImage");
}

/** Proxy URL that delivers the artifact's primary file as an attachment. */
export function buildArtifactDownloadUrl(input: {
  readonly artifactVersionId?: string;
  readonly workspaceId: string;
  readonly artifactId: string;
}): string {
  return proxyUrlFor(input, "download");
}

/* -------------------------------------------------------------------------- */
/* Page family                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Browser-visible page for an artifact. This is what tool outputs and stored
 * payloads mean by `artifactUrl` / `artifact_url` — a place for a human to
 * land, not a byte stream.
 */
export function buildArtifactPreviewUrl(input: {
  readonly artifactVersionId?: string;
  readonly workspaceId: string;
  readonly artifactId: string;
}): string {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  if (input.artifactVersionId)
    params.set("artifactVersionId", input.artifactVersionId);
  return `${ARTIFACT_PREVIEW_PAGE_ROUTE}?${params.toString()}`;
}
