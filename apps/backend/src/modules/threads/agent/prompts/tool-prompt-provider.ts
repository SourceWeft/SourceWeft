export type RuntimePromptContext = {
  availableArtifactTools: string[];
  availableWebTools: string[];
  availableMcpTools: string[];
  currentDate: string;
  artifactIntent?: unknown;
  runtimeTools?: Readonly<
    Record<
      string,
      {
        enabled?: boolean;
        options?: unknown;
        selection?: unknown;
        shouldBind?: boolean;
      }
    >
  >;
};

export interface ArtifactToolRuntimePromptProvider {
  buildLines(context: RuntimePromptContext): string[];
}
