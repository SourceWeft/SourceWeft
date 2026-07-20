import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { normalizeGenerateImageToolSelection } from "./image-config";
import { resolveImageModelCapabilities } from "./image-capabilities";
import { IMAGE_MODEL_CATALOG_KEY } from "./image-types";
import { generateImagePresentation } from "./presentation";
import { generateImageTurnPreflight } from "./turn-preflight";

export const generateImageAgentTool = defineAgentTool({
  id: "generateImage",
  name: "generate_image",
  domain: "artifact",
  capabilities: ["artifact", "generated_image_artifact"],
  presentation: generateImagePresentation,
  requirements: {
    modelKind: "image",
  },
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  configuration: {
    configurable: true,
    configKeys: ["aspectRatio", "quality", "style"],
  },
  defaultPermission: "allow",
  riskLevel: "low",
  turnSelection: {
    normalize: (raw) => normalizeGenerateImageToolSelection(raw),
    // Asking for this tool by name means "make a picture", never "edit the one
    // already attached" — the host only knows the invocation was explicit.
    directInvokeDefaults: { mode: "generate" },
  },
  // Whether a picture can be made at all this turn depends on the workspace's
  // image models and the user's key, which only an async host lookup answers.
  turnPreflight: generateImageTurnPreflight,
  modelCatalog: {
    // Same key the tool's options point at from `options.ts`.
    key: IMAGE_MODEL_CATALOG_KEY,
    describe: (input) =>
      resolveImageModelCapabilities({
        configJson: input.configJson,
        providerKind: input.providerKind,
        modelId: input.modelId,
      }),
  },
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const GENERATE_IMAGE_TOOL_NAME = generateImageAgentTool.name;

export const generateImageAgentToolDefs = [generateImageAgentTool] as const;
