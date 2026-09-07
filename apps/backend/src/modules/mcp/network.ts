import { config } from "../../shared/config";
import { createControlledFetch } from "../../shared/security/controlled-fetch";
import { EndpointPolicyError } from "../../shared/security/endpoint-policy";
import { McpError } from "./errors";

export function createMcpRequestScope() {
  const requests = createControlledFetch({
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: config.mcpAllowedInternalOrigins ?? [],
  });
  return {
    ...requests,
    throwIfDenied() {
      try {
        requests.throwIfDenied();
      } catch (error) {
        if (error instanceof EndpointPolicyError)
          throw new McpError(400, "MCP_ENDPOINT_BLOCKED", error.message);
        throw error;
      }
    },
  };
}
