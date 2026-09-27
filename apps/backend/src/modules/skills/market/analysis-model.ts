import { resolveSystemModelIdentity } from "../../../shared/model-gateway/system-client";
import { skillAnalysisModelConfigurationKey } from "./analysis-evaluation";

/**
 * The key analyses from the configured system model are stored under, so a
 * change of model or endpoint makes earlier results stale while a key
 * rotation does not. Null while the system model is not configured.
 */
export async function resolveSkillAnalysisModelKey(): Promise<string | null> {
  const identity = await resolveSystemModelIdentity();
  return identity ? skillAnalysisModelConfigurationKey(identity) : null;
}
