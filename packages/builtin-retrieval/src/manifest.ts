import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";

export const builtinRetrievalCapabilityManifest: CapabilityManifestInput = {
  schemaVersion: 1,
  id: "sourceweft/retrieval",
  kind: "composite",
  name: "SourceWeft Retrieval",
  version: "0.1.0",
  entry: "./src/index.ts",
  tools: [
      {
        id: "search_sources",
        title: "Search Sources",
        description:
          "Search selected SourceWeft workspace sources and return citable context.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "read",
        options: [],
      },
  ],
  retrieval: [{ id: "workspace", title: "Workspace Retrieval" }],
};
