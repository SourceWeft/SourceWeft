import type { contentClient } from "../../../../../lib/sdk";

export type ArtifactListItem = Awaited<
  ReturnType<typeof contentClient.getArtifact>
>["artifact"];

export type ArtifactSummaryItem = Awaited<
  ReturnType<typeof contentClient.listArtifactSummaries>
>["items"][number];
