import type { NotifyInput } from "../notifications";
import type { StartScheduledTurnInput } from "../threads";
import type { TeamAuditEntry } from "../team-audit/types";
import type { RateLimitRule, RateLimitVerdict } from "../../shared/rate-limit";
import type { AgentTaskRow } from "./repository";

/**
 * Everything a scheduled task needs from the rest of the backend. The module
 * decides when and whether a task runs; these decide who may, who pays, and
 * actually start the turn. Tests replace them to drive each outcome.
 */
export interface AgentTaskPorts {
  /** Whether the person can still work in the workspace the task lives in. */
  hasWorkspaceAccess(input: {
    workspaceId: string;
    userId: string;
  }): Promise<boolean>;
  /** The organization the person's usage in that workspace is billed to. */
  resolveBillingTeamId(input: {
    workspaceId: string;
    teamId: string;
    userId: string;
  }): Promise<string>;
  /** False only when billing is enforced and the person has no credits left. */
  hasCredits(input: { teamId: string; userId: string }): Promise<boolean>;
  /** The person's plan limit of active tasks. */
  maxActiveTasks(input: { teamId: string; userId: string }): Promise<number>;
  /** Whether the sources and MCP installs the task names still exist. */
  toolsAvailable(task: AgentTaskRow): Promise<boolean>;
  startTurn(
    input: StartScheduledTurnInput,
  ): Promise<{ thread: { id: string }; run: { id: string } }>;
  stopRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  notify(input: NotifyInput): Promise<unknown>;
  audit(entry: TeamAuditEntry): Promise<void>;
  consumeRateLimit(rules: readonly RateLimitRule[]): Promise<RateLimitVerdict>;
}

/** The production wiring. Loaded lazily: the scheduler, the api and unit
 * tests import this module without pulling the chat stack in at load time. */
export const agentTaskPorts: AgentTaskPorts = {
  async hasWorkspaceAccess(input) {
    const { workspaceService } = await import("../workspace");
    return Boolean(await workspaceService.resolveWorkspace(input));
  },

  async resolveBillingTeamId(input) {
    const { workspaceService } = await import("../workspace");
    return workspaceService.resolveBillingOrganizationId({
      workspaceId: input.workspaceId,
      userId: input.userId,
      workspaceOrganizationId: input.teamId,
    });
  },

  async hasCredits(input) {
    const { billingRuntime } = await import("../../billing-host/bindings");
    const { billingAdmission } =
      await import("../../shared/model-gateway/billing/admission");
    const decision = await billingAdmission.admit({
      billing: billingRuntime,
      teamId: input.teamId,
      userId: input.userId,
    });
    return decision.allowed;
  },

  async maxActiveTasks(input) {
    const { billingRuntime } = await import("../../billing-host/bindings");
    const limits = await billingRuntime.getScheduledTaskLimits(
      input.teamId,
      input.userId,
    );
    return limits.maxActiveTasks;
  },

  async toolsAvailable(task) {
    const request = task.requestJson;
    if (request.sourceIds.length > 0) {
      const { resolveSourceTreeScope } = await import("../sources/service");
      const scope = await resolveSourceTreeScope({
        teamId: task.teamId,
        workspaceId: task.workspaceId,
        selectedSourceIds: request.sourceIds,
      });
      const existing = new Set(scope.effectiveSourceIds);
      // Sources that are gone are left out of the run; none left is a block.
      if (!request.sourceIds.some((id) => existing.has(id))) return false;
    }
    if (request.mcp.installIds.length > 0) {
      const { mcpService, isMcpError } = await import("../mcp");
      const { items } = await mcpService
        .listInstalls({
          workspaceId: task.workspaceId,
          userId: task.ownerUserId,
        })
        .catch((error: unknown) => {
          // The owner may no longer read the workspace's installs at all.
          if (isMcpError(error)) return { items: [] };
          throw error;
        });
      const usable = new Set(
        items
          .filter((install) => install.enabled && install.status === "active")
          .map((install) => install.id),
      );
      if (!request.mcp.installIds.every((id) => usable.has(id))) return false;
    }
    return true;
  },

  async startTurn(input) {
    const { contentThreadService } = await import("../threads");
    return contentThreadService.startScheduledTurn(input);
  },

  async stopRun(input) {
    const { durableChatRunService } = await import("../threads");
    return durableChatRunService.stopRun(input);
  },

  async notify(input) {
    const { notify } = await import("../notifications");
    return notify(input);
  },

  async audit(entry) {
    const { teamAuditService } = await import("../team-audit");
    await teamAuditService.record(entry);
  },

  async consumeRateLimit(rules) {
    const { rateLimiter } = await import("../../shared/rate-limit");
    return rateLimiter.consume(rules);
  },
};
