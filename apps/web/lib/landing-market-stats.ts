import "server-only";
import { requirePublicMcpCounts } from "./market-mcp";
import { requirePublicSkillCategories } from "./market-skills";

export type LandingMarketStats = { mcp: number | null; skills: number | null };

export async function getLandingMarketStats(): Promise<LandingMarketStats> {
  const [mcp, skills] = await Promise.allSettled([
    requirePublicMcpCounts(),
    requirePublicSkillCategories(),
  ]);
  // Never turn a failed read into a zero or cache a fabricated count.
  if (mcp.status === "rejected") console.warn("Landing MCP count unavailable");
  if (skills.status === "rejected")
    console.warn("Landing Skills count unavailable");
  return {
    mcp: mcp.status === "fulfilled" ? mcp.value.total : null,
    skills: skills.status === "fulfilled" ? skills.value.total : null,
  };
}
