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

// A file past these bounds is not read as rules: the answer is "do not fetch".
export const ROBOTS_MAX_RULES = 1000;
export const ROBOTS_MAX_PATTERN_LENGTH = 512;
export const ROBOTS_MAX_WILDCARDS = 16;
export const ROBOTS_MAX_PATH_LENGTH = 2048;

/**
 * Whether `pattern` (`*` wildcards, an optional trailing `$`) matches a prefix
 * of `path`, or all of it when anchored. Linear in the path for each literal
 * segment — no regular expression, so a hostile rule cannot backtrack: the
 * path is chosen by the remote site and the pattern is its own.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");
  if (segments.length === 1) {
    return anchored ? path === body : path.startsWith(body);
  }
  const first = segments[0]!;
  if (!path.startsWith(first)) return false;
  let position = first.length;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const found = path.indexOf(segments[i]!, position);
    if (found < 0) return false;
    position = found + segments[i]!.length;
  }
  const last = segments[segments.length - 1]!;
  if (anchored) {
    return (
      path.length - last.length >= position && path.endsWith(last)
    );
  }
  return path.indexOf(last, position) >= 0;
}

/** Whether `ICON_FETCHER_PRODUCT` may fetch `path` (with query) under `text`. */
export function robotsAllows(text: string, path: string): boolean {
  if (path.length > ROBOTS_MAX_PATH_LENGTH) return false;
  const groups = parseGroups(text);
  let ruleCount = 0;
  for (const group of groups) {
    for (const rule of group.rules) {
      ruleCount += 1;
      if (
        ruleCount > ROBOTS_MAX_RULES ||
        rule.pattern.length > ROBOTS_MAX_PATTERN_LENGTH ||
        rule.pattern.split("*").length - 1 > ROBOTS_MAX_WILDCARDS
      ) {
        // Not a file to interpret: do not fetch.
        return false;
      }
    }
  }
  const product = ICON_FETCHER_PRODUCT.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(product));
  const applicable = named.length
    ? named
    : groups.filter((g) => g.agents.includes("*"));
  let best: { length: number; allow: boolean } | undefined;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!robotsPatternMatches(rule.pattern, path)) continue;
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
