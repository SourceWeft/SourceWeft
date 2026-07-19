export {
  resolveGlobalModelGatewayConfigPath,
  syncGlobalModelGatewayConfig,
} from "./config-sync";
export {
  listCustomByokProviders,
  resolveCustomByokProvider,
} from "./byok-provider-resolver";
/**
 * The unbilled accessors (`createAgentChatModel`, `getModelGatewayClient`) are
 * deliberately absent: reaching a model must go through withBilledModelGateway
 * so the call settles against a billing scope. `internal/raw.ts` is the one
 * sanctioned exception.
 */
export {
  ensureModelConfigAvailable,
  requireDefaultModelGatewayProfile,
  resolveModelGatewayProfile,
} from "./client";
export {
  openBilledModelGateway,
  withBilledModelGateway,
} from "./billed-client";
export type {
  BilledModelGateway,
  BilledRequestOptions,
} from "./billed-client";
export type {
  BillingIntent,
  CoveredReason,
  MeteredModelCallTrace,
  ModelUsageContext,
} from "./billing/context";
export type { BillingScope } from "./billing/scope";
export { BillingAdmissionError } from "./billing/admission";
export { resolveByokProviderRuntime } from "./runtime";
export { resolveModelCapabilitiesFromLitellm } from "./pricing";
export type {
  ModelGatewayProfileKind,
  RoutedGatewayConfig,
  RuntimeModelGatewayProfile,
} from "./types";
