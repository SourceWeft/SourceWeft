/** Select documentation from the frozen bundle, never from a moving upstream ref. */
export function readSkillDocuments(
  files: Array<{ path: string; contentText: string }>,
) {
  const readme = files
    .filter(
      (file) =>
        /^readme(?:\.[a-z0-9-]+)?\.md$/i.test(file.path) &&
        file.contentText.trim(),
    )
    .sort((a, b) => {
      const rank = (name: string) =>
        name === "README.md" ? 0 : /^readme\.md$/i.test(name) ? 1 : 2;
      return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, "en");
    })[0];
  return {
    readmeContent: readme?.contentText ?? null,
    readmePath: readme?.path ?? null,
    skillContent:
      files.find((file) => file.path === "SKILL.md")?.contentText ?? null,
  };
}
