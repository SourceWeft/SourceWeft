import { createHash, randomBytes } from "node:crypto";
import type { ConnectorCredentialInput } from "@sourceweft/contracts";
import {
  decryptTeamSecret,
  encryptTeamSecret,
} from "../../shared/team-secrets";
import { logger } from "../../shared/logger";
import { ConnectorError, toConnectorError } from "./errors";
import { requireConnectorWorkspace } from "./permissions";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import {
  claimCredentialFlowRecord,
  countLiveCredentialFlowRecords,
  createOAuthStateRecord,
  deleteCredentialFlowRecord,
  deleteExpiredCredentialFlowRecords,
  findOAuthAccountRecord,
  findOAuthStateRecord,
  findSourceConnectorRecord,
} from "./repository";
import type { ConnectorService } from "./service";
import type { ConnectorAdapter } from "./types";

/**
 * Backend owner of the credential login flow (`auth.flow: "login_flow"`).
 *
 * The browser only ever holds the opaque `flowId`; the poll token and the app
 * password the provider issues never leave the backend. The platform runs the
 * flow (state storage, the per-user cap, throttling, atomic single-completion,
 * connector creation or in-place rotation, and best-effort cleanup); the adapter
 * knows the provider protocol and is reached only through `credentialFlow`
 * (start / poll / discard), so the backend stays capability-blind.
 *
 * Concurrency and the one-time password (decisions (d) and (e)):
 *  - The provider returns the password exactly once. The flow row is claimed
 *    with an atomic `consumedAt IS NULL` UPDATE at the moment the `authorized`
 *    result is used — not before `poll`, because a `pending` poll must leave the
 *    row open. Whoever wins the claim creates the one connector; anyone else
 *    gets `expired`. Failure mode: a crash between the provider issuing the
 *    password and the connector being created loses the password (the row is
 *    claimed but `discard` never runs), leaving an orphan app password on the
 *    user's server for them to remove manually — the same window the spec
 *    accepts.
 *  - Upstream polls are throttled to one per second per flow with an in-process
 *    last-poll map. The timestamp is set before the `await`, so overlapping
 *    in-process polls collapse to a single upstream call as well. It is a
 *    politeness rate-limit on the user's own server, not a security control, so
 *    per-process state is acceptable; on the single-instance deployment it is
 *    also exact. (A strict cross-process limit would move the timestamp into the
 *    encrypted blob, at the cost of a re-encrypting write on every 2s poll.)
 */

const CREDENTIAL_FLOW_TTL_MS = 10 * 60 * 1000;
const CREDENTIAL_FLOW_MAX_LIVE = 5;
const CREDENTIAL_FLOW_POLL_INTERVAL_MS = 1000;
const FLOW_ID_BYTES = 32;

function hashFlowId(flowId: string): string {
  return createHash("sha256").update(flowId).digest("hex");
}

function originOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The decrypted pending state of one in-progress login flow. */
type StoredCredentialFlow = {
  /** Opaque adapter data `poll` needs (e.g. poll endpoint + token). */
  pending: Record<string, unknown>;
  name: string;
  roots?: string[];
  periodicIndexingEnabled?: boolean;
  /** Present when reconnecting an existing connector. */
  connectorId?: string;
};

type ConnectorResponse = Awaited<
  ReturnType<ConnectorService["createConnector"]>
>["connector"];

export type CredentialFlowPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "connected"; connector: ConnectorResponse };

export class ConnectorCredentialFlowService {
  /** Last upstream poll time per flow (hashed id), for the 1/s throttle. */
  private readonly lastPollAt = new Map<string, number>();

  constructor(
    private readonly connectorService: ConnectorService,
    private readonly registry: ConnectorRegistry = connectorRegistry,
  ) {}

