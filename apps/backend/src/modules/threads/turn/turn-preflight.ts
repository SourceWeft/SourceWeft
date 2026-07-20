import { agentToolTurnPreflights } from "@sourceweft/agent-tool-registry";
import type {
  AgentToolModelProfileServices,
  AgentToolTurnPreflightCommand,
  AgentToolTurnPreflightSkill,
} from "@sourceweft/contracts/agent-tools";
import { resolveModelGatewayProfile } from "../../../shared/model-gateway/client";
import type {
  ModelGatewayProfileKind,
  RuntimeModelGatewayProfile,
} from "../../../shared/model-gateway/types";

/**
 * The host half of the turn-preflight extension point.
 *
 * Everything here is mechanism: how to reach the model catalog, how to shape an
 * ephemeral profile, where to file what comes back. Nothing here knows what any
 * capability does with it, and nothing here is keyed by a capability name — a
 * tool joins in by declaring `turnPreflight`, and the model kind it declared in
 * `requirements` is what scopes the services it is handed.
 */

export type TurnPreflightOutcome = {
  /** Per-tool selections that replace what `turnSelection` produced. */
  readonly selections: Record<string, unknown>;
  /** Per-tool opaque state, read back by the same capability at bind time. */
  readonly turnState: Record<string, unknown>;
  /** Fields the capabilities asked to have recorded on the user message. */
  readonly messageMetadata: Record<string, unknown>;
};

/**
 * A profile the workspace never configured, standing in for a model the user
 * brought their own key for. It lives only as long as the turn: nothing writes
 * it back, and the empty `gatewayConfigId` is what marks it as unrouted.
 */
function synthesizeByokProfile(input: {
  readonly kind: ModelGatewayProfileKind;
  readonly profileAlias: string;
  readonly modelAlias: string;
  readonly providerKind?: string | null;
}): RuntimeModelGatewayProfile {
  const now = new Date().toISOString();
  return {
    id: `byok:${input.kind}:${input.profileAlias}`,
    kind: input.kind,
    gatewayConfigId: "",
    profileAlias: input.profileAlias,
    modelAlias: input.modelAlias,
    requestedDimensions: null,
    vectorStrategy: "auto",
    isDefault: false,
    isActive: true,
    configJson: {
      ...(input.providerKind ? { providerKind: input.providerKind } : {}),
      targetModel: input.modelAlias,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createModelProfileServices(
  modelKind: string | null,
): AgentToolModelProfileServices {
  const kind = modelKind as ModelGatewayProfileKind | null;
  return {
    resolveProfile: async (request) => {
      if (!kind) {
        return null;
      }
      return resolveModelGatewayProfile({
        kind,
        requestedProfileAlias: request.profileAlias,
        requestedModelAlias: request.modelAlias,
        defaultRequired: request.required,
      });
    },
    synthesizeByokProfile: (request) => {
      if (!kind) {
        throw new Error(
          "A tool without a declared model kind cannot mint a BYOK profile.",
        );
      }
      return synthesizeByokProfile({
        kind,
        profileAlias: request.profileAlias,
        modelAlias: request.modelAlias,
        ...(request.providerKind
          ? { providerKind: request.providerKind }
          : {}),
      });
    },
  };
}

/**
 * Run every registered preflight and collect what they hand back.
 *
 * The three by-model-kind maps are the host's whole contribution of turn facts.
 * They are keyed by model kind rather than tool name on purpose: the request
 * carries one image override and one vision override, not one per capability,
 * and a tool picks up the entry for the kind it said it needs.
 *
 * `requestedProfileAliasByModelKind` distinguishes "the request said nothing"
 * (key absent) from "the request asked for the default" (key present, null) —
 * a distinction the fallback order in some capabilities turns on.
 */
export async function runTurnPreflights(input: {
  readonly selections: Readonly<Record<string, unknown>>;
  readonly command: AgentToolTurnPreflightCommand | null;
  readonly enabledSkills: readonly AgentToolTurnPreflightSkill[];
  readonly executionByModelKind: Readonly<Record<string, unknown>>;
  readonly requestedProfileAliasByModelKind: Readonly<
    Record<string, string | null>
  >;
  readonly threadProfileAliasByModelKind: Readonly<
    Record<string, string | null>
  >;
}): Promise<TurnPreflightOutcome> {
  const selections: Record<string, unknown> = {};
  const turnState: Record<string, unknown> = {};
  const messageMetadata: Record<string, unknown> = {};
  for (const entry of agentToolTurnPreflights()) {
    const modelKind = entry.modelKind;
    const result = await entry.turnPreflight.run({
      toolName: entry.name,
      modelKind,
      selection: input.selections[entry.name],
      command: input.command,
      enabledSkills: input.enabledSkills,
      defaultEnabled: entry.defaultEnabled,
      execution: modelKind
        ? input.executionByModelKind[modelKind]
        : undefined,
      ...(modelKind &&
      Object.hasOwn(input.requestedProfileAliasByModelKind, modelKind)
        ? {
            requestedProfileAlias:
              input.requestedProfileAliasByModelKind[modelKind],
          }
        : {}),
      threadProfileAlias:
        (modelKind ? input.threadProfileAliasByModelKind[modelKind] : null) ??
        null,
      services: createModelProfileServices(modelKind),
    });
    if (!result) {
      continue;
    }
    if (result.selection !== undefined) {
      selections[entry.name] = result.selection;
    }
    if (result.state !== undefined) {
      turnState[entry.name] = result.state;
    }
    Object.assign(messageMetadata, result.messageMetadata ?? {});
  }
  return { selections, turnState, messageMetadata };
}
