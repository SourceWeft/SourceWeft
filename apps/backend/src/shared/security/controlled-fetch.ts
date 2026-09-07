import { Agent } from "undici";
import {
  checkEndpointUrl,
  EndpointPolicyError,
  resolveEndpointAddresses,
  type EndpointLookup,
  type EndpointPolicy,
} from "./endpoint-policy";

/** One auth operation or MCP connection owns this scope and closes its agents. */
export function createControlledFetch(
  policyInput: EndpointPolicy,
  options: { lookup?: EndpointLookup } = {},
) {
  const policy = {
    enforceAddressChecks: policyInput.enforceAddressChecks,
    allowedInternalOrigins: [...policyInput.allowedInternalOrigins],
  };
  const agents = new Map<string, Agent>();
  let denied: EndpointPolicyError | undefined;
  let closed = false;
  const throwIfDenied = () => {
    if (denied) throw denied;
  };

  function rememberDenial(error: unknown) {
    if (error instanceof EndpointPolicyError) denied ??= error;
  }

  function agentFor(url: URL) {
    let agent = agents.get(url.origin);
    if (agent) return agent;
    agent = new Agent({
      connect: {
        lookup: (_hostname, lookupOptions, callback) => {
          // Resolve and validate inside socket creation. No second DNS lookup
          // occurs after validation, and pooled sockets retain the approved IP.
          resolveEndpointAddresses(url, policy, options.lookup).then(
            (addresses) => {
              if (lookupOptions.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            },
            (error: unknown) => {
              rememberDenial(error);
              callback(
                error instanceof Error
                  ? error
                  : new Error("Endpoint DNS lookup failed"),
                "",
                0,
              );
            },
          );
        },
      },
    });
    agents.set(url.origin, agent);
    return agent;
  }

  const controlledFetch: typeof globalThis.fetch = async (input, init) => {
    throwIfDenied();
    if (closed) throw new Error("Controlled request scope is closed");
    try {
      // Validate before Request's constructor, whose credentialed-URL error can
      // include the raw URL. Our errors never echo pasted credential values.
      checkEndpointUrl(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        policy,
      );
      let request = new Request(input, init);
      for (let redirects = 0; ; redirects++) {
        throwIfDenied();
        const url = checkEndpointUrl(request.url, policy);
        const response = await globalThis.fetch(request.clone(), {
          redirect: "manual",
          dispatcher: agentFor(url),
        } as RequestInit & { dispatcher: Agent });
        const location = response.headers.get("location");
        if (
          !location ||
          ![301, 302, 303, 307, 308].includes(response.status) ||
          request.redirect === "manual"
        )
          return response;
        await response.body?.cancel();
        if (request.redirect === "error" || redirects >= 3) {
          throw new EndpointPolicyError(
            "redirect",
            "Endpoint redirect is not allowed or exceeded its limit.",
          );
        }
        const next = checkEndpointUrl(
          new URL(location, url).toString(),
          policy,
        );
        // Reject rather than guessing which custom headers or body fields hold
        // credentials. OAuth may still make separate requests to its issuer.
        if (next.origin !== url.origin)
          throw new EndpointPolicyError(
            "redirect",
            "Cross-origin endpoint redirects are not allowed; configure the destination endpoint directly.",
          );
        const becomesGet =
          (response.status === 303 && request.method !== "HEAD") ||
          ([301, 302].includes(response.status) && request.method === "POST");
        const headers = new Headers(request.headers);
        if (becomesGet) {
          for (const name of [
            "content-type",
            "content-length",
            "content-encoding",
            "content-language",
            "content-location",
          ])
            headers.delete(name);
        }
        request = new Request(next, {
          method: becomesGet ? "GET" : request.method,
          headers,
          body:
            becomesGet || ["GET", "HEAD"].includes(request.method)
              ? undefined
              : request.body,
          signal: request.signal,
          redirect: request.redirect,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
      }
    } catch (error) {
      rememberDenial(error);
      throwIfDenied(); // Undici / OAuth may otherwise wrap or swallow the denial.
      throw error;
    }
  };

  return {
    fetch: controlledFetch,
    throwIfDenied,
    async close() {
      closed = true;
      const pending = [...agents.values()].map((agent) => agent.destroy());
      agents.clear();
      await Promise.all(pending);
    },
  };
}
