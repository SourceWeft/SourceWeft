import type { ArtifactSharedCollection } from "@sourceweft/contracts/artifact-records";
import { listSharedCollections } from "../artifact-records/shared-collections";
import { sharingService, type ShareMutationResult } from "./service";

/**
 * Lists the shared collections an owner may mark public. Authorized exactly
 * like share management (creator, or content admin who can view the artifact),
 * so it reveals nothing the sharing controls would not already let them see.
 */
export async function listArtifactShareCollections(input: {
  workspaceId: string;
  artifactId: string;
  userId: string;
}): Promise<ShareMutationResult<ArtifactSharedCollection[]>> {
  const resolved = await sharingService.requireShareableArtifact(input);
  if (!resolved.ok) {
    return resolved;
  }
  return { ok: true, value: await listSharedCollections(resolved.artifact.id) };
}
