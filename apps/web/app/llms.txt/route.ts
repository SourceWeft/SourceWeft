import { SITE_URL } from "../seo";
import { llmsText } from "../skills/_components/agent-skill-md";

export const dynamic = "force-dynamic";

/**
 * The llms.txt convention: a short plain-text map of the site for language
 * models, pointing agents at the skills directory's SKILL.md.
 */
export function GET() {
  return new Response(llmsText(SITE_URL), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
