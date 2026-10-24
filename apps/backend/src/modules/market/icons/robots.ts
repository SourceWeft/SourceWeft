/**
 * robots.txt for the icon fetcher (RFC 9309, the parts that matter here): the
 * group naming our product token wins over `*`; within a group the longest
 * matching rule wins and Allow beats Disallow on a tie; `*` and a trailing `$`
 * work in paths. Pure: the fetcher decides what a missing or failing file
 * means.
 */

export const ICON_FETCHER_PRODUCT = "SourceWeftIconFetcher";

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow allows everything; an empty Allow changes nothing.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  return groups;
}

function patternRegex(pattern: string) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

/** Whether `ICON_FETCHER_PRODUCT` may fetch `path` (with query) under `text`. */
export function robotsAllows(text: string, path: string): boolean {
  const groups = parseGroups(text);
  const product = ICON_FETCHER_PRODUCT.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(product));
  const applicable = named.length
    ? named
    : groups.filter((g) => g.agents.includes("*"));
  let best: { length: number; allow: boolean } | undefined;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!patternRegex(rule.pattern).test(path)) continue;
      const length = rule.pattern.length;
      if (
        !best ||
        length > best.length ||
        (length === best.length && rule.allow && !best.allow)
      ) {
        best = { length, allow: rule.allow };
      }
    }
  }
  return best ? best.allow : true;
}
