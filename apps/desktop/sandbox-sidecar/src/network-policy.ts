/**
 * The network policy engine: decides, for every outbound connection srt's proxy hands to the
 * ask callback, whether the sandboxed command may reach it, and keeps the per-command audit
 * trail of those decisions. It is pure apart from the injected `askHost`, clock and stderr
 * writer, so it is tested without srt, a socket or a clock.
 *
 * Why the sidecar decides every connection itself instead of giving srt an allow list: srt's
 * per-command allow lists cannot be combined with its strict allowlist and skip the ask
 * callback entirely, so they would give no connection-level audit. `allowedDomains` therefore
 * stays empty in the srt config and this engine is the single policy point.
 *
 * Attribution. srt's ask callback receives only `{host, port}`, never a command id. The host
 * runs commands one at a time (a semaphore in `remote_host.rs`), so exactly one command is
 * "active" between its `wrap` and its `cleanup`; every connection belongs to that command.
 * With zero or several active commands the connection cannot be attributed to a policy, so it
 * is denied (fail closed). The `probe` wrap never registers, so it is never counted.
 *
 * Order of checks, which is the whole security argument:
 *   1. the address guard (`deniedReason`) — authoritative. Private, loopback, link-local,
 *      metadata and own-interface addresses are denied in every mode, whatever a rule or an
 *      approval says. Nothing below can override it, and it runs before anything is looked up;
 *   2. attribution to the single active command;
 *   3. the command's mode: `open` allows, otherwise its allow list, then (`ask` only) the
 *      approvals already given to this command, then a live approval request to the user.
 *
 * Domain matching uses srt's own matcher and host canonicaliser (deep imports: the package has
 * no `exports` map), so a rule means exactly what it would mean in srt's own `allowedDomains`
 * and a host is compared in the spelling srt will actually dial.
 */
