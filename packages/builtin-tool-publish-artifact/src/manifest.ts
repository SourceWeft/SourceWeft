import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";

export const builtinPublishArtifactCapabilityManifest: CapabilityManifestInput =
  {
    schemaVersion: 1,
    id: "sourceweft/publish-artifact",
    kind: "tool",
    name: "Publish Artifact",
    version: "1.0.0",
    entry: "./src/index.ts",
    tools: [
      {
        id: "publish_artifact",
        title: "Publish Artifact",
        description:
          "Publish an existing file as a SourceWeft artifact. Use artifactType=slides with a PPTX source and previewImage from final QA, artifactType=html for self-contained HTML, or artifactType=file for generic downloadable files from sandbox_path or work_file sources.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        options: [],
      },
      {
        id: "review_html_visuals",
        title: "Review HTML Visuals",
        description:
          "Review final HTML screenshots with the configured vision model and task-specific quality criteria.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "read",
        options: [],
      },
    ],
  };