  async start(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    serverUrl: string;
    name: string;
    roots?: string[];
    periodicIndexingEnabled?: boolean;
    connectorId?: string;
  }): Promise<{ flowId: string; loginUrl: string }> {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const adapter = this.requireLoginFlowAdapter(input.connectorType);

    // Opportunistic cleanup of this type's expired rows; best-effort.
    await this.cleanupExpired(input.connectorType);

    const live = await countLiveCredentialFlowRecords({
      userId: input.userId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
      now: new Date(),
    });
    if (live >= CREDENTIAL_FLOW_MAX_LIVE) {
      throw new ConnectorError(
        429,
        "CONNECTOR_CREDENTIAL_FLOW_LIMIT",
        "Too many logins are already in progress. Finish or cancel one, then try again.",
      );
    }

    // Reconnect: the target connector must already exist in this workspace as a
    // credential connector of this type. The server/user match is enforced again
    // when the credential is issued.
    if (input.connectorId) {
      await this.requireReconnectConnector({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: input.connectorId,
        connectorType: input.connectorType,
      });
    }

    let started: { loginUrl: string; pending: Record<string, unknown> };
    try {
      started = await adapter.credentialFlow!.start({
        serverUrl: input.serverUrl,
        config: {},
      });
    } catch (error) {
      throw toConnectorError(error);
    }

    const flowId = randomBytes(FLOW_ID_BYTES).toString("base64url");
    const stored: StoredCredentialFlow = {
      pending: started.pending,
      name: input.name,
      roots: input.roots,
      periodicIndexingEnabled: input.periodicIndexingEnabled,
      connectorId: input.connectorId,
    };
    const attemptRef = await encryptTeamSecret(
      JSON.stringify(stored),
      workspace.organizationId,
    );
    await createOAuthStateRecord({
      stateHash: hashFlowId(flowId),
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      connectorType: input.connectorType,
      expiresAt: new Date(Date.now() + CREDENTIAL_FLOW_TTL_MS),
      attemptRef,
    });

    return { flowId, loginUrl: started.loginUrl };
  }

  async poll(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    flowId: string;
  }): Promise<CredentialFlowPollResult> {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const adapter = this.requireLoginFlowAdapter(input.connectorType);

    const stateHash = hashFlowId(input.flowId);
    const row = await findOAuthStateRecord({
      stateHash,
      connectorType: input.connectorType,
      now: new Date(),
    });
    // No oracle: an unknown id, an expired flow and another user's or
    // workspace's flow all return the same `expired` answer.
    if (
      !row ||
      row.userId !== input.userId ||
      row.workspaceId !== workspace.id
    ) {
      this.lastPollAt.delete(stateHash);
      return { status: "expired" };
    }

    // Throttle: one upstream poll per second per flow. Setting the timestamp
    // before the await also collapses overlapping in-process polls.
    const now = Date.now();
    if (
      now - (this.lastPollAt.get(stateHash) ?? 0) <
      CREDENTIAL_FLOW_POLL_INTERVAL_MS
    ) {
      return { status: "pending" };
    }
    this.lastPollAt.set(stateHash, now);

    const stored = await this.decodeStored(row.attemptRef, row.teamId);
    if (!stored) {
      return { status: "expired" };
    }

    let result: Awaited<
      ReturnType<NonNullable<ConnectorAdapter["credentialFlow"]>["poll"]>
    >;
    try {
      result = await adapter.credentialFlow!.poll({ pending: stored.pending });
    } catch (error) {
      throw toConnectorError(error);
    }
    if (result.status === "pending") {
      return { status: "pending" };
    }

    // Authorized. Claim the row atomically before the credential is used, so two
    // concurrent completions create exactly one connector; whoever loses the
    // claim best-effort discards the password it holds and reports `expired`.
    const authorized = result;
    const claimed = await claimCredentialFlowRecord({
      stateHash,
      connectorType: input.connectorType,
      now: new Date(),
    });
    this.lastPollAt.delete(stateHash);
    if (!claimed) {
      await this.discard(adapter, authorized.config, authorized.credential);
      return { status: "expired" };
    }

    const connector = stored.connectorId
      ? await this.reconnect({
          workspace,
          userId: input.userId,
          adapter,
          connectorId: stored.connectorId,
          authorized,
        })
      : await this.createNew({
          workspace,
          userId: input.userId,
          connectorType: input.connectorType,
          adapter,
          stored,
          authorized,
        });

    return { status: "connected", connector };
  }

  async cancel(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    flowId: string;
  }): Promise<{ canceled: true }> {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const stateHash = hashFlowId(input.flowId);
    // Owner-scoped delete; a non-owner's call affects no rows. The answer is the
    // same either way, so whether the flow existed is not revealed.
    await deleteCredentialFlowRecord({
      stateHash,
      connectorType: input.connectorType,
      userId: input.userId,
      workspaceId: workspace.id,
    });
    this.lastPollAt.delete(stateHash);
    return { canceled: true };
  }

  // -------------------------------------------------------------------------

  private async createNew(input: {
    workspace: { id: string; organizationId: string };
    userId: string;
    connectorType: string;
    adapter: ConnectorAdapter;
    stored: StoredCredentialFlow;
    authorized: {
      credential: ConnectorCredentialInput;
      config: Record<string, unknown>;
    };
  }): Promise<ConnectorResponse> {
    const configJson = {
      ...input.authorized.config,
      roots: input.stored.roots ?? ["/"],
    };
    try {
      const { connector } = await this.connectorService.createConnector({
        workspaceId: input.workspace.id,
        userId: input.userId,
        connectorType: input.connectorType,
        name: input.stored.name,
        configJson,
        periodicIndexingEnabled: input.stored.periodicIndexingEnabled,
        credential: input.authorized.credential,
      });
      return connector;
    } catch (error) {
      await this.discard(
        input.adapter,
        input.authorized.config,
        input.authorized.credential,
      );
      throw this.createFailedError(error);
    }
  }

  private async reconnect(input: {
    workspace: { id: string; organizationId: string };
    userId: string;
    adapter: ConnectorAdapter;
    connectorId: string;
    authorized: {
      credential: ConnectorCredentialInput;
      config: Record<string, unknown>;
    };
  }): Promise<ConnectorResponse> {
    const connector = await findSourceConnectorRecord({
      teamId: input.workspace.organizationId,
      workspaceId: input.workspace.id,
      connectorId: input.connectorId,
    });
    const storedOrigin = originOf(connector?.configJson.endpoint);
    const newOrigin = originOf(input.authorized.config.endpoint);
    const account =
      connector && connector.oauthAccountId
        ? await findOAuthAccountRecord({
            teamId: input.workspace.organizationId,
            workspaceId: input.workspace.id,
            accountId: connector.oauthAccountId,
          })
        : null;
    // Only re-point an existing connector at a credential from the SAME server
    // and the SAME login name; anything else is discarded, never silently
    // re-pointed.
    if (
      !connector ||
      storedOrigin === null ||
      newOrigin === null ||
      storedOrigin !== newOrigin ||
      !account ||
      account.displayName !== input.authorized.credential.username
    ) {
      await this.discard(
        input.adapter,
        input.authorized.config,
        input.authorized.credential,
      );
      throw new ConnectorError(
        400,
        "CONNECTOR_CREDENTIAL_FLOW_MISMATCH",
        "This login does not match the connector you are reconnecting.",
      );
    }

    try {
      await this.connectorService.rotateConnectorCredential({
        workspaceId: input.workspace.id,
        userId: input.userId,
        connectorId: connector.id,
        credential: input.authorized.credential,
      });
    } catch (error) {
      await this.discard(
        input.adapter,
        input.authorized.config,
        input.authorized.credential,
      );
      throw this.createFailedError(error);
    }

    const { connector: response } = await this.connectorService.getConnector({
      workspaceId: input.workspace.id,
      userId: input.userId,
      connectorId: connector.id,
    });
    return response;
  }

  private async requireReconnectConnector(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    connectorType: string;
  }): Promise<void> {
    const connector = await findSourceConnectorRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
    });
    if (!connector || connector.connectorType !== input.connectorType) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
  }

  private requireLoginFlowAdapter(connectorType: string): ConnectorAdapter {
    let manifest;
    try {
      manifest = this.registry.getManifest(connectorType);
    } catch {
      throw this.unsupportedError();
    }
    if (
      manifest.auth.kind !== "credential" ||
      manifest.auth.flow !== "login_flow"
    ) {
      throw this.unsupportedError();
    }
    const adapter = this.registry.getAdapter(connectorType);
    if (!adapter.credentialFlow) {
      throw this.unsupportedError();
    }
    return adapter;
  }

  private unsupportedError(): ConnectorError {
    return new ConnectorError(
      400,
      "CONNECTOR_CREDENTIAL_FLOW_UNSUPPORTED",
      "This connector does not support a browser login flow.",
    );
  }

  /**
   * The error to surface after a create/rotate failed once the provider already
   * issued the credential. A `ConnectorError` from create/rotate carries a
   * fixed, enumerated code and a fixed message (nothing in this codebase
   * interpolates caller input into one), so it is surfaced as-is; anything else
   * is replaced with a generic fixed error so no raw message can leak.
   */
  private createFailedError(error: unknown): ConnectorError {
    if (error instanceof ConnectorError) {
      return error;
    }
    return new ConnectorError(
      502,
      "CONNECTOR_CREDENTIAL_FLOW_FAILED",
      "The connection could not be completed. Try again.",
    );
  }

  private async discard(
    adapter: ConnectorAdapter,
    config: Record<string, unknown>,
    credential: ConnectorCredentialInput,
  ): Promise<void> {
    try {
      await adapter.credentialFlow?.discard?.({ config, credential });
    } catch {
      // Best-effort: a failed cleanup must never surface over the real result.
      logger.error("connector_credential_flow_discard_failed", {
        connectorType: adapter.getManifest().type,
      });
    }
  }

  private async cleanupExpired(connectorType: string): Promise<void> {
    try {
      await deleteExpiredCredentialFlowRecords({
        connectorType,
        now: new Date(),
      });
    } catch {
      logger.warn("connector_credential_flow_cleanup_failed", {
        connectorType,
      });
    }
  }

  private async decodeStored(
    attemptRef: string | null,
    teamId: string,
  ): Promise<StoredCredentialFlow | null> {
    if (!attemptRef) {
      return null;
    }
    try {
      const plain = await decryptTeamSecret(attemptRef, teamId);
      if (!plain) {
        return null;
      }
      const parsed = JSON.parse(plain) as StoredCredentialFlow;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.pending !== "object" ||
        parsed.pending === null
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