import {
  isValidAllowedDomainEntry,
  matchesDomainPatternWithPort,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { deniedReason } from "./address-guard.js";
import type { AuditEntry, AuditSource, WrapNetwork } from "./protocol.js";

/** How long a pending approval waits for the host's answer before it is denied. */
export const ASK_TIMEOUT_MS = 150_000;

/** At most this many audit entries are kept per command; later ones are dropped. */
const MAX_AUDIT_ENTRIES = 200;

/** Audited paths are cut to this many characters. */
const MAX_AUDIT_PATH = 200;

/** The `probe` wrap's command id: it makes no connections and is never an active command. */
const PROBE_COMMAND_ID = "probe";

/** What the policy asks the host (and through it the user) about one unknown connection. */
export type AskHostRequest = {
  commandId: string;
  /** Canonical host: the spelling srt will dial, and the one a trust rule is keyed on. */
  host: string;
  port: number;
  /** Name of the skill that declared this host, when one did (display only). */
  suggestedBy?: string;
  /**
   * Aborts when the policy stops waiting (timeout, or the command finished). The implementation
   * should forget the pending request when it fires.
   */
  signal: AbortSignal;
};

export type AskHostAnswer = { allow: boolean; reason?: string };

export type NetworkPolicyOptions = {
  /** The sandbox host's own interface addresses, for the address guard. */
  ownAddresses: () => Set<string>;
  askHost: (request: AskHostRequest) => Promise<AskHostAnswer>;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** The approval window; defaults to `ASK_TIMEOUT_MS`. Injectable for tests. */
  askTimeoutMs?: number;
  /** One line of diagnostics (no newline); defaults to the process's stderr. */
  warn?: (line: string) => void;
};

/** What `decide` answers srt: `true` allows, the object denies with a reason srt shows the model. */
export type NetworkDecision = true | { allow: false; reason: string };

type Verdict = { allow: boolean; reason?: string; source: AuditSource };

type CommandState = {
  mode: WrapNetwork["mode"];
  /** Valid srt domain patterns only. */
  rules: string[];
  /** Valid pattern → skill name, display only. */
  suggested: Array<[pattern: string, skill: string]>;
  /** `host:port` keys the user approved during this command. */
  approved: Set<string>;
  /** One in-flight approval per `host:port`, shared by concurrent connections. */
  inflight: Map<string, Promise<Verdict>>;
  /** Where each allowed `host:port` came from, so a later HTTP entry can name its source. */
  allowedBy: Map<string, AuditSource>;
  /** Settles every pending approval with a denial; called on unregister. */
  cancelPending: Set<() => void>;
  audit: AuditEntry[];
};

export type NetworkPolicy = {
  /** Starts counting `commandId` as the active command with `policy`. Invalid rules are dropped. */
  register(commandId: string, policy: WrapNetwork): void;
  /** Stops counting it, denies its pending approvals and drops its audit buffer. */
  unregister(commandId: string): void;
  decide(params: { host: string; port: number | undefined }): Promise<NetworkDecision>;
  /**
   * For a plain-HTTP request srt's proxy has parsed: attributes it to the single active command
   * now and returns the function that records it once the response status is known, or `null`
   * when it cannot be attributed (nothing is recorded then).
   */
  beginHttp(request: {
    host: string;
    port: number;
    method: string;
    path: string;
  }): ((status: number) => void) | null;
  /** Returns, and clears, the audit entries recorded for `commandId`. */
  drainAudit(commandId: string): AuditEntry[];
};

/** `host` in the spelling srt compares and dials. */
function canonical(host: string): string {
  return canonicalizeHost(host) ?? host;
}

function matchesAny(patterns: readonly string[], host: string, port: number): boolean {
  return patterns.some((pattern) => matchesDomainPatternWithPort(host, port, pattern));
}

/** A path with no query string or fragment, cut to `MAX_AUDIT_PATH` characters. */
function auditPath(path: string): string {
  const end = path.search(/[?#]/);
  return (end === -1 ? path : path.slice(0, end)).slice(0, MAX_AUDIT_PATH);
}

/** Two entries that differ only in their timestamp. */
function sameEvent(a: AuditEntry, b: AuditEntry): boolean {
  return (
    a.kind === b.kind &&
    a.host === b.host &&
    a.port === b.port &&
    a.decision === b.decision &&
    a.source === b.source &&
    a.reason === b.reason &&
    a.method === b.method &&
    a.path === b.path &&
    a.status === b.status
  );
}

export function createNetworkPolicy(options: NetworkPolicyOptions): NetworkPolicy {
  const now = options.now ?? Date.now;
  const askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_MS;
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const commands = new Map<string, CommandState>();

  /** The one active command, or `undefined` when there are none or several. */
  function singleActive(): [commandId: string, state: CommandState] | undefined {
    if (commands.size !== 1) return undefined;
    const [only] = commands;
    return only;
  }

  function record(state: CommandState, entry: AuditEntry): void {
    const last = state.audit[state.audit.length - 1];
    if (last !== undefined && sameEvent(last, entry)) return;
    if (state.audit.length >= MAX_AUDIT_ENTRIES) return;
    state.audit.push(entry);
  }

  function connectionEntry(host: string, port: number, verdict: Verdict): AuditEntry {
    const entry: AuditEntry = {
      t: now(),
      kind: "connection",
      host,
      port,
      decision: verdict.allow ? "allow" : "deny",
      source: verdict.source,
    };
    if (!verdict.allow && verdict.reason !== undefined) entry.reason = verdict.reason;
    return entry;
  }

  /** Raises one approval request and settles with the user's answer, a timeout or a cancel. */
  function askUser(
    commandId: string,
    state: CommandState,
    host: string,
    port: number,
  ): Promise<Verdict> {
    return new Promise<Verdict>((resolve) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (verdict: Verdict, abort: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.cancelPending.delete(cancel);
        if (abort) controller.abort();
        resolve(verdict);
      };
      const cancel = (): void =>
        finish({ allow: false, reason: "command finished", source: "unavailable" }, true);
      // Never keep the process alive on this timer: the approval is moot once the host is gone.
      const timer = setTimeout(
        () => finish({ allow: false, reason: "approval timed out", source: "timeout" }, true),
        askTimeoutMs,
      );
      timer.unref?.();
      state.cancelPending.add(cancel);

      const suggestedBy = state.suggested.find(([pattern]) =>
        matchesDomainPatternWithPort(host, port, pattern),
      )?.[1];
      const request: AskHostRequest = {
        commandId,
        host,
        port,
        ...(suggestedBy === undefined ? {} : { suggestedBy }),
        signal: controller.signal,
      };
      // Called synchronously, so the request line is written before `decide` first yields.
      let asked: Promise<AskHostAnswer>;
      try {
        asked = options.askHost(request);
      } catch (error) {
        asked = Promise.reject(error);
      }
      asked.then(
          (answer) =>
            finish(
              answer.allow
                ? { allow: true, source: "approval" }
                : { allow: false, reason: answer.reason ?? "denied by the user", source: "user" },
              false,
            ),
          (error: unknown) => {
            warn(
              `network approval for ${host}:${port} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            finish({ allow: false, reason: "approval unavailable", source: "unavailable" }, true);
          },
        );
    });
  }

  async function verdictFor(
    commandId: string,
    state: CommandState,
    host: string,
    port: number,
  ): Promise<Verdict> {
    if (state.mode === "open") return { allow: true, source: "open" };
    if (matchesAny(state.rules, host, port)) return { allow: true, source: "rule" };
    if (state.mode === "strict") {
      return {
        allow: false,
        reason: "host is not on the allow list (strict network mode)",
        source: "strict",
      };
    }
    const key = `${host}:${port}`;
    if (state.approved.has(key)) return { allow: true, source: "approval" };
    let flight = state.inflight.get(key);
    if (flight === undefined) {
      flight = askUser(commandId, state, host, port).then((verdict) => {
        if (verdict.allow) state.approved.add(key);
        return verdict;
      });
      state.inflight.set(key, flight);
      void flight.finally(() => state.inflight.delete(key));
    }
    return flight;
  }

  return {
    register(commandId, policy) {
      if (commandId === PROBE_COMMAND_ID) return;
      commands.get(commandId)?.cancelPending.forEach((cancel) => cancel());
      const rules = policy.allow.filter((entry) => isValidAllowedDomainEntry(entry));
      const suggested = Object.entries(policy.suggested ?? {}).filter(([pattern]) =>
        isValidAllowedDomainEntry(pattern),
      );
      const dropped =
        policy.allow.length - rules.length +
        Object.keys(policy.suggested ?? {}).length - suggested.length;
      if (dropped > 0) {
        const rejected = [
          ...policy.allow.filter((entry) => !isValidAllowedDomainEntry(entry)),
          ...Object.keys(policy.suggested ?? {}).filter((entry) => !isValidAllowedDomainEntry(entry)),
        ];
        warn(
          `network policy for command ${commandId}: dropped ${dropped} invalid domain entr${dropped === 1 ? "y" : "ies"}: ${rejected
            .slice(0, 5)
            .map((entry) => JSON.stringify(entry.slice(0, 80)))
            .join(", ")}`,
        );
      }
      commands.set(commandId, {
        mode: policy.mode,
        rules,
        suggested,
        approved: new Set(),
        inflight: new Map(),
        allowedBy: new Map(),
        cancelPending: new Set(),
        audit: [],
      });
    },

    unregister(commandId) {
      const state = commands.get(commandId);
      if (state === undefined) return;
      commands.delete(commandId);
      state.cancelPending.forEach((cancel) => cancel());
    },

    async decide({ host, port }) {
      const reason = deniedReason(host, options.ownAddresses());
      const active = singleActive();
      const spelled = canonical(host);

      if (reason !== null) {
        const verdict: Verdict = {
          allow: false,
          reason: `public internet only: ${reason}`,
          source: "guard",
        };
        if (active !== undefined && port !== undefined) {
          record(active[1], connectionEntry(spelled, port, verdict));
        }
        return { allow: false, reason: verdict.reason as string };
      }
      if (active === undefined) return { allow: false, reason: "no single active command" };
      if (port === undefined) return { allow: false, reason: "missing port" };

      const [commandId, state] = active;
      const verdict = await verdictFor(commandId, state, spelled, port);
      // The command may have finished while an approval was pending; its buffer is gone then.
      if (commands.get(commandId) === state) {
        record(state, connectionEntry(spelled, port, verdict));
        if (verdict.allow) state.allowedBy.set(`${spelled}:${port}`, verdict.source);
      }
      return verdict.allow ? true : { allow: false, reason: verdict.reason ?? "denied" };
    },

    beginHttp({ host, port, method, path }) {
      const active = singleActive();
      if (active === undefined) return null;
      const [commandId, state] = active;
      const spelled = canonical(host);
      const source = state.allowedBy.get(`${spelled}:${port}`) ?? "unavailable";
      return (status) => {
        if (commands.get(commandId) !== state) return;
        record(state, {
          t: now(),
          kind: "http",
          host: spelled,
          port,
          decision: "allow",
          source,
          method: method.slice(0, 16),
          path: auditPath(path),
          status,
        });
      };
    },

    drainAudit(commandId) {
      const state = commands.get(commandId);
      if (state === undefined) return [];
      return state.audit.splice(0, state.audit.length);
    },
  };
}
