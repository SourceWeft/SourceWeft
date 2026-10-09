import {
  findCaseCollisions,
  isSafeBundlePath,
  SKILL_STORAGE_LIMITS,
  sha256,
} from "@sourceweft/skill-format";
import { METADATA_FILE } from "./metadata";

/**
 * Holds downloaded bytes to the registry's record of them.
 *
 * Every source file is held to its recorded bytes before installation.
 * A subsequent local metadata adapter records its installed hashes and keeps
 * the original SKILL.md, so loader compatibility does not replace source proof.
 */

export type ManifestFile = {
  path: string;
  sizeBytes: number;
  contentHash: string;
};

export type VerifiedFile = { path: string; bytes: Uint8Array };

export type VerificationProblem =
  | { kind: "unsafe-path"; path: string }
  | { kind: "case-collision"; path: string; other: string }
  | { kind: "reserved-name"; path: string }
  | { kind: "missing-skill-md" }
  | { kind: "too-many-files"; count: number }
  | { kind: "file-too-large"; path: string }
  | { kind: "bundle-too-large" }
  | { kind: "missing"; path: string }
  | { kind: "size-mismatch"; path: string; expected: number; actual: number }
  | { kind: "hash-mismatch"; path: string; expected: string; actual: string };

export class VerificationError extends Error {
  readonly problems: readonly VerificationProblem[];

  constructor(problems: readonly VerificationProblem[]) {
    super(
      `Downloaded skill does not match the registry's record (${problems
        .slice(0, 3)
        .map(describeProblem)
        .join(
          "; ",
        )}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""})`,
    );
    this.name = "VerificationError";
    this.problems = problems;
  }
}

export function describeProblem(problem: VerificationProblem): string {
  switch (problem.kind) {
    case "file-too-large":
      return `file '${problem.path}' exceeds the shared per-file limit`;
    case "bundle-too-large":
      return "bundle exceeds the shared total-byte limit";
    case "unsafe-path":
      return `'${problem.path}' is not a safe path`;
    case "case-collision":
      return `'${problem.path}' and '${problem.other}' differ only by case`;
    case "reserved-name":
      return `'${problem.path}' is reserved for the installer`;
    case "missing-skill-md":
      return "the skill has no SKILL.md";
    case "too-many-files":
      return `${problem.count} files exceeds the limit`;
    case "missing":
      return `'${problem.path}' was not in the download`;
    case "size-mismatch":
      return `'${problem.path}' is ${problem.actual} bytes, expected ${problem.expected}`;
    case "hash-mismatch":
      return `'${problem.path}' does not match its recorded hash`;
  }
}

/** Problems with the record itself, found before anything is downloaded. */
export function checkManifest(
  manifest: readonly ManifestFile[],
): VerificationProblem[] {
  const problems: VerificationProblem[] = [];
  if (manifest.length > SKILL_STORAGE_LIMITS.maxFiles) {
    problems.push({ kind: "too-many-files", count: manifest.length });
  }
  if (
    manifest.reduce((total, file) => total + file.sizeBytes, 0) >
    SKILL_STORAGE_LIMITS.maxBundleBytes
  )
    problems.push({ kind: "bundle-too-large" });
  for (const file of manifest) {
    if (file.sizeBytes > SKILL_STORAGE_LIMITS.maxFileBytes)
      problems.push({ kind: "file-too-large", path: file.path });
    if (!isSafeBundlePath(file.path)) {
      problems.push({ kind: "unsafe-path", path: file.path });
    } else if (file.path === METADATA_FILE) {
      problems.push({ kind: "reserved-name", path: file.path });
    }
  }
  for (const [path, other] of findCaseCollisions(
    manifest.map((file) => file.path),
  )) {
    problems.push({ kind: "case-collision", path, other });
  }
  if (!manifest.some((file) => file.path === "SKILL.md")) {
    problems.push({ kind: "missing-skill-md" });
  }
  return problems;
}

/**
 * Returns the manifest's files, in manifest order, with their bytes — or throws
 * `VerificationError` naming every way the download differs from the record.
 */
export function verifyFiles(
  manifest: readonly ManifestFile[],
  downloaded: ReadonlyMap<string, Uint8Array>,
): VerifiedFile[] {
  const problems = checkManifest(manifest);
  const verified: VerifiedFile[] = [];
  for (const file of manifest) {
    const bytes = downloaded.get(file.path);
    if (!bytes) {
      problems.push({ kind: "missing", path: file.path });
      continue;
    }
    if (bytes.byteLength !== file.sizeBytes) {
      problems.push({
        kind: "size-mismatch",
        path: file.path,
        expected: file.sizeBytes,
        actual: bytes.byteLength,
      });
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== file.contentHash) {
      problems.push({
        kind: "hash-mismatch",
        path: file.path,
        expected: file.contentHash,
        actual,
      });
      continue;
    }
    verified.push({ path: file.path, bytes });
  }
  if (problems.length > 0) {
    throw new VerificationError(problems);
  }
  return verified;
}
