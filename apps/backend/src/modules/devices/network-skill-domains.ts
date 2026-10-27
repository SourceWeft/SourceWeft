import {
  parseSkillFrontmatter,
  readSkillNetworkDomains,
} from "@sourceweft/skill-format";

/**
 * The part of an enabled skill the network policy needs. `sourceType` is what
 * the platform recorded when the skill was installed, never anything the
 * skill's own text claims.
 */
export type NetworkSkillInput = {
  name: string;
  sourceType: string;
  skillMd?: string | undefined;
};

/** Skills whose domains may be allowed without asking (decision N6). */
const TRUSTED_NETWORK_SKILL_SOURCES: ReadonlySet<string> = new Set(["builtin"]);

export const MAX_NETWORK_POLICY_ENTRIES = 500;

function declaredDomains(skill: NetworkSkillInput): string[] {
  if (!skill.skillMd) return [];
  try {
    return readSkillNetworkDomains(parseSkillFrontmatter(skill.skillMd))
      .domains;
  } catch {
    // Malformed frontmatter declares nothing; it never widens access.
    return [];
  }
}

/**
 * `trusted` are domains declared by platform-shipped skills and are allowed
 * outright. Every other skill's domains are only `suggested` (domain -> skill
 * name): the approval card can say who asked, but the user still decides.
 */
export function resolveSkillNetworkDomains(
  skills: readonly NetworkSkillInput[],
): { trusted: string[]; suggested: Record<string, string> } {
  const trusted = new Set<string>();
  const suggested = new Map<string, string>();
  for (const skill of skills) {
    const isTrusted = TRUSTED_NETWORK_SKILL_SOURCES.has(skill.sourceType);
    for (const domain of declaredDomains(skill)) {
      if (isTrusted) trusted.add(domain);
      else if (!suggested.has(domain)) suggested.set(domain, skill.name);
    }
  }
  for (const domain of trusted) suggested.delete(domain);
  return {
    trusted: [...trusted].slice(0, MAX_NETWORK_POLICY_ENTRIES),
    suggested: Object.fromEntries(
      [...suggested].slice(0, MAX_NETWORK_POLICY_ENTRIES),
    ),
  };
}
