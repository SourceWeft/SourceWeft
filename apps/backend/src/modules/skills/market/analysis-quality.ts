import { eq } from "drizzle-orm";
import { db, skillMarketSettings } from "@sourceweft/db";
import { resolveModelGatewayProfile } from "../../../shared/model-gateway/index";
import { resolveSkillAnalysisModelKey } from "./analysis-model";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";
export async function currentSkillAnalysisModelKey() {
  const profile = await resolveModelGatewayProfile({
    kind: "chat",
    defaultRequired: false,
  });
  return profile ? resolveSkillAnalysisModelKey(profile) : null;
}
export async function skillAnalysisQualityApproved() {
  const [setting] = await db
    .select()
    .from(skillMarketSettings)
    .where(eq(skillMarketSettings.key, "analysis.quality"));
  const value = setting?.value as
    | {
        promptVersion?: string;
        taxonomyVersion?: string;
        total?: number;
        accuracy?: number;
        baselineAccuracy?: number;
        reviewed?: boolean;
        modelConfigurationKey?: string;
      }
    | undefined;
  if (!value?.reviewed) return false;
  const profile = await resolveModelGatewayProfile({
    kind: "chat",
    defaultRequired: false,
  });
  if (
    !profile ||
    value.modelConfigurationKey !==
      (await resolveSkillAnalysisModelKey(profile))
  )
    return false;
  return Boolean(
    value?.reviewed &&
    value.promptVersion === SKILL_ANALYSIS_PROMPT_VERSION &&
    value.taxonomyVersion === SKILL_ANALYSIS_TAXONOMY_VERSION &&
    (value.total ?? 0) >= 100 &&
    (value.accuracy ?? 0) >= 0.9 &&
    (value.accuracy ?? 0) - (value.baselineAccuracy ?? 1) >= 0.1 - 1e-9,
  );
}
