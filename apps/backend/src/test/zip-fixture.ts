import { strToU8, zipSync } from "fflate";

/**
 * A GitHub-shaped zipball: everything under one `<repo>-<sha>/` root. Zeros
 * deflate to almost nothing, so archives padded with them stay small and fast.
 */
export function zipball(files: Record<string, string | Uint8Array>) {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [
          `skills-abc/${path}`,
          typeof content === "string" ? strToU8(content) : content,
        ]),
      ),
    ),
  );
}
