import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  db,
  mcpActionRuns,
  mcpToolRuns,
  workspaceMcpCredentials,
  workspaceMcpInstalls,
  workspaceMcpTools,
} from "@sourceweft/db";
import type {
  McpActionRunRecord,
  McpActionRunStatus,
  McpActionRunWithInstallRecord,
  McpRunInstallSummary,
  McpToolRunRecord,
  McpToolRunStatus,
  McpToolRunWithInstallRecord,
  WorkspaceMcpCredentialRecord,
  WorkspaceMcpInstallRecord,
  WorkspaceMcpToolRecord,
} from "./types";
import type { MarketMcpManifest, MarketMcpToolManifest } from "@sourceweft/market-sdk";
import { hashJson, normalizedMcpToolName } from "./security";

type InstallRow = typeof workspaceMcpInstalls.$inferSelect;
type ToolRow = typeof workspaceMcpTools.$inferSelect;
type CredentialRow = typeof workspaceMcpCredentials.$inferSelect;
type ActionRunRow = typeof mcpActionRuns.$inferSelect;
type ToolRunRow = typeof mcpToolRuns.$inferSelect;

const DEFAULT_RUN_LIST_LIMIT = 50;
const MAX_RUN_LIST_LIMIT = 100;

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function mapTool(row: ToolRow): WorkspaceMcpToolRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    installId: row.installId,
    serverToolName: row.serverToolName,
    normalizedToolName: row.normalizedToolName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema ?? {},
    outputSchema: row.outputSchema ?? null,
    annotations: row.annotations ?? {},
    risk: row.risk,
    enabled: row.enabled,
    lastDiscoveredHash: row.lastDiscoveredHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapInstall(
  row: InstallRow,
  tools: WorkspaceMcpToolRecord[] = [],
): WorkspaceMcpInstallRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    source: row.source,
    marketIdentifier: row.marketIdentifier,
    marketVersion: row.marketVersion,
    name: row.name,
    summary: row.summary,
    transport: row.transport,
    endpointUrl: row.endpointUrl,
    status: row.status,
    official: row.official,
    verified: row.verified,
    desktopOnly: row.desktopOnly,
    webExecutable: row.webExecutable,
    authType: row.authType,
    credentialStatus: row.credentialStatus,
    enabled: row.enabled,
    manifestJson: row.manifestJson ?? {},
    signature: row.signature,
    signingKeyId: row.signingKeyId,
    lastTestedAt: iso(row.lastTestedAt),
    lastError: row.lastError,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tools,
  };
}

function mapRunInstallSummary(
  row: Pick<
    InstallRow,
    "id" | "name" | "marketIdentifier" | "official" | "verified"
  >,
): McpRunInstallSummary {
  return {
    id: row.id,
    name: row.name,
    marketIdentifier: row.marketIdentifier,
    official: row.official,
    verified: row.verified,
  };
}

function mapCredential(row: CredentialRow): WorkspaceMcpCredentialRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    installId: row.installId,
    authType: row.authType,
    encryptedSecret: row.encryptedSecret,
    encryptedHeaders: row.encryptedHeaders,
    headerName: row.headerName,
    status: row.status,
    configuredBy: row.configuredBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapActionRun(row: ActionRunRow): McpActionRunRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    installId: row.installId,
    toolId: row.toolId,
    serverToolName: row.serverToolName,
    normalizedToolName: row.normalizedToolName,
    risk: row.risk,
    status: row.status,
    requestJson: row.requestJson ?? {},
    requestPreview: row.requestPreview,
    resultJson: row.resultJson ?? {},
    approvedBy: row.approvedBy,
    executedBy: row.executedBy,
    idempotencyKey: row.idempotencyKey,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapToolRun(row: ToolRunRow): McpToolRunRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    runId: row.runId,
    toolCallId: row.toolCallId,
    installId: row.installId,
    toolId: row.toolId,
    actionRunId: row.actionRunId,
    serverToolName: row.serverToolName,
    normalizedToolName: row.normalizedToolName,
    risk: row.risk,
    status: row.status as McpToolRunStatus,
    redactedInput: row.redactedInput ?? {},
    redactedOutput: row.redactedOutput ?? {},
    latencyMs: row.latencyMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeRunListLimit(limit?: number) {
  if (!limit || !Number.isFinite(limit)) {
    return DEFAULT_RUN_LIST_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_RUN_LIST_LIMIT));
}

