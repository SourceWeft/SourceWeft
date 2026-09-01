import {
  buildArtifactRestUrl,
  buildArtifactVersionMediaRestUrl,
  isSafeFlatArtifactAssetFileName,
  type ArtifactResource,
  type ArtifactVersionMediaResource,
} from "@sourceweft/contracts/artifact-urls";
import { NextResponse, type NextRequest } from "next/server";
import { apiBaseUrl } from "../../../lib/api-base-url";

const GENERIC_HTML_ARTIFACT_CSP = [
  "sandbox",
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

function badRequest(message: string) {
  return new NextResponse(message, { status: 400 });
}

export async function proxyArtifactFile(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  const artifactId = request.nextUrl.searchParams.get("artifactId");
  const artifactVersionId =
    request.nextUrl.searchParams.get("artifactVersionId");
  const versionMedia = request.nextUrl.searchParams.get("versionMedia");
  const asset = request.nextUrl.searchParams.get("asset");
  const assetFileName = request.nextUrl.searchParams.get("assetFileName");
  const isDownload = request.nextUrl.searchParams.get("download") === "1";

  if (!workspaceId || !artifactId) {
    return badRequest("workspaceId and artifactId are required.");
  }

  if (assetFileName && !isSafeFlatArtifactAssetFileName(assetFileName)) {
    return badRequest("assetFileName must be a flat artifact asset file name.");
  }
  if (asset && asset !== "previewImage") {
    return badRequest("asset must be previewImage when provided.");
  }
  if (Boolean(artifactVersionId) !== Boolean(versionMedia)) {
    return badRequest(
      "artifactVersionId and versionMedia must be provided together.",
    );
  }
  if (versionMedia && versionMedia !== "video" && versionMedia !== "cover") {
    return badRequest("versionMedia must be video or cover.");
  }
  if (versionMedia && (asset || assetFileName)) {
    return badRequest("versionMedia cannot be combined with another asset.");
  }

  let resource: ArtifactResource = isDownload
    ? { kind: "download" }
    : { kind: "file" };
  if (asset === "previewImage") {
    resource = { kind: "previewImage" };
  } else if (assetFileName) {
    resource = { fileName: assetFileName, kind: "asset" };
  }
  const upstreamPath =
    artifactVersionId && versionMedia
      ? buildArtifactVersionMediaRestUrl({
          artifactId,
          artifactVersionId,
          resource: versionMedia as ArtifactVersionMediaResource,
          workspaceId,
          download: isDownload,
        })
      : buildArtifactRestUrl({
          artifactId,
          resource,
          workspaceId,
        });
  if (!upstreamPath) {
    return badRequest("assetFileName must be a flat artifact asset file name.");
  }
  const upstreamUrl = new URL(upstreamPath, apiBaseUrl);
  const response = await fetch(upstreamUrl, {
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      ...(request.headers.get("range")
        ? { range: request.headers.get("range")! }
        : {}),
      ...(request.headers.get("if-none-match")
        ? { "if-none-match": request.headers.get("if-none-match")! }
        : {}),
    },
  });

  if (!response.ok && response.status !== 304 && response.status !== 416) {
    return new NextResponse(await response.text(), {
      status: response.status,
      statusText: response.statusText,
    });
  }

  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const headers = new Headers({
    "Cache-Control": artifactVersionId
      ? "private, no-cache, max-age=0, must-revalidate"
      : "private, max-age=30",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of [
    "accept-ranges",
    "content-length",
    "content-range",
    "etag",
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const contentDisposition = response.headers.get("content-disposition");
  if (contentDisposition) {
    headers.set("Content-Disposition", contentDisposition);
  }

  if (!isDownload && contentType.toLowerCase().includes("text/html")) {
    headers.set("Content-Security-Policy", GENERIC_HTML_ARTIFACT_CSP);
  }

  return new NextResponse(response.status === 304 ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
