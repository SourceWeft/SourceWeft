import type { ArtifactToolRuntimePromptProvider } from "./tool-prompt-provider";
import { imageRuntimePromptProvider } from "../tools/generate-image-tool";
import { pptxRuntimePromptProvider } from "../tools/generate-pptx-tool";
import { videoPresentationRuntimePromptProvider } from "../tools/generate-video-presentation-tool";

export const artifactToolRuntimePromptProviders: ArtifactToolRuntimePromptProvider[] = [
  imageRuntimePromptProvider,
  pptxRuntimePromptProvider,
  videoPresentationRuntimePromptProvider,
];