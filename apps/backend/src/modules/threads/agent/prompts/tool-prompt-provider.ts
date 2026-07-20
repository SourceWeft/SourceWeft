export type RuntimePromptContext = {
  availableArtifactTools: string[];
  availableWebTools: string[];
  availableMcpTools: string[];
  currentDate: string;
  /**
   * What each capability's turn preflight parked, keyed by tool name. Passed
   * through untouched; a provider reads only its own entry.
   */
  turnState?: Readonly<Record<string, unknown>>;
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
