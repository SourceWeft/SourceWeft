import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";

export const builtinPublishSandboxArtifactCapabilityManifest: CapabilityManifestInput =
  {
    schemaVersion: 1,
    id: "sourceweft/publish-sandbox-artifact",
    kind: "tool",
    name: "Publish Sandbox Artifact",
    version: "1.0.0",
    entry: "./src/index.ts",
    tools: [
      {
        id: "publish_sandbox_artifact",
        title: "Publish Sandbox Artifact",
        description:
          "Publish an existing sandbox-generated file as a SourceWeft artifact. Slides currently accept a sandbox .pptx source.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        options: [],
      },
    ],
  };
