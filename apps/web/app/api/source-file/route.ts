import { internalApiBaseUrl } from "../../../lib/internal-api-base-url";
export const dynamic = "force-dynamic";

// Keep generic preview readers same-origin even in development with separate ports.
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const workspaceId = query.get("workspaceId");
  const sourceId = query.get("sourceId");
  if (!workspaceId || !sourceId)
    return new Response("workspaceId and sourceId are required", {
      status: 400,
    });
  const url = `${internalApiBaseUrl()}/v1/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}/download${query.get("inline") === "true" ? "?inline=true" : ""}`;
  const upstream = await fetch(url, {
    cache: "no-store",
    redirect: "manual",
    headers: { cookie: request.headers.get("cookie") ?? "" },
  });
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-disposition",
    "content-length",
    "content-security-policy",
    "x-content-type-options",
    "cache-control",
    "location",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
