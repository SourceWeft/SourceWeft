import type {
  DashboardChatBootstrapResponse,
  Workspace,
} from "@sourceweft/contracts";
import { HttpClientError } from "@sourceweft/sdk";
import {
  getStoredDashboardWorkspaceId,
  setStoredDashboardWorkspaceId,
} from "./dashboard-workspace-context";
import { dashboardClient, workspaceClient } from "./sdk";

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

// The remembered workspace was deleted, or the caller may no longer open it
// from the session's organization.
function isWorkspaceUnavailable(error: unknown) {
  return (
    error instanceof HttpClientError &&
    (error.status === 403 || error.code === "WORKSPACE_NOT_FOUND")
  );
}

function requestChatBootstrap(workspaceId?: string | null) {
  return dashboardClient.getChatBootstrap({
    includeModelCatalog: false,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

/**
 * Loads the dashboard bootstrap for the workspace this browser last selected.
 *
 * The selection is stored per organization, and the session's organization is
 * only certain once the server has answered. `organizationIdHint` lets the
 * common case finish in one request; when it is missing or turns out to name
 * another organization, the remembered workspace is requested afterwards.
 * A remembered workspace that is gone falls back to the server's default.
 *
 * Nothing is written to storage here: the caller stores the result once it
 * knows the load was not superseded.
 */
export async function loadDashboardChatBootstrap(input: {
  organizationIdHint?: string | null;
  isSuperseded?: () => boolean;
}): Promise<DashboardChatBootstrapResponse> {
  const hintedWorkspaceId = getStoredDashboardWorkspaceId(
    input.organizationIdHint,
  );

  let result: DashboardChatBootstrapResponse;
  try {
    result = await requestChatBootstrap(hintedWorkspaceId);
  } catch (error) {
    if (!hintedWorkspaceId || !isWorkspaceUnavailable(error)) {
      throw error;
    }
    result = await requestChatBootstrap();
  }

  const rememberedWorkspaceId = getStoredDashboardWorkspaceId(
    result.activeOrganizationId,
  );
  if (
    !rememberedWorkspaceId ||
    rememberedWorkspaceId === result.activeWorkspace.id ||
    rememberedWorkspaceId === hintedWorkspaceId ||
    input.isSuperseded?.()
  ) {
    return result;
  }

  try {
    return await requestChatBootstrap(rememberedWorkspaceId);
  } catch (error) {
    if (!isWorkspaceUnavailable(error)) {
      throw error;
    }
    return result;
  }
}
