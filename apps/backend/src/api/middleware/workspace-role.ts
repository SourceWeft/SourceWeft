import type { Context, Next } from "hono";
import { workspaceService } from "../../modules/workspace";
import {
  workspaceRoleSatisfies,
  type WorkspaceRole,
} from "../../modules/workspace/types";
import { ApiError } from "../response/api-response";
import { getSessionUserId, requireSession } from "./auth-session";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Which plane a write is judged on.
 *
 * - `content` — needs a role *inside* the workspace. Authoring surfaces.
 * - `container` — needs administrative standing *over* the workspace, which an
 *   organization admin has whether or not they can read what is in it.
 * - `none` — the handler does its own, finer-grained check.
 */
type Requirement =
  | { plane: "content"; role: WorkspaceRole }
  | { plane: "container" }
  | { plane: "none" };

const DEFAULT_REQUIREMENT: Requirement = { plane: "content", role: "editor" };

type WriteRule = {
  /** Matched against the path *below* `/v1/workspaces/:workspaceId`. */
  pattern: RegExp;
  requirement: Requirement;
};

/**
 * First match wins, so exemptions precede the prefixes that would capture them.
 *
 * The `container` set is everything that stores or spends credentials for the
 * whole workspace — provider keys, OAuth grants, MCP installs — or that changes
 * what the agent may do without asking. None of it reads member content, which
 * is why an organization admin can do it without being in the workspace.
 */
const WRITE_RULES: WriteRule[] = [
  // The workspace row itself; only the rename endpoint lives here.
  { pattern: /^\/$/, requirement: { plane: "container" } },
  // Membership changes split across both planes — see WorkspaceService.
  { pattern: /^\/members(\/|$)/, requirement: { plane: "none" } },
  // Break-glass content-admin appointment: a CONTAINER admin (content role may
  // be null) may call it, so it can't sit on the content plane — the service
  // enforces container-admin + orphaned-workspace itself.
  { pattern: /^\/content-admins(\/|$)/, requirement: { plane: "none" } },
  // Guest management does its own content-admin check in GuestService.
  { pattern: /^\/guests(\/|$)/, requirement: { plane: "none" } },
  { pattern: /^\/sources\/status$/, requirement: { plane: "none" } },
  {
    pattern: /^\/model-gateway\/byok-model-capabilities$/,
    requirement: { plane: "none" },
  },
  // Provider keys are pure configuration and hold no member content, so an
  // organization admin can repair them without entering the workspace.
  { pattern: /^\/model-gateway(\/|$)/, requirement: { plane: "container" } },
  // The rest carry or surface content — MCP runs, connector syncs, what the
  // agent may do in a thread — so they stay on the content plane, matching the
  // per-permission checks the mcp/connectors modules already apply.
  {
    pattern: /^\/mcp-installs(\/|$)/,
    requirement: { plane: "content", role: "workspace_admin" },
  },
  {
    pattern: /^\/market\/mcp(\/|$)/,
    requirement: { plane: "content", role: "workspace_admin" },
  },
  {
    pattern: /^\/connectors(\/|$)/,
    requirement: { plane: "content", role: "workspace_admin" },
  },
  {
    pattern: /^\/agent-tool-trust-rules(\/|$)/,
    requirement: { plane: "content", role: "workspace_admin" },
  },
];

function requirementForWrite(subPath: string): Requirement {
  for (const rule of WRITE_RULES) {
    if (rule.pattern.test(subPath)) {
      return rule.requirement;
    }
  }

  return DEFAULT_REQUIREMENT;
}

/**
 * Path below the workspace mount point. The guard is mounted at
 * `/v1/workspaces/:workspaceId`, and `c.req.path` is the full request path, so
 * the captured id is what tells us where the prefix ends.
 */
function workspaceSubPath(c: Context, workspaceId: string) {
  const prefix = `/v1/workspaces/${workspaceId}`;
  const path = c.req.path;
  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}

/**
 * Enforces workspace roles on every mutating request under
 * `/v1/workspaces/:workspaceId`.
 *
 * Reads pass straight through: the services resolve the workspace through
 * `requireContentWorkspace`, which already rejects anyone without content
 * access. This guard answers the question that had no answer — whether a
 * member who *can* read is allowed to write this particular thing.
 *
 * Unauthenticated and unrelated requests also pass through, so handlers keep
 * producing the 401 / `WORKSPACE_NOT_FOUND` they produce today rather than the
 * guard inventing a second, differently-shaped answer.
 */
export async function workspaceRoleGuard(c: Context, next: Next) {
  if (READ_METHODS.has(c.req.method)) {
    return next();
  }

  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return next();
  }

  const requirement = requirementForWrite(workspaceSubPath(c, workspaceId));
  if (requirement.plane === "none") {
    return next();
  }

  const session = await requireSession(c);
  if (!session) {
    return next();
  }

  const access = await workspaceService.resolveAccess({
    workspaceId,
    userId: getSessionUserId(session),
  });

  if (!access) {
    return next();
  }

  if (requirement.plane === "container") {
    if (workspaceService.canAdministerContainer(access)) {
      return next();
    }

    throw new ApiError(
      403,
      "WORKSPACE_ROLE_REQUIRED",
      "Only workspace admins can change this.",
      { requiredRole: "workspace_admin", role: access.role },
    );
  }

  if (access.role === null) {
    // Container-only standing: an organization admin reaching into a workspace
    // they are not a member of. They may administer it, not author in it.
    return next();
  }

  if (!workspaceRoleSatisfies(access.role, requirement.role)) {
    throw new ApiError(
      403,
      "WORKSPACE_ROLE_REQUIRED",
      "Your role in this workspace is read-only.",
      { requiredRole: requirement.role, role: access.role },
    );
  }

  return next();
}
