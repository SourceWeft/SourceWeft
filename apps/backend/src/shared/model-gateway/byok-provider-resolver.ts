import { and, eq } from "drizzle-orm";
import { config } from "../config";
import {
  db,
  modelGatewayByokCredentials,
  type ModelGatewayProviderKind,
} from "@sourceweft/db";
import { decryptSecret } from "../secrets";
import { normalizeDefaultHeaders } from "./runtime";

export type ResolvedCustomByokProvider = {
  providerName: string;
  providerKind: ModelGatewayProviderKind;
  baseUrl: string;
  apiKey: string;
  defaultHeaders: Record<string, string>;
  credentialAlias: string;
  hasUserScopedKey: boolean;
};

function resolveScopeFromMetadata(metadata?: Record<string, unknown>) {
  return {
    workspaceId:
      typeof metadata?.workspace_id === "string" ? metadata.workspace_id : null,
    teamId: typeof metadata?.team_id === "string" ? metadata.team_id : null,
    userId: typeof metadata?.user_id === "string" ? metadata.user_id : null,
  };
}

export async function listCustomByokProviders(input: {
  workspaceId: string;
  teamId: string;
  userId?: string | null;
}) {
  const rows = await db
    .select()
    .from(modelGatewayByokCredentials)
    .where(
      and(
        eq(modelGatewayByokCredentials.workspaceId, input.workspaceId),
        eq(modelGatewayByokCredentials.teamId, input.teamId),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    );

  const visibleRows = rows.filter((row) =>
    row.userId ? row.userId === (input.userId ?? null) : true,
  );

  const providerMap = new Map<
    string,
    {
      providerName: string;
      providerKind: ResolvedCustomByokProvider["providerKind"];
      baseUrl: string | null;
      credentialAliases: string[];
      hasUserScopedKey: boolean;
      defaultHeaders: Record<string, string>;
    }
  >();

  for (const row of visibleRows) {
    const key = `${row.providerName}:${row.baseUrl ?? ""}`;
    const existing = providerMap.get(key) ?? {
      providerName: row.providerName,
      providerKind: row.providerKind,
      baseUrl: row.baseUrl,
      credentialAliases: [],
      hasUserScopedKey: false,
      defaultHeaders: normalizeDefaultHeaders(row.defaultHeadersJson),
    };

    existing.credentialAliases.push(row.credentialAlias);
    if (row.userId) {
      existing.hasUserScopedKey = true;
    }
    if (!existing.baseUrl && row.baseUrl) {
      existing.baseUrl = row.baseUrl;
    }
    if (Object.keys(existing.defaultHeaders).length === 0) {
      existing.defaultHeaders = normalizeDefaultHeaders(row.defaultHeadersJson);
    }
    providerMap.set(key, existing);
  }

  return Array.from(providerMap.values()).map((provider) => ({
    ...provider,
    credentialAliases: Array.from(new Set(provider.credentialAliases)).sort(),
  }));
}

export async function resolveCustomByokProvider(input: {
  providerName: string;
  apiKeyRef?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ResolvedCustomByokProvider | null> {
  const scope = resolveScopeFromMetadata(input.metadata);
  if (!scope.workspaceId || !scope.teamId) {
    return null;
  }

  const rows = await db
    .select()
    .from(modelGatewayByokCredentials)
    .where(
      and(
        eq(modelGatewayByokCredentials.workspaceId, scope.workspaceId),
        eq(modelGatewayByokCredentials.teamId, scope.teamId),
        eq(modelGatewayByokCredentials.providerName, input.providerName),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    );

  const visibleRows = rows.filter((candidate) => {
    if (input.apiKeyRef && candidate.credentialAlias !== input.apiKeyRef) {
      return false;
    }
    if (!candidate.userId) {
      return true;
    }
    return scope.userId ? candidate.userId === scope.userId : false;
  });

  const row =
    visibleRows.find((candidate) => candidate.baseUrl && candidate.userId === scope.userId) ??
    visibleRows.find((candidate) => candidate.baseUrl) ??
    null;

  if (!row || !row.baseUrl) {
    return null;
  }

  const apiKey =
    decryptSecret(row.apiKeyEncrypted, config.modelGatewayEncryptionSecret) || "";
  if (!apiKey) {
    return null;
  }

  return {
    providerName: row.providerName,
    providerKind: row.providerKind,
    baseUrl: row.baseUrl,
    apiKey,
    defaultHeaders: normalizeDefaultHeaders(row.defaultHeadersJson),
    credentialAlias: row.credentialAlias,
    hasUserScopedKey: row.userId !== null,
  };
}

