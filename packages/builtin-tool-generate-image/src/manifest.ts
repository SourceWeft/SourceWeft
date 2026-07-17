import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { generateImageToolOptions } from "./options";

export const builtinGenerateImageCapabilityManifest: CapabilityManifestInput = {
  schemaVersion: 1,
  id: "sourceweft/generate-image",
  kind: "tool",
  name: "Generate Image",
  version: "0.1.0",
  entry: "./src/index.ts",
  tools: [
      {
        id: "generate_image",
        title: "Generate Image",
        description:
          "Internal SourceWeft image artifact executor for image skills.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "write",
        options: generateImageToolOptions.map((option) => ({
          id: option.id,
          title: option.title,
          description: option.description,
          valueType: option.valueType,
          defaultValue: option.defaultValue,
          target: { path: option.target.path },
          values: option.values.map((value) => ({
            value: value.value,
            label: value.label,
          })),
        })),
        runtime: {
          execution: "agent",
          promptIntro:
            "Create a persisted image artifact only when this internal tool is explicitly enabled by an image skill runtime. The command is complete only when a published image artifact is created.",
          tools: ["generate_image"],
          permissionOverrides: { generate_image: "allow" },
          output: {
            kind: "artifact",
            artifactType: "image",
            publisherTool: "generate_image",
          },
        },
      },
  ],
};
