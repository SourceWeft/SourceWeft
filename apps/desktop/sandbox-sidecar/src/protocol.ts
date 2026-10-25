/**
 * The sidecar's stdio protocol: one JSON object per line each way. A later task (Task 3)
 * implements the server that speaks this; a Rust client (Task 4, already in
 * `apps/desktop/src-tauri/src/local_host/sidecar.rs`) speaks exactly this shape. Keep the
 * names and shapes here in sync with that Rust client rather than the other way around.
 */

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
  /**
   * Presence turns on TLS termination (the sandbox's HTTPS is decrypted and re-originated by the
   * sidecar, which is what lets it audit requests and swap secret placeholders for real values).
   * Absent, the sidecar behaves exactly as without secrets. Changing it needs a new sidecar.
   * See "Secrets and request policy" below.
   */
  tls?: TlsInit;
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
      /** Secrets to mask for this command; needs `init.tls`. See "Secrets" below. */
      secrets?: WrapSecret[];
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
export type WrapResult = {
  argv: string[];
  env: Record<string, string>;
  /**
   * The placeholder for each of the request's `secrets`, by environment variable name. The host
   * must put these in the command's environment; they are never in `argv` or `env`. Empty when
   * the request had no secrets.
   */
  secretEnv: Record<string, string>;
};

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
  /** Absent for the original question (may the command connect to this host); see `request`. */
  kind?: "request";
  host: string;
  port: number;
  suggestedBy?: string;
  /** `kind: "request"` only: the write request awaiting approval. `path` has no query string. */
  method?: string;
  path?: string;
};

// ---------------------------------------------------------------------------------------------
// Secrets and request policy (additive).
// ---------------------------------------------------------------------------------------------

/** Where the persistent TLS-termination CA lives (`ca.crt`, `ca.key`); absolute. */
export type TlsInit = { caDir: string };

/**
 * One secret to mask for a command. The command sees only a placeholder in `envVar`; the proxy
 * puts `value` into requests to `hosts` (domain patterns, no port, no IP literal) and nowhere
 * else. For a `readOnly` secret, requests other than GET, HEAD and OPTIONS to those hosts need the
 * user's approval (an `ask` event with `kind: "request"`). `value` is never logged, audited,
 * echoed in an error, or returned.
 */
export type WrapSecret = {
  envVar: string;
  value: string;
  hosts: string[];
  readOnly: boolean;
};
