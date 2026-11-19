import { defaultPayerPorts } from "../content/payer-ports";
import {
  resolveGuidePayer,
  type GuidePayer,
  type GuidePayerPorts,
} from "../sources/guide-payer";
import { GroundedGenerationError } from "@sourceweft/contracts/grounded-generation";

/**
 * The person who asked for a generated artifact pays for it, always. Someone
 * who has since lost access to the workspace is not charged and nobody is
 * charged in their place: the generation fails with `SOURCE_NOT_READABLE`.
 */
export async function resolveRequesterPayer(
  input: {
    workspaceId: string;
    teamId: string;
    userId: string;
    /** Names the artifact in the failure message; "artifact" when omitted. */
    subject?: string;
  },
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
    throw new GroundedGenerationError(
      "SOURCE_NOT_READABLE",
      `The person who asked for this ${input.subject ?? "artifact"} can no longer read its sources`,
    );
  }
  return payer;
}
