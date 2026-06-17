export type RetrievalPipelineStage<
  TState extends object,
  TContext extends object = Record<string, never>,
> = {
  readonly name: string;
  run(state: TState, context?: TContext): Promise<TState>;
};
