/**
 * Pure authoring rules for workspace personas: how a copy is derived from its
 * source, which edits are accepted, and how the human slug is formed. Kept
 * free of I/O so the rules are unit-testable and the repository stays thin.
 */
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { ContentError } from "../../../content/errors";
import type {
  PersonaFilesystemPolicy,
  PersonaModelSettings,
  PersonaSpec,
} from "./types";

/** The business tool names a persona allowlist may reference. */
export const PERSONA_AVAILABLE_TOOLS: readonly string[] = Object.freeze(
  Object.values(AGENT_TOOL_NAMES),
);

export const PERSONA_NAME_MAX_LENGTH = 80;
export const PERSONA_DESCRIPTION_MAX_LENGTH = 500;
export const PERSONA_SYSTEM_PROMPT_MAX_LENGTH = 20_000;
export const PERSONA_TOOL_ALLOWLIST_MAX_LENGTH = 64;

/** Edits a member may apply to a copy; every field is optional. */
export type PersonaOverrides = {
  name?: string;
  description?: string;
  systemPrompt?: string;
  modelSettings?: PersonaModelSettings | null;
  toolAllowlist?: readonly string[] | null;
  filesystemPolicy?: PersonaFilesystemPolicy;
};

/** The editable fields of a workspace persona, fully resolved. */
export type PersonaDraft = {
  name: string;
  description: string;
  systemPrompt: string;
  avatar: string | null;
  modelSettings: PersonaModelSettings;
  toolAllowlist: string[] | null;
  filesystemPolicy: PersonaFilesystemPolicy;
};

function invalid(message: string): never {
  throw new ContentError(400, "PERSONA_INVALID", message);
}

function normalizeName(value: string) {
  const name = value.trim();
  if (name.length === 0) invalid("Persona name is required");
  if (name.length > PERSONA_NAME_MAX_LENGTH) {
    invalid(
      `Persona name must be at most ${PERSONA_NAME_MAX_LENGTH} characters`,
    );
  }
  return name;
}

function normalizeDescription(value: string) {
  const description = value.trim();
  if (description.length > PERSONA_DESCRIPTION_MAX_LENGTH) {
    invalid(
      `Persona description must be at most ${PERSONA_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return description;
}

function normalizeSystemPrompt(value: string) {
  const prompt = value.trim();
  if (prompt.length === 0) invalid("Persona instructions are required");
  if (prompt.length > PERSONA_SYSTEM_PROMPT_MAX_LENGTH) {
    invalid(
      `Persona instructions must be at most ${PERSONA_SYSTEM_PROMPT_MAX_LENGTH} characters`,
    );
  }
  return prompt;
}

function normalizeModelSettings(
  value: PersonaModelSettings | null | undefined,
): PersonaModelSettings {
  const alias = (entry: string | null | undefined) => {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (trimmed.length > 512) invalid("Model alias is too long");
    return trimmed.length > 0 ? trimmed : null;
  };
  const settings: PersonaModelSettings = {};
  const profile = alias(value?.llmProfileAlias);
  const model = alias(value?.llmModelAlias);
  if (profile) settings.llmProfileAlias = profile;
  if (model) settings.llmModelAlias = model;
  return settings;
}

/**
 * Validate an allowlist against the tools a persona may name. Unknown names are
 * rejected rather than dropped so a typo cannot silently widen or narrow what
 * the persona can do.
 */
export function normalizeToolAllowlist(
  value: readonly string[] | null | undefined,
  availableTools: readonly string[] = PERSONA_AVAILABLE_TOOLS,
): string[] | null {
  if (value === null || value === undefined) return null;
  const available = new Set(availableTools);
  const seen = new Set<string>();
  const allowlist: string[] = [];
  for (const raw of value) {
    const name = raw.trim();
    if (!name) continue;
    if (!available.has(name)) {
      throw new ContentError(
        400,
        "PERSONA_TOOL_UNKNOWN",
        `Unknown tool "${name}" in persona allowlist`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    allowlist.push(name);
  }
  if (allowlist.length > PERSONA_TOOL_ALLOWLIST_MAX_LENGTH) {
    invalid(
      `Persona allowlist must name at most ${PERSONA_TOOL_ALLOWLIST_MAX_LENGTH} tools`,
    );
  }
  return allowlist;
}

/** A source's filesystem stance, as the policy a row stores. */
export function filesystemPolicyOf(
  source: Pick<PersonaSpec, "filesystemPermissions">,
): PersonaFilesystemPolicy {
  return source.filesystemPermissions?.length ? "read_only" : "default";
}

/**
 * Derive a copy of `source` with `overrides` applied. This is the only way a
 * workspace persona comes into being: a clone is exactly as valid as what it
 * was cloned from, and every edit passes the same checks.
 */
export function buildPersonaDraft(input: {
  source: PersonaSpec;
  overrides?: PersonaOverrides;
  availableTools?: readonly string[];
}): PersonaDraft {
  const { source, overrides = {} } = input;
  return {
    name: normalizeName(overrides.name ?? source.name),
    description: normalizeDescription(
      overrides.description ?? source.description,
    ),
    systemPrompt: normalizeSystemPrompt(
      overrides.systemPrompt ?? source.systemPrompt,
    ),
    avatar: source.avatar ?? null,
    modelSettings: normalizeModelSettings(
      overrides.modelSettings === undefined
        ? source.modelSettings
        : overrides.modelSettings,
    ),
    toolAllowlist: normalizeToolAllowlist(
      overrides.toolAllowlist === undefined
        ? source.toolAllowlist
        : overrides.toolAllowlist,
      input.availableTools,
    ),
    filesystemPolicy: overrides.filesystemPolicy ?? filesystemPolicyOf(source),
  };
}

/**
 * The validated subset of a draft an update writes. Only the fields present in
 * `patch` are returned, so a partial edit never resets what it did not name.
 */
export function buildPersonaPatch(input: {
  patch: PersonaOverrides;
  availableTools?: readonly string[];
}): Partial<PersonaDraft> {
  const { patch } = input;
  const next: Partial<PersonaDraft> = {};
  if (patch.name !== undefined) next.name = normalizeName(patch.name);
  if (patch.description !== undefined) {
    next.description = normalizeDescription(patch.description);
  }
  if (patch.systemPrompt !== undefined) {
    next.systemPrompt = normalizeSystemPrompt(patch.systemPrompt);
  }
  if (patch.modelSettings !== undefined) {
    next.modelSettings = normalizeModelSettings(patch.modelSettings);
  }
  if (patch.toolAllowlist !== undefined) {
    next.toolAllowlist = normalizeToolAllowlist(
      patch.toolAllowlist,
      input.availableTools,
    );
  }
  if (patch.filesystemPolicy !== undefined) {
    next.filesystemPolicy = patch.filesystemPolicy;
  }
  if (Object.keys(next).length === 0) {
    invalid("At least one persona field must be provided");
  }
  return next;
}

/** A URL-safe slug for display; identity stays on the row id. */
export function derivePersonaSlug(name: string) {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "agent";
}

/** Make `base` unique among `taken` by appending -2, -3, … */
export function uniquePersonaSlug(base: string, taken: Iterable<string>) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 64 - `-${suffix}`.length)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  invalid("Could not derive a unique persona slug");
}
