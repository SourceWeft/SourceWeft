import { getTranslations } from "next-intl/server";

import { apiBaseUrl } from "../../../../lib/api-base-url";
import {
  getPublicSkill,
  isMarketNotFound,
} from "../../../../lib/market-skills";
import { SITE_URL } from "../../../seo";
import { skillInstallMarkdown } from "../../../[locale]/skills/_components/agent-skill-md";

// The site and API addresses are injected at container start, so this is
// rendered per request rather than baked in at build time.
export const dynamic = "force-dynamic";

/**
 * One skill's install guide for AI agents: the facts to show the user and the
 * exact CLI command. The agent prompt on the skill's page points here. Always
 * English — it is read by models, whichever language the person browses in.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  let detail;
  try {
    detail = await getPublicSkill(decodeURIComponent(slug));
  } catch (error) {
    // Not public, withdrawn, or never existed — the same 404 as its page. An
    // outage is rethrown as a 5xx.
    if (isMarketNotFound(error)) {
      return new Response("Not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
  const t = await getTranslations({ locale: "en", namespace: "publicSkills" });
  return new Response(
    skillInstallMarkdown({
      siteUrl: SITE_URL,
      registryUrl: apiBaseUrl,
      detail,
      scanFlagLabels: t.raw("scanFlags") as Record<string, string>,
    }),
    {
      headers: {
        "cache-control": "public, max-age=300",
        "content-type": "text/markdown; charset=utf-8",
        // The skill's page is the one to index; this is its agent twin.
        "x-robots-tag": "noindex",
      },
    },
  );
}
