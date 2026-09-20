import { readSkillObjectFile } from "./file-content";

/**
 * A README is shown in a catalog panel, not executed: past this size it is not
 * worth a download, and the panel falls back to SKILL.md.
 */
const MAX_README_BYTES = 512 * 1024;

const README_PATH = /^readme(?:\.[a-z0-9-]+)?\.md$/i;

function byReadmePreference(a: { path: string }, b: { path: string }) {
  const rank = (name: string) =>
    name === "README.md" ? 0 : /^readme\.md$/i.test(name) ? 1 : 2;
  return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, "en");
}

/**
 * Select documentation from the frozen bundle, never from a moving upstream ref.
 * Works on rows that carry their text inline (builtins from disk, `db_text`
 * manifest rows); rows without `contentText` are simply not documents here.
 */
export function readSkillDocuments(
  files: ReadonlyArray<{ path: string; contentText?: string | null }>,
) {
  const readme = files
    .filter((file) => README_PATH.test(file.path) && file.contentText?.trim())
    .sort(byReadmePreference)[0];
  return {
    readmeContent: readme?.contentText ?? null,
    readmePath: readme?.path ?? null,
    skillContent:
      files.find((file) => file.path === "SKILL.md")?.contentText ?? null,
  };
}

/**
 * The same selection for a stored version of any storage type. An `object`
 * version keeps SKILL.md on the version row (`skill_md`) and its README as a
 * blob, which is read bounded and only after the manifest picked it — no other
 * file is touched.
 */
export async function readSkillVersionDocuments(input: {
  version: { skillMd: string | null };
  files: ReadonlyArray<{
    path: string;
    mimeType: string;
    sizeBytes: number;
    objectKey: string | null;
    contentText: string | null;
  }>;
  signal?: AbortSignal;
}) {
  const inline = readSkillDocuments(input.files);
  const skillContent = input.version.skillMd ?? inline.skillContent;
  if (inline.readmeContent !== null) {
    return { ...inline, skillContent };
  }
  const candidates = input.files
    .filter(
      (file) =>
        README_PATH.test(file.path) &&
        file.objectKey !== null &&
        file.sizeBytes > 0 &&
        file.sizeBytes <= MAX_README_BYTES,
    )
    .sort(byReadmePreference);
  for (const file of candidates) {
    const content = await readSkillObjectFile({
      objectKey: file.objectKey!,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      maxBytes: MAX_README_BYTES,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if ("text" in content && content.text.trim()) {
      return {
        readmeContent: content.text,
        readmePath: file.path,
        skillContent,
      };
    }
  }
  return { readmeContent: null, readmePath: null, skillContent };
}
