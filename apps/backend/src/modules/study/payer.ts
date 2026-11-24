import type { GuidePayer, GuidePayerPorts } from "../sources/guide-payer";
import { defaultPayerPorts } from "../content/payer-ports";
import { resolveRequesterPayer } from "../grounded-generation/payer";

/**
 * The person who asked for a study artifact pays for it, always; see
 * `resolveRequesterPayer`.
 */
export function resolveStudyPayer(
  input: { workspaceId: string; teamId: string; userId: string },
  ports: GuidePayerPorts = defaultPayerPorts,
): Promise<GuidePayer> {
  return resolveRequesterPayer({ ...input, subject: "study artifact" }, ports);
}
