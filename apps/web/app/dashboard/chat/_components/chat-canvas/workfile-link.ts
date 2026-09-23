/** Virtual workfiles are private to the conversation, not public web routes. */
export function resolveWorkfileLink(
  href: unknown,
  origin?: string,
): string | null {
  if (typeof href !== "string") return null;
  const input =
    origin && href.startsWith(`${origin}/files/`)
      ? href.slice(origin.length)
      : href;
  if (!input.startsWith("/files/")) return null;
  try {
    const path = decodeURIComponent(input.split(/[?#]/, 1)[0]!);
    if (/[\\%]/.test(path) || [...path].some((char) => char.charCodeAt(0) < 32))
      return null;
    const segments = path.slice(7).split("/");
    if (
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    )
      return null;
    return path;
  } catch {
    return null;
  }
}
