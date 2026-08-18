const GUARDED_OAUTH_PATHS = new Set([
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/token",
]);

const OAUTH_RESOURCE_ERROR = {
  error: "invalid_target",
  error_description: "OAuth resource indicators are not supported.",
} as const;

function rejectedResourceResponse() {
  return Response.json(OAUTH_RESOURCE_ERROR, {
    status: 400,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bodyContainsResource(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return false;
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.clone().text();
    return new URLSearchParams(body).has("resource");
  }

  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await request.clone().json();
      return isRecord(body) && Object.hasOwn(body, "resource");
    } catch {
      // Better Auth owns malformed-body handling. The guard only rejects a
      // resource indicator it can identify without changing normal errors.
      return false;
    }
  }

  return false;
}

/**
 * Fail closed on RFC 8707 resource indicators until SourceWeft can deploy the
 * Better Auth 1.7 resource-binding model and its schema migration.
 */
export async function rejectUnsupportedOAuthResource(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!GUARDED_OAUTH_PATHS.has(url.pathname)) {
    return null;
  }

  if (url.searchParams.has("resource") || (await bodyContainsResource(request))) {
    return rejectedResourceResponse();
  }

  return null;
}