async function installSummariesById(input: { installIds: string[] }) {
  const uniqueInstallIds = Array.from(
    new Set(input.installIds.filter((id): id is string => Boolean(id))),
  );
  if (uniqueInstallIds.length === 0) {
    return new Map<string, McpRunInstallSummary>();
  }
  const rows = await db
    .select({
      id: workspaceMcpInstalls.id,
      name: workspaceMcpInstalls.name,
      marketIdentifier: workspaceMcpInstalls.marketIdentifier,
      official: workspaceMcpInstalls.official,
      verified: workspaceMcpInstalls.verified,
    })
    .from(workspaceMcpInstalls)
    .where(inArray(workspaceMcpInstalls.id, uniqueInstallIds));
  return new Map(rows.map((row) => [row.id, mapRunInstallSummary(row)]));
}

export async function listWorkspaceMcpInstalls(input: {
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .select()
    .from(workspaceMcpInstalls)
    .where(
      and(
        eq(workspaceMcpInstalls.teamId, input.teamId),
        eq(workspaceMcpInstalls.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(workspaceMcpInstalls.createdAt));

  const installIds = rows.map((row) => row.id);
  const tools = installIds.length
    ? await db
        .select()
        .from(workspaceMcpTools)
        .where(inArray(workspaceMcpTools.installId, installIds))
    : [];
  const toolsByInstall = new Map<string, WorkspaceMcpToolRecord[]>();
  for (const tool of tools.map(mapTool)) {
    const existing = toolsByInstall.get(tool.installId) ?? [];
    existing.push(tool);
    toolsByInstall.set(tool.installId, existing);
  }

  return rows.map((row) => mapInstall(row, toolsByInstall.get(row.id) ?? []));
}

export async function findWorkspaceMcpInstall(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
}) {
  const [row] = await db
    .select()
    .from(workspaceMcpInstalls)
    .where(
      and(
        eq(workspaceMcpInstalls.id, input.installId),
        eq(workspaceMcpInstalls.teamId, input.teamId),
        eq(workspaceMcpInstalls.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const tools = await listWorkspaceMcpTools({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    installId: input.installId,
  });
  return mapInstall(row, tools);
}

export async function findWorkspaceMcpInstallByMarketIdentifier(input: {
  teamId: string;
  workspaceId: string;
  marketIdentifier: string;
}) {
  const [row] = await db
    .select()
    .from(workspaceMcpInstalls)
    .where(
      and(
        eq(workspaceMcpInstalls.teamId, input.teamId),
        eq(workspaceMcpInstalls.workspaceId, input.workspaceId),
        eq(workspaceMcpInstalls.marketIdentifier, input.marketIdentifier),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const tools = await listWorkspaceMcpTools({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    installId: row.id,
  });
  return mapInstall(row, tools);
}

export async function listWorkspaceMcpTools(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
}) {
  const rows = await db
    .select()
    .from(workspaceMcpTools)
    .where(
      and(
        eq(workspaceMcpTools.teamId, input.teamId),
        eq(workspaceMcpTools.workspaceId, input.workspaceId),
        eq(workspaceMcpTools.installId, input.installId),
      ),
    );
  return rows.map(mapTool);
}

export async function createOrUpdateMarketMcpInstall(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  manifest: MarketMcpManifest;
  signature?: string | null;
  signingKeyId?: string | null;
}) {
  const id = randomUUID();
  const credentialStatus =
    input.manifest.auth.required && input.manifest.auth.type !== "none"
      ? "required"
      : "not_required";
  const endpointUrl = input.manifest.endpointUrl ?? null;

  const existing = await findWorkspaceMcpInstallByMarketIdentifier({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    marketIdentifier: input.manifest.identifier,
  });
  const row = existing
    ? (
        await db
          .update(workspaceMcpInstalls)
          .set({
            marketVersion: input.manifest.version,
            name: input.manifest.name,
            summary: input.manifest.summary,
            transport: input.manifest.transport,
            endpointUrl,
            official: input.manifest.official,
            verified: input.manifest.verified,
            desktopOnly: input.manifest.desktopOnly,
            webExecutable: input.manifest.webExecutable,
            authType: input.manifest.auth.type,
            manifestJson: input.manifest,
            signature: input.signature ?? null,
            signingKeyId: input.signingKeyId ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workspaceMcpInstalls.id, existing.id),
              eq(workspaceMcpInstalls.teamId, input.teamId),
              eq(workspaceMcpInstalls.workspaceId, input.workspaceId),
            ),
          )
          .returning()
      )[0]
    : (
        await db
          .insert(workspaceMcpInstalls)
          .values({
            id,
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            source: "market",
            marketIdentifier: input.manifest.identifier,
            marketVersion: input.manifest.version,
            name: input.manifest.name,
            summary: input.manifest.summary,
            transport: input.manifest.transport,
            endpointUrl,
            status: "active",
            official: input.manifest.official,
            verified: input.manifest.verified,
            desktopOnly: input.manifest.desktopOnly,
            webExecutable: input.manifest.webExecutable,
            authType: input.manifest.auth.type,
            credentialStatus,
            enabled: true,
            manifestJson: input.manifest,
            signature: input.signature ?? null,
            signingKeyId: input.signingKeyId ?? null,
            createdBy: input.userId,
          })
          .returning()
      )[0];

  if (!row) {
    throw new Error("Failed to create MCP install");
  }

  if (existing && existing.credentialStatus !== "configured") {
    await updateWorkspaceMcpInstall({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      installId: row.id,
      credentialStatus,
    });
  }

  await upsertWorkspaceMcpTools({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    installId: row.id,
    serverSlug: input.manifest.identifier,
    tools: input.manifest.tools,
  });

  return findWorkspaceMcpInstall({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    installId: row.id,
  });
}

export async function upsertWorkspaceMcpTools(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
  serverSlug: string;
  tools: MarketMcpToolManifest[];
}) {
  for (const tool of input.tools) {
    const normalizedToolName = normalizedMcpToolName({
      serverSlug: input.serverSlug,
      toolName: tool.name,
    });
    const lastDiscoveredHash = hashJson(tool);
    await db
      .insert(workspaceMcpTools)
      .values({
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        installId: input.installId,
        serverToolName: tool.name,
        normalizedToolName,
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? {},
        risk: tool.risk ?? "unknown",
        enabled: true,
        lastDiscoveredHash,
      })
      .onConflictDoUpdate({
        target: [workspaceMcpTools.installId, workspaceMcpTools.serverToolName],
        set: {
          normalizedToolName,
          title: tool.title ?? null,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? {},
          outputSchema: tool.outputSchema ?? null,
          annotations: tool.annotations ?? {},
          risk: tool.risk ?? "unknown",
          lastDiscoveredHash,
          updatedAt: new Date(),
        },
      });
  }
}

export async function updateWorkspaceMcpInstall(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
  enabled?: boolean;
  status?: "active" | "disabled" | "error";
  credentialStatus?: "not_required" | "required" | "configured" | "invalid";
  lastTestedAt?: Date | null;
  lastError?: string | null;
}) {
  const [row] = await db
    .update(workspaceMcpInstalls)
    .set({
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.credentialStatus
        ? { credentialStatus: input.credentialStatus }
        : {}),
      ...(input.lastTestedAt !== undefined
        ? { lastTestedAt: input.lastTestedAt }
        : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceMcpInstalls.id, input.installId),
        eq(workspaceMcpInstalls.teamId, input.teamId),
        eq(workspaceMcpInstalls.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return row
    ? findWorkspaceMcpInstall({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        installId: row.id,
      })
    : null;
}

export async function deleteWorkspaceMcpInstall(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
}) {
  const rows = await db
    .delete(workspaceMcpInstalls)
    .where(
      and(
        eq(workspaceMcpInstalls.id, input.installId),
        eq(workspaceMcpInstalls.teamId, input.teamId),
        eq(workspaceMcpInstalls.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: workspaceMcpInstalls.id });
  return rows.length > 0;
}

export async function setWorkspaceMcpToolsEnabled(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
  toolIds: string[];
}) {
  await db
    .update(workspaceMcpTools)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceMcpTools.teamId, input.teamId),
        eq(workspaceMcpTools.workspaceId, input.workspaceId),
        eq(workspaceMcpTools.installId, input.installId),
      ),
    );
  if (input.toolIds.length > 0) {
    await db
      .update(workspaceMcpTools)
      .set({ enabled: true, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMcpTools.teamId, input.teamId),
          eq(workspaceMcpTools.workspaceId, input.workspaceId),
          eq(workspaceMcpTools.installId, input.installId),
          inArray(workspaceMcpTools.id, input.toolIds),
        ),
      );
  }
}

