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
 *    asks the user first. Each approval (and each denial) covers exactly that method, host and
 *    path for the command, so allowing `POST /issues/1/comments` says nothing about `POST /gists`.
 *    Denied or timed-out: the request is answered 403 with the reason, which srt also shows the
 *    model as a `<sandbox_violations>` line.
 *  - Placeholders in bodies. srt substitutes a placeholder in a request header, and also in the
 *    request body, with the real value. A header is what a credential is for; a body is a place
 *    where a command can send the secret into something it can later read (a gist, a comment, a
 *    paste). So a request to a bound host whose body carries a placeholder asks the user, for
 *    every method and for read-write secrets too, again per exact method, host and path. The body
 *    is read up to 1 MiB; a larger one, one that cannot be read, or a GET/HEAD/OPTIONS body the
 *    proxy does not show counts as carrying one.
 *  - Attribution. The gate is decided from every secret registered with the sidecar, not from
 *    the active command: when a request cannot be tied to exactly one command, a write to a
 *    read-only secret's host, or a body with a placeholder, is denied rather than waved through.
 *
 * Failure policy. Recording is best effort and never changes what a command can do: a failure
 * there allows. The approval is the opposite: it is a security gate, so a failure to obtain an
 * answer denies.
 */
import type { FilterRequestCallback, RequestDecision, RequestInfo } from "@anthropic-ai/sandbox-runtime";
import { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { AuditSource, WrapSecret } from "./protocol.js";

/** Methods that only read; every other method to a read-only secret's host needs approval. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** The largest request body that is scanned for placeholders; a larger one counts as carrying one. */
const MAX_SCANNED_BODY_BYTES = 1024 * 1024;

/** One secret as the request policy sees it: where it is bound and how to recognise its placeholder. */
type BoundSecret = { hosts: readonly string[]; readOnly: boolean; placeholder: string };

export type RequestPolicy = {
  filterRequest: FilterRequestCallback;
  /**
   * Remembers `commandId`'s secrets: their hosts, whether they are read-only, and the placeholder
   * each was given (`secretEnv`, by environment variable name). The values are not kept.
   */
  registerCommand(
    commandId: string,
    secrets: readonly WrapSecret[],
    placeholders: Readonly<Record<string, string>>,
  ): void;
  unregisterCommand(commandId: string): void;
};

/**
 * Whether the body of `request` carries any of `placeholders`. True also when it cannot be told:
 * a body over `MAX_SCANNED_BODY_BYTES`, a read that fails, or a bodyless method whose body the
 * proxy did not show (`info.unshownBody`).
 */
async function bodyCarriesPlaceholder(
  request: Request,
  info: RequestInfo | undefined,
  placeholders: readonly string[],
): Promise<boolean> {
  try {
    if (request.body === null) {
      return info?.unshownBody === undefined ? false : await info.unshownBody();
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SCANNED_BODY_BYTES) {
        reader.cancel().catch(() => {});
        return true;
      }
      chunks.push(value);
    }
    // Placeholders are plain ASCII and srt matches them as raw bytes, so a byte search over the
    // whole (bounded) body is exactly what srt would substitute, including across chunk borders.
    const body = Buffer.concat(chunks);
    return placeholders.some((placeholder) => body.includes(placeholder));
  } catch {
    return true;
  }
}

export function createRequestPolicy(
  network: Pick<NetworkPolicy, "beginHttp" | "decideRequest" | "activeCommandId">,
): RequestPolicy {
  /** Every registered command's secrets: the gate is decided from all of them. */
  const registry = new Map<string, BoundSecret[]>();

  /** The registered secrets bound to this destination, whichever command registered them. */
  function boundTo(host: string, port: number): BoundSecret[] {
    const canonical = canonicalizeHost(host) ?? host;
    return [...registry.values()]
      .flat()
      .filter((secret) => secret.hosts.some((pattern) => matchesDomainPatternWithPort(canonical, port, pattern)));
  }

  const filterRequest: FilterRequestCallback = async (request, info) => {
    let host: string;
    let port: number;
    let path: string;
    const method = request.method.toUpperCase();
    try {
      const url = new URL(request.url);
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

    const denied = async (): Promise<{ reason: string; source: AuditSource } | null> => {
      const bound = boundTo(host, port);
      if (bound.length === 0) return null;
      const safe = SAFE_METHODS.has(method);
      const readOnly = bound.some((secret) => secret.readOnly);
      const carries = await bodyCarriesPlaceholder(request, info, bound.map((secret) => secret.placeholder));
      if (network.activeCommandId() === undefined) {
        // Which command sent this is unknown, so there is no one to ask about and no secret that
        // can be assumed harmless: refuse what could change something or carry a secret out.
        if ((!safe && readOnly) || carries) {
          return { reason: "no single active command", source: "unavailable" };
        }
        return null;
      }
      if (!carries && (safe || !readOnly)) return null;
      let verdict;
      try {
        verdict = await network.decideRequest({ host, port, method, path, secretInBody: carries });
      } catch {
        verdict = { allow: false as const, reason: "approval unavailable", source: "unavailable" as const };
      }
      if (verdict.allow) return null;
      return {
        reason: carries ? `request body contains a stored secret: ${verdict.reason}` : verdict.reason,
        source: verdict.source,
      };
    };

    const refusal = await denied();
    if (refusal !== null) {
      try {
        record?.(403, refusal);
      } catch {
        // Best effort, as above.
      }
      return { action: "deny", status: 403, reason: refusal.reason };
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

  return {
    filterRequest,
    registerCommand(commandId, secrets, placeholders) {
      const bound: BoundSecret[] = [];
      for (const secret of secrets) {
        const placeholder = placeholders[secret.envVar];
        if (placeholder === undefined) continue;
        bound.push({ hosts: secret.hosts, readOnly: secret.readOnly, placeholder });
      }
      if (bound.length > 0) registry.set(commandId, bound);
    },
    unregisterCommand(commandId) {
      registry.delete(commandId);
    },
  };
}
