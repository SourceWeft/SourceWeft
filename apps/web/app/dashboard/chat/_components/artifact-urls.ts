import {
  ARTIFACT_FILE_PROXY_ROUTE as ARTIFACT_FILE_API_ROUTE,
  ARTIFACT_PREVIEW_PAGE_ROUTE,
  LEGACY_ARTIFACT_PREVIEW_PROXY_ROUTE as LEGACY_ARTIFACT_PREVIEW_API_ROUTE,
  buildArtifactPreviewUrl,
  buildArtifactProxyUrl,
  isSafeFlatArtifactAssetFileName as isSafeFlatArtifactAssetFileNameContract,
  type ArtifactResource,
} from "@sourceweft/contracts/artifact-urls";
import { apiBaseUrl } from "../../../../lib/sdk";

const ARTIFACT_FILE_ROUTE_PATTERN =
  /^\/v1\/workspaces\/([^/]+)\/artifacts\/([^/]+)\/(file|download)\/?$/;
const ARTIFACT_ASSET_ROUTE_PATTERN =
  /^\/v1\/workspaces\/([^/]+)\/artifacts\/([^/]+)\/assets\/([^/]+)\/?$/;
const ARTIFACT_SOURCE_JSON_ROUTE_PATTERN =
  /^\/v1\/workspaces\/([^/]+)\/artifacts\/([^/]+)\/source\.json\/?$/;
const ARTIFACT_QUERY_ROUTE_PATHS = new Set([
  ARTIFACT_FILE_API_ROUTE,
  ARTIFACT_PREVIEW_PAGE_ROUTE,
  LEGACY_ARTIFACT_PREVIEW_API_ROUTE,
]);

type ParsedArtifactRoute =
  | {
      artifactId: string;
      download: boolean;
      kind: "artifact";
      workspaceId: string;
    }
  | {
      artifactId: string;
      asset: "previewImage";
      kind: "semanticAsset";
      workspaceId: string;
    }
  | {
      artifactId: string;
      fileName: string;
      kind: "asset";
      workspaceId: string;
    };

export const isSafeFlatArtifactAssetFileName =
  isSafeFlatArtifactAssetFileNameContract;

function artifactResource(input: {
  asset?: "previewImage";
  assetFileName?: string;
  download?: boolean;
}): ArtifactResource {
  if (input.asset === "previewImage") {
    return { kind: "previewImage" };
  }
  if (input.assetFileName) {
    return { fileName: input.assetFileName, kind: "asset" };
  }
  return input.download ? { kind: "download" } : { kind: "file" };
}

export function resolveArtifactProxyFileUrl(input: {
  artifactId: string;
  asset?: "previewImage";
  download?: boolean;
  workspaceId: string;
}) {
  return (
    buildArtifactProxyUrl({
      artifactId: input.artifactId,
      resource: artifactResource(input),
      workspaceId: input.workspaceId,
    }) ?? ""
  );
}

