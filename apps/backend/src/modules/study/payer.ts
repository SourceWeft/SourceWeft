import { defaultPayerPorts } from "../content/payer-ports";
import {
  resolveGuidePayer,
  type GuidePayer,
  type GuidePayerPorts,
} from "../sources/guide-payer";
import { StudyGenerationError } from "./engine";

/**
 * The person who asked for a study artifact pays for it, always. Someone who
 * has since lost access to the workspace is not charged and nobody is charged
 * in their place: the generation fails with `SOURCE_NOT_READABLE`.
 */
export async function resolveStudyPayer(
  input: { workspaceId: string; teamId: string; userId: string },
  ports: GuidePayerPorts = defaultPayerPorts,
): Promise<GuidePayer> {
  const payer = await resolveGuidePayer(
    {
      workspaceId: input.workspaceId,
      organizationId: input.teamId,
      initiatorUserId: input.userId,
    },
    ports,
  );
  if (!payer) {
    throw new StudyGenerationError(
      "SOURCE_NOT_READABLE",
      "The person who asked for this study artifact can no longer read its sources",
    );
  }
  return payer;
}
