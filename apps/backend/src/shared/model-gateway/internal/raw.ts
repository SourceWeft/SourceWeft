/**
 * The unbilled gateway accessors.
 *
 * Everything else in the backend must go through `withBilledModelGateway`, so
 * that no model call can be made without declaring a billing intent. This module
 * is the one sanctioned exception, and is deliberately not re-exported from the
 * package index — reaching it requires importing this path by name.
 */
export {
  getModelGatewayClient as getRawModelGatewayClient,
  createAgentChatModel as createRawAgentChatModel,
} from "../client";
