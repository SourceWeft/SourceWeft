/**
 * What a capability tells the host when it puts a model call on the bill.
 *
 * The fields are host vocabulary throughout — trace ids, gateway config, the
 * idempotency key settlement dedupes on. They live here rather than inside a
 * capability so the host can type the gateway it hands out without importing
 * whichever capability happens to call it first.
 */
export type AgentToolModelCallOptions = {
  readonly traceId?: string;
  readonly operation: string;
  readonly modelKind: string;
  readonly gatewayConfigId: string;
  readonly profileAlias: string;
  readonly modelAlias?: string | null;
  readonly referenceId?: string;
  /**
   * Must be derived from an id allocated BEFORE the call, so that a retry of
   * the same logical generation replays rather than charging twice.
   */
  readonly idempotencyKey: string;
  readonly llm?: unknown;
  readonly billingMetadata?: Record<string, unknown>;
};
