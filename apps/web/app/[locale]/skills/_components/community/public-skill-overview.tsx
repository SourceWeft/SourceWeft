import {
  getPublicSkill,
  marketSkillLocale,
} from "../../../../../lib/market-skills";
import { SkillAiOverviewView } from "../../../../dashboard/skills/_components/community/skill-ai-overview-view";
import { publicOverviewCopy } from "./public-overview-copy";
import type { PublicSkillSlotProps } from "./slot-props";

/**
 * The AI overview above SKILL.md (§17.4), in the page's language (English
 * when there is none in it). Read through the same cached market read as the
 * page, with the locale as part of its key. Nothing renders when the skill
 * has no overview, or the read fails: the overview is an extra, never a
 * reason for the page to break.
 *
 * Plain text only — `SkillAiOverviewView` renders the model's text as text.
 * Not used for the page's meta description, which stays the author's.
 */
export async function PublicSkillOverview({
  slug,
  locale,
}: PublicSkillSlotProps) {
  const requested = marketSkillLocale(locale);
  let overview;
  try {
    overview = (await getPublicSkill(slug, requested)).aiOverview ?? null;
  } catch {
    return null;
  }
  if (!overview) return null;
  return (
    <SkillAiOverviewView
      labels={publicOverviewCopy(locale).block}
      overview={overview}
      requestedLocale={requested}
    />
  );
}
