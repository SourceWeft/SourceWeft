import type {
  AgentToolModelProfileServices,
  AgentToolModelProfileView,
  AgentToolTurnPreflight,
  AgentToolTurnPreflightInput,
} from "@sourceweft/contracts/agent-tools";
import { resolveImageModelCapabilities } from "./image-capabilities";
import {
  resolveGenerateImageIntentDecision,
  type GenerateImageEnabledSkillDescriptor,
} from "./intent";
import type {
  ArtifactIntentDecision,
  GenerateImageToolSelection,
  ImageModelCapabilities,
} from "./image-types";

type ByokExecution = NonNullable<GenerateImageToolSelection["execution"]>;

/**
 * What this capability parks on the turn so its tool can be bound later. The
 * host stores it opaquely under the tool's name; {@link readGenerateImageTurnState}
 * is the only way back in.
 */
export type GenerateImageTurnState = {
  readonly selection: GenerateImageToolSelection | undefined;
  readonly artifactIntent: ArtifactIntentDecision;
  readonly imageProfile: {
    readonly profile: AgentToolModelProfileView;
    readonly capabilities: ImageModelCapabilities;
  } | null;
};

/**
 * Walk the profile fallbacks in the order this capability needs them.
 *
 * Each step is one host lookup; the branching is ours because only we know that
 * an explicit model alias outranks a thread preference, that a BYOK request
 * should not be pinned to a configured profile, and that a workspace with no
 * image profile at all is still usable when the user brought their own key.
 */
async function resolveProfile(input: {
  readonly services: AgentToolModelProfileServices;
  readonly modelKind: string | null;
  readonly requestedProfileAlias?: string | null;
  readonly threadProfileAlias: string | null;
  readonly explicit: boolean;
  readonly hasByokExecution: boolean;
  readonly byokExecution?: ByokExecution;
  readonly requestedModelAlias?: string | null;
}) {
  const { services } = input;
  let profile = await services.resolveProfile({
    profileAlias:
      input.requestedModelAlias || input.hasByokExecution
        ? undefined
        : input.requestedProfileAlias === null
          ? undefined
          : (input.requestedProfileAlias ?? input.threadProfileAlias),
    modelAlias: input.hasByokExecution ? undefined : input.requestedModelAlias,
    required:
      input.requestedProfileAlias || input.requestedModelAlias
        ? false
        : input.explicit && !input.hasByokExecution,
  });
  if (!profile && input.requestedProfileAlias && !input.requestedModelAlias) {
    profile = await services.resolveProfile({
      required: input.explicit && !input.hasByokExecution,
    });
  }
  if (!profile && input.hasByokExecution) {
    profile = await services.resolveProfile({
      profileAlias: input.threadProfileAlias,
      required: false,
    });
  }
  if (!profile && input.hasByokExecution && input.byokExecution) {
    const byok = input.byokExecution;
    const modelAlias =
      byok.modelAlias ?? byok.providerModel ?? byok.byokModelId ?? "byok-image";
    profile = services.synthesizeByokProfile({
      profileAlias: `byok:${input.modelKind}:${byok.byokModelId ?? modelAlias}`,
      modelAlias,
      ...(byok.providerHint ? { providerKind: byok.providerHint } : {}),
    });
  }
  if (!profile) {
    return null;
  }
  return {
    profile,
    capabilities: resolveImageModelCapabilities({
      profile,
      modelId: profile.modelAlias,
    }),
  };
}

/**
 * Fold a request-level bring-your-own-key image config into the turn's
 * selection. The host resolved the credentials; which field of ours the model
 * alias lands in, and that a BYOK config implies the tool is wanted, are ours
 * to decide.
 */
function applyByokExecution(input: {
  readonly selection: GenerateImageToolSelection | undefined;
  readonly execution: unknown;
}): GenerateImageToolSelection | undefined {
  const execution = input.execution as ByokExecution | undefined;
  if (execution?.executionMode !== "BYOK") {
    return input.selection;
  }
  return {
    ...(input.selection ?? {}),
    enabled: input.selection?.enabled ?? true,
    execution,
    ...(execution.modelAlias
      ? { modelAlias: execution.modelAlias }
      : execution.providerModel
        ? { modelAlias: execution.providerModel }
        : {}),
  };
}

export const generateImageTurnPreflight: AgentToolTurnPreflight = {
  // The placeholder the client draws before any pixels exist has to be the
  // right shape, and the shape was decided at preflight.
  readProgressSeed: (state) => {
    const intent = (state as GenerateImageTurnState | undefined)?.artifactIntent;
    if (intent?.kind !== "image") {
      return null;
    }
    return {
      aspectRatio: intent.config?.aspectRatio,
      quality: intent.config?.quality,
      style: intent.config?.style,
    };
  },
  run: async (input: AgentToolTurnPreflightInput) => {
    const selection = applyByokExecution({
      selection: input.selection as GenerateImageToolSelection | undefined,
      execution: input.execution,
    });
    // A turn pinned to some *other* tool is not an image turn, however the
    // options record reads.
    const claimsTurn = !(
      input.command?.kind === "tool" && input.command.toolName !== input.toolName
    );
    const { decision, imageProfile } = await resolveGenerateImageIntentDecision<
      never,
      AgentToolModelProfileView
    >({
      tools:
        claimsTurn && selection ? { [input.toolName]: selection } : undefined,
      enabledSkills:
        input.enabledSkills as readonly GenerateImageEnabledSkillDescriptor[],
      defaultToolEnabled: input.defaultEnabled,
      toolName: input.toolName,
      resolveImageProfile: (request) =>
        resolveProfile({
          services: input.services,
          modelKind: input.modelKind,
          requestedProfileAlias: input.requestedProfileAlias,
          threadProfileAlias: input.threadProfileAlias,
          explicit: request.explicit,
          hasByokExecution: request.hasByokExecution === true,
          ...(request.byokExecution
            ? { byokExecution: request.byokExecution }
            : {}),
          requestedModelAlias: request.requestedModelAlias,
        }),
    });
    const state: GenerateImageTurnState = {
      selection,
      artifactIntent: decision,
      imageProfile,
    };
    return {
      ...(selection ? { selection } : {}),
      state,
      messageMetadata: { artifactIntent: decision },
    };
  },
};

/**
 * Read this capability's slice back out of the turn's opaque preflight state.
 * Callers that bind the tool go through here instead of reaching into a record
 * the host deliberately does not type.
 */
export function readGenerateImageTurnState(
  turnState: Readonly<Record<string, unknown>> | undefined,
  toolName: string,
): GenerateImageTurnState | undefined {
  return turnState?.[toolName] as GenerateImageTurnState | undefined;
}