export async function upsertWorkspaceMcpCredential(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
  authType: "none" | "bearer" | "api_key_header" | "custom_headers";
  encryptedSecret?: string | null;
  encryptedHeaders?: string | null;
  headerName?: string | null;
  configuredBy: string;
}) {
  const [row] = await db
    .insert(workspaceMcpCredentials)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      installId: input.installId,
      authType: input.authType,
      encryptedSecret: input.encryptedSecret ?? null,
      encryptedHeaders: input.encryptedHeaders ?? null,
      headerName: input.headerName ?? null,
      status: "configured",
      configuredBy: input.configuredBy,
    })
    .onConflictDoUpdate({
      target: [workspaceMcpCredentials.installId],
      set: {
        authType: input.authType,
        encryptedSecret: input.encryptedSecret ?? null,
        encryptedHeaders: input.encryptedHeaders ?? null,
        headerName: input.headerName ?? null,
        status: "configured",
        configuredBy: input.configuredBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to save MCP credentials");
  }
  return mapCredential(row);
}

export async function findWorkspaceMcpCredential(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
}) {
  const [row] = await db
    .select()
    .from(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.teamId, input.teamId),
        eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
        eq(workspaceMcpCredentials.installId, input.installId),
      ),
    )
    .limit(1);
  return row ? mapCredential(row) : null;
}

