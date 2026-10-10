import { serverPublicRuntimeConfig } from "../../../lib/public-runtime-config";

export const dynamic = "force-dynamic";

/** Old native clients only open same-origin URLs. Recheck the gate before redirecting. */
export function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const release = serverPublicRuntimeConfig().desktopRecoveryRelease;
  const target = query.get("target") ?? "";
  const url =
    release &&
    query.get("version") === release.version &&
    Object.hasOwn(release.downloads, target)
      ? release.downloads[target]
      : null;
  const headers = { "Cache-Control": "no-store" };
  if (!url)
    return new Response("This repair download is not currently available.", {
      status: 404,
      headers,
    });
  return new Response(null, {
    status: 307,
    headers: { ...headers, Location: url },
  });
}
