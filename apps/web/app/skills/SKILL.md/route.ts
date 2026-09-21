import { apiBaseUrl } from "../../../lib/api-base-url";
import { SITE_URL } from "../../seo";
import { agentSkillMarkdown } from "../../[locale]/skills/_components/agent-skill-md";

// The site and API addresses are injected at container start, so this is
// rendered per request rather than baked in at build time.
export const dynamic = "force-dynamic";

/**
 * The skills directory as a SKILL.md, for AI agents: how to search, inspect and
 * install from here with the SourceWeft CLI. The same answer for every client —
 * people get the directory at /skills, agents are pointed here by /llms.txt and
 * the page's `rel="alternate"` link, never by sniffing a User-Agent.
 */
export function GET() {
  return new Response(
    agentSkillMarkdown({ siteUrl: SITE_URL, registryUrl: apiBaseUrl }),
    {
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": "text/markdown; charset=utf-8",
      },
    },
  );
}
