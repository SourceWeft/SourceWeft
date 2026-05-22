import type { contentClient } from "../../../../../lib/sdk";

export type ArtifactListItem = Awaited<
  ReturnType<typeof contentClient.listArtifacts>
>["items"][number];