export async function createMcpActionRun(input: {
  teamId: string;
  workspaceId: string;
  installId: string;
  toolId?: string | null;
  serverToolName: string;
  normalizedToolName: string;
  risk: "read" | "write" | "destructive" | "unknown";
  status: McpActionRunStatus;
  requestJson: Record<string, unknown>;
  requestPreview: string;
  idempotencyKey: string;
}) {
  const [existing] = await db
    .select()
    .from(mcpActionRuns)
    .where(
      and(
        eq(mcpActionRuns.workspaceId, input.workspaceId),
        eq(mcpActionRuns.installId, input.installId),
        eq(mcpActionRuns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    return mapActionRun(existing);
  }

  const [row] = await db
    .insert(mcpActionRuns)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      installId: input.installId,
      toolId: input.toolId ?? null,
      serverToolName: input.serverToolName,
      normalizedToolName: input.normalizedToolName,
      risk: input.risk,
      status: input.status,
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (!row) {
    throw new Error("Failed to create MCP action run");
  }
  return mapActionRun(row);
}

export async function findMcpActionRun(input: {
  teamId: string;
  workspaceId: string;
  actionRunId: string;
}) {
  const [row] = await db
    .select()
    .from(mcpActionRuns)
    .where(
      and(
        eq(mcpActionRuns.id, input.actionRunId),
        eq(mcpActionRuns.teamId, input.teamId),
        eq(mcpActionRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row ? mapActionRun(row) : null;
}

export async function updateMcpActionRun(input: {
  teamId: string;
  workspaceId: string;
  actionRunId: string;
  status?: McpActionRunStatus;
  requestJson?: Record<string, unknown>;
  requestPreview?: string;
  resultJson?: Record<string, unknown>;
  approvedBy?: string | null;
  executedBy?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const updates: Partial<typeof mcpActionRuns.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) updates.status = input.status;
  if (input.requestJson !== undefined) updates.requestJson = input.requestJson;
  if (input.requestPreview !== undefined) updates.requestPreview = input.requestPreview;
  if (input.resultJson !== undefined) updates.resultJson = input.resultJson;
  if (input.approvedBy !== undefined) updates.approvedBy = input.approvedBy;
  if (input.executedBy !== undefined) updates.executedBy = input.executedBy;
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined) updates.errorMessage = input.errorMessage;

  const [row] = await db
    .update(mcpActionRuns)
    .set(updates)
    .where(
      and(
        eq(mcpActionRuns.id, input.actionRunId),
        eq(mcpActionRuns.teamId, input.teamId),
        eq(mcpActionRuns.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return row ? mapActionRun(row) : null;
}

export async function createMcpToolRun(input: {
  teamId: string;
  workspaceId: string;
  threadId?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
  installId?: string | null;
  toolId?: string | null;
  actionRunId?: string | null;
  serverToolName: string;
  normalizedToolName: string;
  risk: "read" | "write" | "destructive" | "unknown";
  status: McpToolRunStatus;
  redactedInput: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const [row] = await db
    .insert(mcpToolRuns)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      toolCallId: input.toolCallId ?? null,
      installId: input.installId ?? null,
      toolId: input.toolId ?? null,
      actionRunId: input.actionRunId ?? null,
      serverToolName: input.serverToolName,
      normalizedToolName: input.normalizedToolName,
      risk: input.risk,
      status: input.status,
      redactedInput: input.redactedInput,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("Failed to create MCP tool run");
  }
  return mapToolRun(row);
}

export async function updateMcpToolRun(input: {
  teamId: string;
  workspaceId: string;
  toolRunId: string;
  status: McpToolRunStatus;
  redactedOutput?: Record<string, unknown>;
  latencyMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const [row] = await db
    .update(mcpToolRuns)
    .set({
      status: input.status,
      ...(input.redactedOutput !== undefined
        ? { redactedOutput: input.redactedOutput }
        : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined
        ? { errorMessage: input.errorMessage }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpToolRuns.id, input.toolRunId),
        eq(mcpToolRuns.teamId, input.teamId),
        eq(mcpToolRuns.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return row ? mapToolRun(row) : null;
}

export async function listMcpToolRuns(input: {
  teamId: string;
  workspaceId: string;
  limit?: number;
  cursor?: string | null;
}) {
  const limit = normalizeRunListLimit(input.limit);
  const cursorDate = input.cursor ? new Date(input.cursor) : null;
  const rows = await db
    .select()
    .from(mcpToolRuns)
    .where(
      and(
        eq(mcpToolRuns.teamId, input.teamId),
        eq(mcpToolRuns.workspaceId, input.workspaceId),
        cursorDate && !Number.isNaN(cursorDate.getTime())
          ? lt(mcpToolRuns.createdAt, cursorDate)
          : undefined,
      ),
    )
    .orderBy(desc(mcpToolRuns.createdAt))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const installsById = await installSummariesById({
    installIds: pageRows
      .map((row) => row.installId)
      .filter((id): id is string => Boolean(id)),
  });
  const items: McpToolRunWithInstallRecord[] = pageRows.map((row) => ({
    ...mapToolRun(row),
    install: row.installId ? (installsById.get(row.installId) ?? null) : null,
  }));
  return {
    items,
    nextCursor:
      rows.length > limit
        ? (pageRows.at(-1)?.createdAt.toISOString() ?? null)
        : null,
  };
}

export async function listMcpActionRuns(input: {
  teamId: string;
  workspaceId: string;
  limit?: number;
  cursor?: string | null;
}) {
  const limit = normalizeRunListLimit(input.limit);
  const cursorDate = input.cursor ? new Date(input.cursor) : null;
  const rows = await db
    .select()
    .from(mcpActionRuns)
    .where(
      and(
        eq(mcpActionRuns.teamId, input.teamId),
        eq(mcpActionRuns.workspaceId, input.workspaceId),
        cursorDate && !Number.isNaN(cursorDate.getTime())
          ? lt(mcpActionRuns.createdAt, cursorDate)
          : undefined,
      ),
    )
    .orderBy(desc(mcpActionRuns.createdAt))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const installsById = await installSummariesById({
    installIds: pageRows.map((row) => row.installId),
  });
  const items: McpActionRunWithInstallRecord[] = pageRows.map((row) => ({
    ...mapActionRun(row),
    install: installsById.get(row.installId) ?? null,
  }));
  return {
    items,
    nextCursor:
      rows.length > limit
        ? (pageRows.at(-1)?.createdAt.toISOString() ?? null)
        : null,
  };
}
