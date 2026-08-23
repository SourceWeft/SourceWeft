import { contentClient } from "../../../../../../lib/sdk";
import type { ArtifactListItem, ArtifactSummaryItem } from "../types";

type DetailEntry = {
  updatedAt: string;
  promise?: Promise<ArtifactListItem>;
  value?: ArtifactListItem;
};

const detailByArtifact = new Map<string, DetailEntry>();

function cacheKey(workspaceId: string, artifactId: string) {
  return `${workspaceId}:${artifactId}`;
}

export async function loadArtifactDetail(input: {
  workspaceId: string;
  summary: ArtifactSummaryItem;
  load?: (workspaceId: string, artifactId: string) => Promise<ArtifactListItem>;
}) {
  const { workspaceId, summary } = input;
  const key = cacheKey(workspaceId, summary.id);
  const cached = detailByArtifact.get(key);
  if (cached?.updatedAt === summary.updatedAt) {
    if (cached.value) return cached.value;
    if (cached.promise) return cached.promise;
  }

  const load =
    input.load ??
    (async (activeWorkspaceId: string, artifactId: string) =>
      (await contentClient.getArtifact(activeWorkspaceId, artifactId)).artifact);
  const entry: DetailEntry = { updatedAt: summary.updatedAt };
  const promise = load(workspaceId, summary.id)
    .then((artifact) => {
      if (detailByArtifact.get(key) === entry) {
        entry.value = artifact;
        entry.promise = undefined;
      }
      return artifact;
    })
    .catch((error) => {
      if (detailByArtifact.get(key) === entry) {
        detailByArtifact.delete(key);
      }
      throw error;
    });
  entry.promise = promise;
  detailByArtifact.set(key, entry);
  return promise;
}

export function invalidateArtifactDetail(
  workspaceId: string,
  artifactId: string,
) {
  detailByArtifact.delete(cacheKey(workspaceId, artifactId));
}

export function resetArtifactDetailCacheForTests() {
  detailByArtifact.clear();
}
