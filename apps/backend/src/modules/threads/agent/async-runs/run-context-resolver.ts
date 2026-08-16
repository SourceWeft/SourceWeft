/**
 * The production {@link RunContextResolver}: rebuild, out of the request context,
 * the same billed model + tenant backend + read-only `search_sources` tool that
 * the synchronous chat turn builds — from the tenancy `context` the parent turn
 * stored on the run (`getRunConfig`).
 *
 * This is the billing / tenancy boundary. It mirrors the sync path exactly:
 *   - the billed model via {@link openBilledModelGateway} + `agentChatModel`
 *     (see `turn/turn-billing-scope.ts`), so every child call the delegate makes
 *     settles against the acting user's scope — never an unwrapped model;
 *   - the filesystem backend via {@link buildFilesystemBackend} +
 *     {@link buildAgentBackend} (see `turn/turn-assembly.ts`);
 *   - the `search_sources` tool via {@link runToolRetrieval} scoped to the run's
 *     team / workspace / sources (see `capability-tools/host-services.ts`).
 *
 * Dependencies (`billing`, `resolveBillingOrganizationId`, `openGateway`,
 * `getCheckpointer`) are injected so the wiring is unit-testable with fakes; the
 * worker passes the real singletons.
 */
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { PreparedThreadTurn } from "../../turn/types";
import type { ContentBillingPort } from "../../../content";
import { billingService } from "../../../billing";
import { workspaceService } from "../../../workspace/service";
import {
  openBilledModelGateway,
  type BillingScope,
} from "../../../../shared/model-gateway";
import { getChatCheckpointer } from "../../../../shared/chat-checkpointer";
import { createRetrievalTool } from "@sourceweft/builtin-retrieval";
import { buildAgentBackend, buildFilesystemBackend } from "../turn/turn-assembly";
import { createTurnRuntime } from "../turn/turn-runtime";
import { runToolRetrieval } from "../turn/retrieval-runner";
import type { RunContext, RunContextResolver } from "./delegate-executor";
import type { RunContextConfig, RunInput, RunsStore } from "./types";

type OpenGateway = typeof openBilledModelGateway;

export interface DelegateRunContextResolverDeps {
  /** Reads the persisted `{ input, context }` a run was created with. */
  store: Pick<RunsStore, "getRunConfig">;
  billing?: ContentBillingPort;
  resolveBillingOrganizationId?: (input: {
    workspaceId: string;
    userId: string;
    workspaceOrganizationId: string;
  }) => Promise<string>;
  openGateway?: OpenGateway;
  getCheckpointer?: () => Promise<unknown>;
}

/**
 * Synthesize the minimal {@link PreparedThreadTurn} the backend + retrieval
 * helpers actually read (a bounded, audited field set — see the resolver map),
 * so we can reuse them verbatim without a real turn. The run id stands in for
 * the message id / idempotency root: stable and unique per run.
 */
function synthesizePrepared(
  runId: string,
  context: RunContextConfig,
): PreparedThreadTurn {
  const sourceIds = context.sourceIds ?? [];
  return {
    userId: context.userId,
    workspace: { organizationId: context.teamId, id: context.workspaceId },
    thread: { id: context.parentThreadId },
    userMessage: { id: runId },
    runTraceId: runId,
    llmIdempotencyKey: runId,
    sourceIds,
    effectiveMentionedSourceIds: [],
    enabledSkills: [],
    traceContinuation: null,
  } as unknown as PreparedThreadTurn;
}

export function createDelegateRunContextResolver(
  deps: DelegateRunContextResolverDeps,
): RunContextResolver {
  const billing = deps.billing ?? billingService;
  const resolveBillingOrg =
    deps.resolveBillingOrganizationId ??
    ((input) => workspaceService.resolveBillingOrganizationId(input));
  const openGateway = deps.openGateway ?? openBilledModelGateway;
  const getCheckpointer = deps.getCheckpointer ?? getChatCheckpointer;

  return async (run): Promise<RunContext> => {
    const config = await deps.store.getRunConfig(run.runId);
    if (!config) {
      throw new Error(
        `No run config for ${run.runId}; cannot rebuild the billed model / tenant scope`,
      );
    }
    const context = config.context;

    // ── Billed model (mirror turn-billing-scope.ts) ──────────────────────────
    const billingTeamId = await resolveBillingOrg({
      workspaceId: context.workspaceId,
      userId: context.userId,
      workspaceOrganizationId: context.teamId,
    });
    const { gateway } = await openGateway({
      billing,
      gatewayConfigId: context.gatewayConfigId,
      context: {
        teamId: billingTeamId,
        workspaceId: context.workspaceId,
        actorUserId: context.userId,
        feature: "chat",
        // A background delegate is not BYOK-covered; it bills like a turn.
        intent: { mode: "billed" },
        scopeKind: "worker-job",
        scopeId: run.runId,
        threadId: context.parentThreadId,
      },
    });
    const model: BaseLanguageModel = await gateway.agentChatModel({
      modelAlias: context.providerModel,
      billing: {
        modelKind: "chat",
        gatewayConfigId: context.gatewayConfigId,
        profileAlias: context.profileAlias,
        modelAlias: context.modelAlias,
      },
    });

    // ── Tenant backend + read-only search_sources (mirror turn-assembly.ts) ──
    const prepared = synthesizePrepared(run.runId, context);
    const runtime = createTurnRuntime({ prepared });
    const filesystemBackend = buildFilesystemBackend({ prepared, runtime });
    const backend = buildAgentBackend({ filesystemBackend, sandboxRuntime: null });

    const searchSourcesTool = createRetrievalTool({
      searchSources: async (query, toolCallRuntime) => {
        const startedAt = Date.now();
        const toolName = toolCallRuntime?.toolName ?? "search_sources";
        const retrieval = await runToolRetrieval({ prepared, query, billing });
        const citationByChunkId = runtime.recordRetrieval({
          callId: `retrieval:${toolName}:${runtime.retrievalCallOrder.length + 1}`,
          query,
          retrieval,
          latencyMs: Date.now() - startedAt,
        });
        return runtime.buildRetrievalChunks({ retrieval, citationByChunkId });
      },
    });

    return {
      model,
      backend,
      checkpointer: await getCheckpointer(),
      // Read-only FS tools (ls/glob/grep/read_file) are provided by the delegate
      // graph's own filesystem middleware over `backend`; only the business tool
      // travels here for the delegate factory to filter.
      availableTools: [searchSourcesTool as { name: string }],
      input: config.input as RunInput as RunContext["input"],
    };
  };
}

export type { BillingScope };
