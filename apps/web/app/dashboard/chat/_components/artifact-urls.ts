import { apiBaseUrl } from "../../../../lib/sdk";

const ARTIFACT_FILE_API_ROUTE = "/api/artifact-file";
const LEGACY_ARTIFACT_PREVIEW_API_ROUTE = "/api/artifact-preview";
const ARTIFACT_PREVIEW_PAGE_ROUTE = "/artifact-preview";
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
      fileName: string;
      kind: "asset";
      workspaceId: string;
    };

export function isSafeFlatArtifactAssetFileName(fileName: string) {
  const normalized = fileName.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    return false;
  }
  return !normalized.includes("/") && !normalized.includes("\\") && !normalized.includes("..");
}

function buildArtifactUrl(input: {
  artifactId: string;
  assetFileName?: string;
  download?: boolean;
  route: string;
  workspaceId: string;
}) {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  if (input.download) {
    params.set("download", "1");
  }
  if (input.assetFileName) {
    if (!isSafeFlatArtifactAssetFileName(input.assetFileName)) {
      return null;
    }
    params.set("assetFileName", input.assetFileName);
  }
  return `${input.route}?${params.toString()}`;
}

export function resolveArtifactProxyFileUrl(input: {
  artifactId: string;
  download?: boolean;
  workspaceId: string;
}) {
  return buildArtifactUrl({ ...input, route: ARTIFACT_FILE_API_ROUTE }) ?? "";
}

export function resolveArtifactPageUrl(input: {
  artifactId: string;
  workspaceId: string;
}) {
  return buildArtifactUrl({
    artifactId: input.artifactId,
    route: ARTIFACT_PREVIEW_PAGE_ROUTE,
    workspaceId: input.workspaceId,
  }) ?? "";
}

export function resolveArtifactProxyAssetUrl(input: {
  artifactId: string;
  fileName: string;
  workspaceId: string;
}) {
  return buildArtifactUrl({
    artifactId: input.artifactId,
    assetFileName: input.fileName,
    route: ARTIFACT_FILE_API_ROUTE,
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

    return resolveArtifactProxyFileUrl({
      artifactId: route.artifactId,
      download: input.download ?? route.download,
      workspaceId: route.workspaceId,
    });
  }

  return normalizeWebAssetUrl(input.fallbackUrl);
}
