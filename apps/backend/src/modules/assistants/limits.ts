/**
 * The fixed limits of a workspace assistant. Code constants on purpose: none
 * of them is an environment variable or a config flag (spec §14). Re-exported
 * from contracts so both the backend and the frontend read the same numbers.
 */
export { ASSISTANT_LIMITS } from "@sourceweft/contracts/assistants";
