import { getTranslations } from "next-intl/server";

import { apiBaseUrl } from "../../../../lib/api-base-url";
import { isMarketNotFound, getPublicMcpManifest } from "../../../../lib/market-mcp";
import { mcpAuthExplanation } from "../../../../lib/mcp-auth-method";
import { SITE_URL } from "../../../seo";
import { mcpInstallMarkdown } from "../../../[locale]/mcp/_components/mcp-install-md";

// The site and API addresses are injected at container start, so this is
// rendered per request rather than baked in at build time.
export const dynamic = "force-dynamic";

function notFound() {
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * One MCP server's connect guide for AI agents: the facts to show the user
 * and the config to add. The agent prompt on the server's page points here.
 * Always English — it is read by models, whichever language the person
 * browses in. Public catalog entries only: the manifest read is the page's
 * own, so what the page 404s, this does too.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ identifier: string }> },
) {
  const { identifier } = await params;
  let decoded: string;
  try {
    // The same decoding as the server's page: the identifier's `/` arrives
    // as `%2F`.
    decoded = decodeURIComponent(identifier);
  } catch {
    return notFound();
  }
  let detail;
  try {
    detail = await getPublicMcpManifest(decoded);
  } catch (error) {
    // Not public, withdrawn, or never existed — the same 404 as its page. An
    // outage is rethrown as a 5xx.
    if (isMarketNotFound(error)) return notFound();
    throw error;
  }
  const t = await getTranslations({ locale: "en", namespace: "mcp" });
  const explanation = mcpAuthExplanation(detail.manifest.auth, false);
  return new Response(
    mcpInstallMarkdown({
      siteUrl: SITE_URL,
      registryUrl: apiBaseUrl,
      item: detail.item,
      manifest: detail.manifest,
      authSummary: t(`authMethod.explain.${explanation.key}`, explanation.values),
    }),
    {
      headers: {
        "cache-control": "public, max-age=300",
        "content-type": "text/markdown; charset=utf-8",
        // The server's page is the one to index; this is its agent twin.
        "x-robots-tag": "noindex",
      },
    },
  );
}
