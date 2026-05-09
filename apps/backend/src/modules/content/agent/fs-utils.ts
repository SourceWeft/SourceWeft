export const MAX_GLOB_RESULTS = 200;
export const MAX_GREP_RESULTS = 50;

export function simpleGlobToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "::DOUBLE_STAR_SLASH::")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLE_STAR_SLASH::/g, "(?:.*/)?")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function compileGrepRegex(pattern: string) {
  const normalized = pattern.trim().replace(/^\(\?i\)/, "");
  if (normalized.length === 0) {
    return "grep pattern must not be empty";
  }

  try {
    return new RegExp(normalized, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid regex pattern '${pattern}': ${message}`;
  }
}

export function lineNumberContent(content: string) {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

export function sanitizeNonCitableCitationMarkers(content: string) {
  return content
    .replace(
      /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/gi,
      "[non-citable citation marker $1 removed]",
    )
    .replace(/\bcitation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\b/gi, "non-citable citation marker $1 removed");
}

export function formatTimestamp(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

export function performStringReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
) {
  if (content === "" && oldString === "") {
    return [newString, 0] as const;
  }
  if (oldString === "") {
    return "Error: oldString cannot be empty when file has content";
  }

  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return `Error: String not found in file: '${oldString}'`;
  }
  if (occurrences > 1 && !replaceAll) {
    return `Error: String '${oldString}' has multiple occurrences (appears ${occurrences} times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
  }

  return [content.split(oldString).join(newString), occurrences] as const;
}
