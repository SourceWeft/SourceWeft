import type { SkillFrontmatter } from "./frontmatter";

/** SKILL.md frontmatter key listing the hosts a skill's commands talk to. */
export const SKILL_NETWORK_DOMAINS_KEY = "network-domains";
export const SKILL_NETWORK_DOMAINS_MAX_ENTRIES = 50;
export const SKILL_NETWORK_DOMAIN_MAX_LENGTH = 255;

export type SkillNetworkDomainIssueCode =
  | "NOT_A_LIST"
  | "ENTRY_NOT_A_STRING"
  | "ENTRY_TOO_LONG"
  | "ENTRY_INVALID"
  | "TOO_MANY_ENTRIES";

/** A problem with `network-domains`; the offending entry is dropped, not widened. */
export type SkillNetworkDomainIssue = {
  key: typeof SKILL_NETWORK_DOMAINS_KEY;
  code: SkillNetworkDomainIssueCode;
  /** Position of the dropped entry in the declared list. */
  index?: number;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The last label must not be all digits, so dotted/decimal IPv4 spellings
// ("127.0.0.1", "2130706433") can never pass as host names.
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A host (`api.example.com`) or a strict-subdomain wildcard (`*.example.com`).
 * Rejected on purpose: bare `*`, TLD-wide wildcards (`*.com`), single labels,
 * IP literals, ports, schemes, paths, and anything non-ASCII (use punycode).
 * The rules are at least as strict as the sandbox runtime's own allow-list
 * check, so an accepted entry is always usable there.
 */
export function normalizeSkillNetworkDomain(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (domain.length === 0 || domain.length > SKILL_NETWORK_DOMAIN_MAX_LENGTH)
    return null;
  const host = domain.startsWith("*.") ? domain.slice(2) : domain;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  return TLD.test(labels[labels.length - 1]!) ? domain : null;
}

/**
 * Reads `network-domains` from parsed SKILL.md frontmatter. Never throws: a
 * malformed declaration yields fewer (possibly zero) domains plus issues, so a
 * skill with a typo asks for approval instead of failing to load.
 */
export function readSkillNetworkDomains(frontmatter: SkillFrontmatter | null): {
  domains: string[];
  issues: SkillNetworkDomainIssue[];
} {
  const issues: SkillNetworkDomainIssue[] = [];
  const declared = frontmatter?.[SKILL_NETWORK_DOMAINS_KEY];
  if (declared === undefined || declared === null)
    return { domains: [], issues };
  if (!Array.isArray(declared)) {
    issues.push({ key: SKILL_NETWORK_DOMAINS_KEY, code: "NOT_A_LIST" });
    return { domains: [], issues };
  }
  const domains: string[] = [];
  declared.forEach((entry: unknown, index) => {
    const issue = (code: SkillNetworkDomainIssueCode) =>
      issues.push({ key: SKILL_NETWORK_DOMAINS_KEY, code, index });
    if (index >= SKILL_NETWORK_DOMAINS_MAX_ENTRIES)
      return issue("TOO_MANY_ENTRIES");
    if (typeof entry !== "string") return issue("ENTRY_NOT_A_STRING");
    if (entry.length > SKILL_NETWORK_DOMAIN_MAX_LENGTH)
      return issue("ENTRY_TOO_LONG");
    const domain = normalizeSkillNetworkDomain(entry);
    if (!domain) return issue("ENTRY_INVALID");
    if (!domains.includes(domain)) domains.push(domain);
  });
  return { domains, issues };
}
