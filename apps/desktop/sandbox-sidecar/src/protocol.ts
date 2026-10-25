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
 */
export const SANDBOX_PROTOCOL_VERSION = 1;

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
    }
  | { op: "violations"; commandId: string; stderr: string }
  | { op: "cleanup"; commandId: string }
  | { op: "probe" }
  | { op: "shutdown" }
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
