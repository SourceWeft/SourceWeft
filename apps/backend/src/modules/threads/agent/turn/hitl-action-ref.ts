/**
 * Stable, payload-derived id for an interrupted HITL action, used as the
 * confirmation / trace / render-block key in place of a checkpoint tool-call id.
 *
 * Deterministic across the approve→resume round trip (the same interrupt
 * re-fires at the same checkpoint in the same order), and it never reads graph
 * state, so an interrupt raised inside a sub-agent subgraph (whose tool-call id
 * never surfaces in the top-level graph) binds correctly.
 *
 * Lives in its own leaf module — with no service, config, or graph imports — so
 * the sub-agent correlation contract can be tested in isolation.
 */
export function hitlActionRef(input: {
  checkpointId: string;
  index: number;
  interruptId?: string;
  toolName: string;
}) {
  return `hitl:${input.interruptId ?? input.checkpointId}:${input.index}:${input.toolName}`;
}
