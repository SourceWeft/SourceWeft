import {
  getPublicSkill,
  isMarketNotFound,
} from "../../../../lib/market-skills";
import {
  badgeKeyFromPath,
  badgeNotFound,
  listedBadge,
} from "../../listed-badge-response";

/**
 * The "Listed on SourceWeft" README badge of one skill:
 * `/badge/skills/<slug>.svg`. The same picture for every listed skill; 404
 * once it is not listed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const slug = badgeKeyFromPath([(await params).file]);
  if (!slug) return badgeNotFound();
  try {
    await getPublicSkill(slug);
  } catch (error) {
    if (isMarketNotFound(error)) return badgeNotFound();
    throw error;
  }
  return listedBadge(request);
}
