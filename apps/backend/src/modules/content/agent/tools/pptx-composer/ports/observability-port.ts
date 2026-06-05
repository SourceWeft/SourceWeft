export type ComposerObservabilityEvent = {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
};

export type ObservabilityPort = {
  recordEvent(event: ComposerObservabilityEvent): void | Promise<void>;
};