export function resolveArtifactPreviewImageUrl(input: {
  artifactId: string;
  workspaceId: string;
}) {
  return resolveArtifactProxyFileUrl({
    artifactId: input.artifactId,
    asset: "previewImage",
    workspaceId: input.workspaceId,
  });
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type ArtifactPreviewImageMetadata = {
  altText: string | null;
  byteLength: number | null;
  fileName: string;
  mimeType: string;
  storageKey: string;
};

export function artifactPreviewImageMetadataFromArtifact(input: {
  previewMetadataJson?: unknown;
  previewStorageKey?: string | null;
}) {
  const storageKey =
    typeof input.previewStorageKey === "string" &&
    input.previewStorageKey.trim().length > 0
      ? input.previewStorageKey.trim()
      : null;
  if (!storageKey) {
    return null;
  }

  const metadata = toRecord(input.previewMetadataJson);
  const byteLength =
    typeof metadata?.byteLength === "number" &&
    Number.isFinite(metadata.byteLength) &&
    metadata.byteLength >= 0
      ? metadata.byteLength
      : null;

  return {
    altText:
      typeof metadata?.altText === "string" &&
      metadata.altText.trim().length > 0
        ? metadata.altText.trim()
        : null,
    byteLength,
    fileName:
      typeof metadata?.fileName === "string" &&
      metadata.fileName.trim().length > 0
        ? metadata.fileName.trim()
        : "preview.jpg",
    mimeType:
      typeof metadata?.mimeType === "string" ? metadata.mimeType.trim() : "",
    storageKey,
  } satisfies ArtifactPreviewImageMetadata;
}

export function resolveArtifactPreviewImageUrlFromArtifact(input: {
  artifactId?: string | null;
  previewMetadataJson?: unknown;
  previewStorageKey?: string | null;
  workspaceId?: string | null;
}) {
  return artifactPreviewImageMetadataFromArtifact(input) &&
    input.artifactId &&
    input.workspaceId
    ? resolveArtifactPreviewImageUrl({
        artifactId: input.artifactId,
        workspaceId: input.workspaceId,
      })
    : null;
}

export function resolveArtifactPageUrl(input: {
  artifactId: string;
  workspaceId: string;
}) {
  return buildArtifactPreviewUrl(input);
}

export function resolveArtifactProxyAssetUrl(input: {
  artifactId: string;
  fileName: string;
  workspaceId: string;
}) {
  return buildArtifactProxyUrl({
    artifactId: input.artifactId,
    resource: { fileName: input.fileName, kind: "asset" },
    workspaceId: input.workspaceId,
  });
}

function parseArtifactFileRoute(value: string): ParsedArtifactRoute | null {
  let pathname: string;

  try {
    pathname = new URL(value, "http://sourceweft.local").pathname;
  } catch {
    return null;
  }

  const match = pathname.match(ARTIFACT_FILE_ROUTE_PATTERN);
  if (match) {
    return {
      artifactId: decodeURIComponent(match[2] ?? ""),
      download: match[3] === "download",
      kind: "artifact",
      workspaceId: decodeURIComponent(match[1] ?? ""),
    };
  }

  const assetMatch = pathname.match(ARTIFACT_ASSET_ROUTE_PATTERN);
  if (assetMatch) {
    const fileName = decodeURIComponent(assetMatch[3] ?? "");
    if (!isSafeFlatArtifactAssetFileName(fileName)) {
      return null;
    }
    return {
      artifactId: decodeURIComponent(assetMatch[2] ?? ""),
      fileName,
      kind: "asset",
      workspaceId: decodeURIComponent(assetMatch[1] ?? ""),
    };
  }

  const sourceJsonMatch = pathname.match(ARTIFACT_SOURCE_JSON_ROUTE_PATTERN);
  if (!sourceJsonMatch) {
    return null;
  }

  return {
    artifactId: decodeURIComponent(sourceJsonMatch[2] ?? ""),
    fileName: "source.json",
    kind: "asset",
    workspaceId: decodeURIComponent(sourceJsonMatch[1] ?? ""),
  };
}

function parseArtifactQueryRoute(value: string): ParsedArtifactRoute | null {
  let url: URL;

  try {
    url = new URL(value, "http://sourceweft.local");
  } catch {
    return null;
  }

  if (!ARTIFACT_QUERY_ROUTE_PATHS.has(url.pathname)) {
    return null;
  }

  const artifactId = url.searchParams.get("artifactId");
  const workspaceId = url.searchParams.get("workspaceId");
  if (!artifactId || !workspaceId) {
    return null;
  }

  const assetFileName = url.searchParams.get("assetFileName");
  const asset = url.searchParams.get("asset");
  if (asset === "previewImage") {
    return {
      artifactId,
      asset,
      kind: "semanticAsset",
      workspaceId,
    };
  }
  if (asset) {
    return null;
  }

  if (assetFileName) {
    if (!isSafeFlatArtifactAssetFileName(assetFileName)) {
      return null;
    }
    return {
      artifactId,
      fileName: assetFileName,
      kind: "asset",
      workspaceId,
    };
  }

  return {
    artifactId,
    download: url.searchParams.get("download") === "1",
    kind: "artifact",
    workspaceId,
  };
}

function parseArtifactRoute(value: string) {
  return parseArtifactFileRoute(value) ?? parseArtifactQueryRoute(value);
}

export function artifactApiUrlToPageUrl(value: string) {
  const route = parseArtifactRoute(value);
  if (!route) {
    return null;
  }

  if (route.kind === "asset") {
    return resolveArtifactProxyAssetUrl(route);
  }
  if (route.kind === "semanticAsset") {
    return resolveArtifactProxyFileUrl(route);
  }

  return resolveArtifactPageUrl(route);
}

export function artifactApiUrlToProxyFileUrl(value: string) {
  const route = parseArtifactRoute(value);
  if (!route) {
    return null;
  }

  if (route.kind === "asset") {
    return resolveArtifactProxyAssetUrl(route);
  }
  if (route.kind === "semanticAsset") {
    return resolveArtifactProxyFileUrl(route);
  }

  return resolveArtifactProxyFileUrl(route);
}

export function normalizeWebAssetUrl(value: string) {
  return (
    artifactApiUrlToProxyFileUrl(value) ??
    (value.startsWith("/v1/") ? `${apiBaseUrl}${value}` : value)
  );
}

export function resolveArtifactPageUrlFromArtifact(input: {
  artifactId?: string | null;
  fallbackUrl?: string | null;
  workspaceId?: string | null;
}) {
  if (input.workspaceId && input.artifactId) {
    return resolveArtifactPageUrl({
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
    });
  }

  if (!input.fallbackUrl) {
    return null;
  }

  const route = parseArtifactRoute(input.fallbackUrl);
  if (route) {
    if (route.kind === "asset") {
      return resolveArtifactProxyAssetUrl(route);
    }

    return resolveArtifactPageUrl({
      artifactId: route.artifactId,
      workspaceId: route.workspaceId,
    });
  }

  return normalizeWebAssetUrl(input.fallbackUrl);
}

export function resolveArtifactProxyFileUrlFromArtifact(input: {
  artifactId?: string | null;
  download?: boolean;
  fallbackUrl?: string | null;
  workspaceId?: string | null;
}) {
  if (input.workspaceId && input.artifactId) {
    return resolveArtifactProxyFileUrl({
      artifactId: input.artifactId,
      download: input.download,
      workspaceId: input.workspaceId,
    });
  }

  if (!input.fallbackUrl) {
    return null;
  }

  const route = parseArtifactRoute(input.fallbackUrl);
  if (route) {
    if (route.kind === "asset") {
      return resolveArtifactProxyAssetUrl(route);
    }
    if (route.kind === "semanticAsset") {
      return resolveArtifactProxyFileUrl(route);
    }

    return resolveArtifactProxyFileUrl({
      artifactId: route.artifactId,
      download: input.download ?? route.download,
      workspaceId: route.workspaceId,
    });
  }

  return normalizeWebAssetUrl(input.fallbackUrl);
}
