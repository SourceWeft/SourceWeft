/**
 * The sidecar's stdio protocol: one JSON object per line each way. A later task (Task 3)
 * implements the server that speaks this; a Rust client (Task 4, already in
 * `apps/desktop/src-tauri/src/local_host/sidecar.rs`) speaks exactly this shape. Keep the
 * names and shapes here in sync with that Rust client rather than the other way around.
 */

/**
 * The bundle protocol version, returned by `init` as `{ protocolVersion }`. The host requires
 * an exact match with its own copy (`SANDBOX_PROTOCOL_VERSION` in
 * `apps/desktop/src-tauri/src/local_host/sidecar.rs`; keep the two equal) and refuses to use a
 * bundle that reports anything else, so a stale sidecar can never silently ignore policy it
 * does not understand. Bump this whenever the init, policy or wrap semantics change (for
 * example a new `InitConfig` policy field), in the same change that updates the Rust constant.
 *
 * History:
 *  - 1: the first handshake (init, wrap, violations, cleanup, probe, shutdown).
 *  - 2: network approvals (Plan 4). `wrap.network` (mode, allow list, suggested), the
 *    unsolicited `ask` event lines, the `ask.reply` and `audit` ops, and `AuditSource`. A
 *    version-1 sidecar would ignore `wrap.network` and allow every public host, which is why a
 *    host that needs approvals must refuse it.
 */
export const SANDBOX_PROTOCOL_VERSION = 2;

/** Sent once, before any other request, to hand the sidecar its policy inputs. */
export type InitConfig = {
  platform: "linux" | "darwin";
  home: string;
  workspaceRoots: string[];
  readRoots: string[];
  /** Extra literal read denies on top of `home` (e.g. the host's own database); optional. */
  denyRoots?: string[];
  helpers: {
    ripgrep: string;
    applySeccomp?: string;
    javaAgentJar?: string;
  };
  bwrapPath?: string;
};

/** One inbound request line, always carrying its own `id` for correlation with the reply. */
export type Request = { id: string } & (
  | { op: "init"; config: InitConfig }
  | {
      op: "wrap";
      commandId: string;
      command: string;
      cwd: string;
      workspaceRoot: string;
      /** Per-command network policy; absent means `open`. See "Network approvals" below. */
      network?: WrapNetwork;
    }
  | { op: "violations"; commandId: string; stderr: string }
  | { op: "cleanup"; commandId: string }
  | { op: "probe" }
  | { op: "shutdown" }
  | AskReplyRequest
  | AuditRequest
);

/** One outbound reply line, matched to its request by `id`. */
export type Response =
  | { id: string; ok: true; result: unknown }
  | {
      id: string;
      ok: false;
      error: { code: SidecarErrorCode; message: string };
    };

export type SidecarErrorCode =
  | "NOT_INITIALIZED"
  | "HELPER_MISSING"
  | "SANDBOX_UNAVAILABLE"
  | "POLICY_INVALID"
  | "BAD_REQUEST";

/** The `result` payload of a successful `wrap` response. */
export type WrapResult = { argv: string[]; env: Record<string, string> };

// ---------------------------------------------------------------------------------------------
// Network approvals (additive: nothing above changes shape).
// ---------------------------------------------------------------------------------------------

/**
 * `open` allows every public host (the address guard still applies); `ask` allows the allow
 * list and raises an approval for anything else while the command keeps running; `strict`
 * allows the allow list only and never asks.
 */
export type NetworkMode = "open" | "ask" | "strict";

/**
 * The network policy a `wrap` request carries for its one command. `allow` holds srt domain
 * patterns (`example.com`, `*.example.com`, `example.com:443`); `suggested` maps a pattern to
 * the name of the skill that declared it and is display-only (it never allows anything).
 */
export type WrapNetwork = {
  mode: NetworkMode;
  allow: string[];
  suggested?: Record<string, string>;
};

/** Host to sidecar: the user's answer to an `ask` event line. Answered `ok` with `null`. */
export type AskReplyRequest = {
  id: string;
  op: "ask.reply";
  askId: string;
  allow: boolean;
  reason?: string;
};

/** Host to sidecar: returns, and drains, the audit entries recorded for one command. */
export type AuditRequest = { id: string; op: "audit"; commandId: string };

/** The `result` payload of a successful `audit` response. */
export type AuditResult = { entries: AuditEntry[] };

/** Where an audited decision came from. */
export type AuditSource =
  | "open"
  | "rule"
  | "skill"
  | "approval"
  | "strict"
  | "guard"
  | "user"
  | "timeout"
  | "unavailable"
  /** A per-command bound (pending approvals, tracked hosts) refused the connection. */
  | "limit";

/**
 * One audited network decision. `connection` entries record a host:port decision;
 * `http` entries add the method, the path (never the query or fragment, at most 200 characters)
 * and the response status of a plain-HTTP request the proxy parsed.
 */
export type AuditEntry = {
  /** Epoch milliseconds. */
  t: number;
  kind: "connection" | "http";
  host: string;
  port: number;
  decision: "allow" | "deny";
  source: AuditSource;
  reason?: string;
  method?: string;
  path?: string;
  status?: number;
};

/**
 * An unsolicited sidecar-to-host line. Unlike a `Response` it has `event` instead of `id`.
 * `ask` announces a connection that needs the user's approval; the host answers it with an
 * `ask.reply` carrying the same `askId`.
 */
export type SidecarEvent = {
  event: "ask";
  askId: string;
  commandId: string;
  host: string;
  port: number;
  suggestedBy?: string;
};
