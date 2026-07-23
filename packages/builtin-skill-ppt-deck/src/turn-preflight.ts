import type {
  AgentToolTurnPreflight,
  AgentToolTurnPreflightInput,
} from "@sourceweft/contracts/agent-tools";

export type ReviewDeckVisualsVisionProfile = {
  readonly gatewayConfigId: string;
  readonly profileAlias: string;
  readonly modelAlias: string;
};

export type ReviewDeckVisualsTurnState = {
  readonly visionProfile: ReviewDeckVisualsVisionProfile | null;
};

/**
 * Settle the default vision profile before the turn runs. A workspace with no
 * vision profile still binds the tool: it answers `skipped` instead, so the
 * degradation is visible in the QA record rather than a silently missing tool.
 */
export const reviewDeckVisualsTurnPreflight: AgentToolTurnPreflight = {
  async run(input: AgentToolTurnPreflightInput) {
    const profile = await input.services.resolveProfile({ required: false });
    const state: ReviewDeckVisualsTurnState = {
      visionProfile: profile
        ? {
            gatewayConfigId: profile.gatewayConfigId,
            profileAlias: profile.profileAlias,
            modelAlias: profile.modelAlias,
          }
        : null,
    };
    return { state };
  },
};

export function readReviewDeckVisualsTurnState(
  turnState: Readonly<Record<string, unknown>> | undefined,
  toolName: string,
): ReviewDeckVisualsTurnState | undefined {
  return turnState?.[toolName] as ReviewDeckVisualsTurnState | undefined;
}
