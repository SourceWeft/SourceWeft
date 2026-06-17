import type { ThreadChatPreferences } from "@sourceweft/contracts";

export type ThreadChatPreferencesPatch = {
  thinking?: Partial<ThreadChatPreferences["thinking"]>;
  webAccess?: boolean;
  composerOptions?: Record<string, unknown>;
};

export const DEFAULT_THREAD_CHAT_PREFERENCES: ThreadChatPreferences = {
  thinking: { mode: "auto", effort: "medium" },
  webAccess: true,
  composerOptions: {},
};

const MAX_JSON_BYTES = 16 * 1024;

function jsonSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isSecretLikeKey(key: string) {
  return /secret|token|api[_-]?key|password|credential/i.test(key);
}

function sanitizeComposerOptions(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (
    depth > 4 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretLikeKey(key)) {
      continue;
    }
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        next[key] = item
          .filter((entry) => !entry || typeof entry !== "object")
          .slice(0, 100);
        continue;
      }
      next[key] = sanitizeComposerOptions(item, depth + 1);
      continue;
    }
    next[key] = item;
  }

  return next;
}

function normalizeThinking(value: unknown): ThreadChatPreferences["thinking"] {
  const input = plainObject(value);
  const mode =
    input.mode === "off" || input.mode === "auto" || input.mode === "effort"
      ? input.mode
      : DEFAULT_THREAD_CHAT_PREFERENCES.thinking?.mode;
  const effort =
    input.effort === "minimal" ||
    input.effort === "low" ||
    input.effort === "medium" ||
    input.effort === "high" ||
    input.effort === "xhigh"
      ? input.effort
      : DEFAULT_THREAD_CHAT_PREFERENCES.thinking?.effort;
  return {
    mode: mode ?? "auto",
    effort: effort ?? "medium",
  };
}

export function normalizeThreadChatPreferences(
  value: unknown,
): ThreadChatPreferences {
  const input = plainObject(value);
  const next: ThreadChatPreferences = { ...DEFAULT_THREAD_CHAT_PREFERENCES };

  if ("thinking" in input) {
    next.thinking = normalizeThinking(input.thinking);
  }
  if (typeof input.webAccess === "boolean") {
    next.webAccess = input.webAccess;
  }
  if (
    input.composerOptions &&
    typeof input.composerOptions === "object" &&
    !Array.isArray(input.composerOptions)
  ) {
    next.composerOptions = sanitizeComposerOptions(input.composerOptions);
  }

  if (jsonSize(next) > MAX_JSON_BYTES) {
    return DEFAULT_THREAD_CHAT_PREFERENCES;
  }

  return next;
}

export function mergeThreadChatPreferences(
  current: ThreadChatPreferences,
  patch: ThreadChatPreferencesPatch,
) {
  return normalizeThreadChatPreferences({
    ...current,
    ...patch,
    thinking:
      patch.thinking === undefined
        ? current.thinking
        : {
            ...(current.thinking ?? DEFAULT_THREAD_CHAT_PREFERENCES.thinking),
            ...patch.thinking,
          },
    composerOptions:
      patch.composerOptions === undefined
        ? current.composerOptions
        : patch.composerOptions,
  });
}
