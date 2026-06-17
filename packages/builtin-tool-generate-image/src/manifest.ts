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
        description: "Generate a persisted SourceWeft image artifact.",
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
          execution: "direct",
          promptIntro:
            "Create an image artifact from the user's request. The command is complete only when an image artifact is created.",
          tools: ["generate_image"],
          permissionOverrides: { generate_image: "allow" },
          output: {
            kind: "artifact",
            artifactType: "image",
            publisherTool: "generate_image",
          },
        },
        command: {
          aliases: ["image"],
          category: "Artifacts",
        },
      },
  ],
};
