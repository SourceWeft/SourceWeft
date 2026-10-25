/**
 * The srt `network.filterRequest` hook: per-request audit for everything the proxy parses (plain
 * HTTP, and HTTPS once TLS is terminated) and write approvals for the hosts of read-only secrets.
 *
 * It is not where network access is decided. Every connection was already judged by the ask
 * callback (`NetworkPolicy.decide`: address guard first, then the command's mode, allow list and
 * approvals) before srt's proxy got as far as parsing a request, and nothing here can widen that.
 * What it adds:
 *
 *  - Audit. Method, host, port, path (no query) and the response status of each request are
 *    recorded against the single active command (`NetworkPolicy.beginHttp`); a request that cannot
 *    be attributed is allowed and recorded nowhere.
 *  - Read-only secrets. A secret marked `readOnly` is meant for reading: the placeholder is
 *    substituted into any request to the secret's hosts, so a command could use it to change
 *    things on the user's behalf. For those hosts GET, HEAD and OPTIONS pass, and any other method
 *    asks the user first (once per command and host; the answer is cached, a denial too). Denied or
 *    timed-out: the request is answered 403 with the reason, which srt also shows the model as a
 *    `<sandbox_violations>` line.
 *
 * Failure policy. Recording is best effort and never changes what a command can do: a failure
 * there allows. The approval is the opposite: it is a security gate, so a failure to obtain an
 * answer denies.
 */
import type { FilterRequestCallback, RequestDecision } from "@anthropic-ai/sandbox-runtime";
import { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { WrapSecret } from "./protocol.js";

/** Methods that only read; every other method to a read-only secret's host needs approval. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export type RequestPolicy = {
  filterRequest: FilterRequestCallback;
  /** Remembers which hosts of `commandId` hold read-only secrets (the values are not kept). */
  registerCommand(commandId: string, secrets: readonly WrapSecret[]): void;
  unregisterCommand(commandId: string): void;
};

export function createRequestPolicy(
  network: Pick<NetworkPolicy, "beginHttp" | "decideRequest" | "activeCommandId">,
): RequestPolicy {
  /** Per command: the host patterns of its read-only secrets. */
  const readOnlyHosts = new Map<string, string[]>();

  const filterRequest: FilterRequestCallback = async (request, info) => {
    let url: URL;
    let host: string;
    let port: number;
    let path: string;
    const method = request.method.toUpperCase();
    try {
      url = new URL(request.url);
      const secure = info?.scheme === undefined ? url.protocol === "https:" : info.scheme === "https";
      host = info?.target?.host ?? url.hostname;
      port = info?.target?.port ?? (url.port === "" ? (secure ? 443 : 80) : Number(url.port));
      path = info?.requestTarget ?? url.pathname;
    } catch {
      return { action: "allow" };
    }

    let record: ReturnType<NetworkPolicy["beginHttp"]> = null;
    try {
      record = network.beginHttp({ host, port, method, path });
    } catch {
      // Recording is best effort.
    }

    if (!SAFE_METHODS.has(method) && isReadOnlySecretHost(host, port)) {
      let verdict;
      try {
        verdict = await network.decideRequest({ host, port, method, path });
      } catch {
        verdict = { allow: false as const, reason: "approval unavailable", source: "unavailable" as const };
      }
      if (!verdict.allow) {
        try {
          record?.(403, { source: verdict.source, reason: verdict.reason });
        } catch {
          // Best effort, as above.
        }
        return { action: "deny", status: 403, reason: verdict.reason };
      }
    }

    const decision: RequestDecision = { action: "allow" };
    if (record !== null) {
      decision.onResponse = (status) => {
        try {
          record(status);
        } catch {
          // Best effort, as above.
        }
      };
    }
    return decision;
  };

  /** Whether the single active command has a read-only secret bound to this destination. */
  function isReadOnlySecretHost(host: string, port: number): boolean {
    const commandId = network.activeCommandId();
    const patterns = commandId === undefined ? undefined : readOnlyHosts.get(commandId);
    if (patterns === undefined) return false;
    const canonical = canonicalizeHost(host) ?? host;
    return patterns.some((pattern) => matchesDomainPatternWithPort(canonical, port, pattern));
  }

  return {
    filterRequest,
    registerCommand(commandId, secrets) {
      const hosts = secrets.filter((secret) => secret.readOnly).flatMap((secret) => secret.hosts);
      if (hosts.length > 0) readOnlyHosts.set(commandId, hosts);
    },
    unregisterCommand(commandId) {
      readOnlyHosts.delete(commandId);
    },
  };
}
