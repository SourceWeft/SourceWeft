/**
 * Why a model reply ended, read from a message's `response_metadata`. The
 * gateway owns the reading (a `chat/completions` finish reason, or a Responses
 * API status) so the agent's own check for a cut tool call cannot drift from
 * the gateway's. A pure function: it makes no model call, so it carries no
 * billing intent.
 */
export { finishReasonFromResponseMetadata } from "@sourceweft/model-gateway";
