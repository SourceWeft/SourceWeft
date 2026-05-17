import type { Workspace } from "@sourceweft/contracts";
import {
  getStoredDashboardWorkspaceId,
  setStoredDashboardWorkspaceId,
} from "./dashboard-workspace-context";
import { workspaceClient } from "./sdk";

type EnsureDashboardWorkspaceResult = {
  active: Workspace | null;
  items: Workspace[];
};

const inflightByOrganization = new Map<
  string,
  Promise<EnsureDashboardWorkspaceResult>
>();

async function persistWorkspaceContext(workspaceId: string) {
  try {
    await workspaceClient.setWorkspaceContext(workspaceId);
  } catch {
    // Context persistence is best-effort; callers can still use the workspace.
  }
}

export async function ensureDashboardWorkspace(
  organizationId: string,
): Promise<EnsureDashboardWorkspaceResult> {
  const pending = inflightByOrganization.get(organizationId);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const listed = await workspaceClient.listWorkspaces(organizationId);
    let items = listed.items;
    const storedWorkspaceId = getStoredDashboardWorkspaceId(organizationId);
    let active =
      items.find((item) => item.id === storedWorkspaceId) ?? items[0] ?? null;

    if (!active) {
      const workspace = await workspaceClient.createWorkspace(organizationId, {
        name: "Workspace 1",
      });
      items = [workspace];
      active = workspace;
    }

    setStoredDashboardWorkspaceId(organizationId, active.id);
    await persistWorkspaceContext(active.id);

    return { active, items };
  })();

  inflightByOrganization.set(organizationId, promise);

  try {
    return await promise;
  } finally {
    inflightByOrganization.delete(organizationId);
  }
}
