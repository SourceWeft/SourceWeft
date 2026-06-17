import type { Hono } from "hono";
import { listCapabilityCatalog } from "../../../modules/threads/turn/capability-command-workflows";
import { requireContentWorkspace } from "../../../modules/workspace";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

async function requireCapabilityCatalogContext(c: import("hono").Context) {
  const session = await requireSession(c);
  if (!session) {
    throw ApiError.unauthorized();
  }
  const workspace = await requireContentWorkspace({
    workspaceId: requireRouteParam(c, "workspaceId"),
    userId: getSessionUserId(session),
  });
  return { teamId: workspace.organizationId, workspaceId: workspace.id };
}

export function registerCapabilityRoutes(app: Hono) {
  app.get("/capabilities/catalog", async (c) => {
    await requireCapabilityCatalogContext(c);
    const catalog = await listCapabilityCatalog();
    return ApiResponse.success(c, {
      commands: catalog.commands.map((command) => ({
        id: command.id,
        capabilityId: command.capabilityId,
        contributionId: command.contributionId,
        title: command.title,
        displayTitle: command.displayTitle,
        parentKind: command.parentKind,
        parentTitle: command.parentTitle,
        aliases: [...command.aliases],
        category: command.category,
        ...(command.iconName ? { iconName: command.iconName } : {}),
        ...(command.iconTone ? { iconTone: command.iconTone } : {}),
        visible: command.visible,
        order: command.order,
        action: command.action,
        hasWorkflow: Boolean(command.workflow),
        sourcePackageName: command.sourcePackageName,
      })),
      tools: catalog.tools.map((tool) => ({
        id: tool.id,
        capabilityId: tool.capabilityId,
        contributionId: tool.contributionId,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        options: tool.options,
        risk: tool.risk,
        sourcePackageName: tool.sourcePackageName,
        toolName: tool.toolName,
      })),
    });
  });
}
