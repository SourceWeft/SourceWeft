import { and, eq } from "drizzle-orm";
import { db, modelGatewayProfiles } from "@sourceweft/db";
import type { ReasoningEffort, ThinkingConfig } from "@sourceweft/model-gateway";

/**
 * Server-side thinking-capability defaults for chat calls.
 *
 * `ThinkingConfig.supportedParameters` / `supportedEfforts` gate whether the
 * OpenRouter-family adapter emits reasoning kwargs at all — a thinking config
 * without them is silently inert, and the provider default (thinking ON for
 * DeepSeek V4) wins. Those facts are synced from provider discovery into the
 * chat profile's `configJson` (config-sync, protected fields), but until now
 * only the web client couriered them back on each request: any other caller
 * that set `thinking: { enabled: false }` re-created the 2026-08-23 slow-title
 * incident. The billed gateway — the one door every model call already goes
 * through — now fills the absent fields from the server's own profile row, so
 * a caller can express intent ("off") without also knowing catalog trivia.
 *
 * Caller-supplied values always win; only absent fields are filled. BYOK calls
 * are skipped — `byok/service.ts` resolves support from the BYOK model's own
 * capabilities, and a GLOBAL profile's facts must never leak onto it.
 */
export interface ProfileThinkingSupport {
  supportedParameters?: string[];
  supportedEfforts?: ReasoningEffort[];
}

const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Lenient read of the profile configJson's synced thinking-support fields. */
export function readProfileThinkingSupport(
  configJson: unknown,
): ProfileThinkingSupport | null {
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) {
    return null;
  }
  const record = configJson as Record<string, unknown>;
  const support: ProfileThinkingSupport = {};
  if (Array.isArray(record.supportedParameters)) {
    const parameters = record.supportedParameters.filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    if (parameters.length > 0) {
      support.supportedParameters = parameters;
    }
  }
  if (Array.isArray(record.supportedEfforts)) {
    const efforts = record.supportedEfforts.filter(
      (value): value is ReasoningEffort =>
        typeof value === "string" && REASONING_EFFORTS.has(value),
    );
    if (efforts.length > 0) {
      support.supportedEfforts = efforts;
    }
  }
  return support.supportedParameters || support.supportedEfforts
    ? support
    : null;
}

export type ChatProfileThinkingSupportFinder = (input: {
  profileAlias?: string;
  modelAlias?: string;
}) => Promise<ProfileThinkingSupport | null>;

async function findRowConfigJson(
  column: "profileAlias" | "modelAlias",
  value: string,
): Promise<unknown | null> {
  const [row] = await db
    .select({ configJson: modelGatewayProfiles.configJson })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, "chat"),
        eq(modelGatewayProfiles[column], value),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);
  return row?.configJson ?? null;
}

/**
 * Looks the support facts up on the active chat profile, trying the request's
 * identifiers the way the rest of the stack resolves them: profile alias
 * first, then model alias. The payload's `model` string may be either, so a
 * caller passes it as both and the first hit wins.
 */
export const findChatProfileThinkingSupport: ChatProfileThinkingSupportFinder =
  async (input) => {
    const profileAlias = input.profileAlias?.trim();
    const modelAlias = input.modelAlias?.trim();
    const attempts: Array<["profileAlias" | "modelAlias", string]> = [];
    if (profileAlias) {
      attempts.push(["profileAlias", profileAlias]);
    }
    if (modelAlias) {
      attempts.push(["modelAlias", modelAlias]);
      if (modelAlias !== profileAlias) {
        attempts.push(["profileAlias", modelAlias]);
      }
    }
    for (const [column, value] of attempts) {
      const configJson = await findRowConfigJson(column, value);
      const support = configJson ? readProfileThinkingSupport(configJson) : null;
      if (support) {
        return support;
      }
    }
    return null;
  };

/** Fill only the absent fields; a caller-supplied value always wins. */
export function applyThinkingSupportDefaults(
  thinking: ThinkingConfig,
  support: ProfileThinkingSupport | null,
): ThinkingConfig {
  if (!support) {
    return thinking;
  }
  const fillParameters =
    thinking.supportedParameters === undefined &&
    support.supportedParameters !== undefined;
  const fillEfforts =
    thinking.supportedEfforts === undefined &&
    support.supportedEfforts !== undefined;
  if (!fillParameters && !fillEfforts) {
    return thinking;
  }
  return {
    ...thinking,
    ...(fillParameters
      ? { supportedParameters: support.supportedParameters }
      : {}),
    ...(fillEfforts ? { supportedEfforts: support.supportedEfforts } : {}),
  };
}

/**
 * The billed-gateway entry: returns a thinking config with server-resolved
 * support facts, or the input unchanged when there is nothing to do — no
 * thinking intent, fields already present, or a BYOK execution (which resolves
 * its own).
 */
export async function resolveChatThinkingWithDefaults(input: {
  thinking: ThinkingConfig | undefined;
  executionMode?: string;
  byokModelId?: string;
  profileAlias?: string;
  modelAlias?: string;
  finder?: ChatProfileThinkingSupportFinder;
}): Promise<ThinkingConfig | undefined> {
  const { thinking } = input;
  if (!thinking) {
    return thinking;
  }
  if (
    thinking.supportedParameters !== undefined &&
    thinking.supportedEfforts !== undefined
  ) {
    return thinking;
  }
  if (input.executionMode === "BYOK" || input.byokModelId) {
    return thinking;
  }
  const finder = input.finder ?? findChatProfileThinkingSupport;
  const support = await finder({
    ...(input.profileAlias ? { profileAlias: input.profileAlias } : {}),
    ...(input.modelAlias ? { modelAlias: input.modelAlias } : {}),
  });
  return applyThinkingSupportDefaults(thinking, support);
}
