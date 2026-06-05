import type { ArtifactIntentDecision } from "../../artifacts/types";
import type { GeneratePptxToolSelection } from "../../artifacts/types";
import type { GenerateVideoPresentationToolSelection } from "../../artifacts/types";

export type RuntimePromptContext = {
  availableArtifactTools: string[];
  availableWebTools: string[];
  availableMcpTools: string[];
  currentDate: string;
  artifactIntent?: ArtifactIntentDecision;
  generatePptxTool?: GeneratePptxToolSelection;
  generateVideoPresentationTool?: GenerateVideoPresentationToolSelection;
};

export interface ArtifactToolRuntimePromptProvider {
  buildLines(context: RuntimePromptContext): string[];
}