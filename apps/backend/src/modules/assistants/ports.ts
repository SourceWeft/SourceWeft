import type { NotifyInput } from "../notifications";
import type { StartHostTurnInput } from "../threads";
import type { TeamAuditEntry } from "../team-audit/types";
import { workspaceRoleSatisfies } from "../workspace/types";

/**
 * Everything the assistants module needs from the rest of the backend: who
 * may act in a workspace and how, whether they still have credits, starting
 * and stopping a host-owned turn, notifying a person, and the team audit
 * log. One interface, used both by requests a person makes and by the
 * Router/worker's own background checks (Tasks 6-7), so tests replace it
 * once for both. Lazy imports keep the HTTP layer, the worker and unit tests
 * from pulling in the whole chat stack just to import this module.
 */
export interface AssistantPorts {
  /** The caller's standing in the workspace, or null when they have none. */
  workspaceAccess(input: {
    workspaceId: string;
    userId: string;
  }): Promise<{
    teamId: string;
    canWrite: boolean;
    isContainerAdmin: boolean;
  } | null>;
  /** False only when billing is enforced and the person has no credits left. */
  hasCredits(input: { teamId: string; userId: string }): Promise<boolean>;
  startTurn(input: StartHostTurnInput): Promise<{
    thread: { id: string };
    run: { id: string };
    created: boolean;
  }>;
  stopRun(input: {
    workspaceId: string;
    threadId: string;
    runId: string;
    userId: string;
  }): Promise<void>;
  notify(input: NotifyInput): Promise<unknown>;
  audit(entry: TeamAuditEntry): Promise<void>;
}

/** The production wiring. Loaded lazily, as agent-tasks/ports.ts does. */
export const assistantPorts: AssistantPorts = {
  async workspaceAccess(input) {
    const { workspaceService } = await import("../workspace");
    // `resolveWorkspace` is the same "can this person even see it" gate the
    // rest of the backend uses (agent-tasks' `requireContentWorkspace`,
    // threads' `startHostTurn`): null means a non-member, who should get a
    // 404, not a 403. `resolveAccess` then supplies the role detail.
    const workspace = await workspaceService.resolveWorkspace(input);
    if (!workspace) return null;
    const access = await workspaceService.resolveAccess(input);
    if (!access) return null;
    return {
      teamId: workspace.organizationId,
      canWrite:
        access.role !== null && workspaceRoleSatisfies(access.role, "editor"),
      isContainerAdmin: access.isContainerAdmin,
    };
  },

  async hasCredits(input) {
    const { billingRuntime } = await import("../../billing-host/bindings");
    const { billingAdmission } = await import(
      "../../shared/model-gateway/billing/admission"
    );
    const decision = await billingAdmission.admit({
      billing: billingRuntime,
      teamId: input.teamId,
      userId: input.userId,
    });
    return decision.allowed;
  },

  async startTurn(input) {
    const { startHostTurn } = await import("../threads");
    return startHostTurn(input);
  },

  async stopRun(input) {
    const { durableChatRunService, findChatThreadRunById } = await import(
      "../threads"
    );
    const run = await findChatThreadRunById({
      runId: input.runId,
      workspaceId: input.workspaceId,
    });
    // Already gone, or never existed: nothing to stop.
    if (!run) return;
    await durableChatRunService.stopRun({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      idempotencyKey: run.idempotencyKey,
    });
  },

  async notify(input) {
    const { notify } = await import("../notifications");
    return notify(input);
  },

  async audit(entry) {
    const { teamAuditService } = await import("../team-audit");
    await teamAuditService.record(entry);
  },
};
