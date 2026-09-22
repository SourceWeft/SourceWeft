import { getLandingMarketStats } from "../../../lib/landing-market-stats";
import { MarketStatsView } from "./market-stats-view";

export async function MarketStats() {
  return <MarketStatsView stats={await getLandingMarketStats()} />;
}
