/**
 * The directory's instructions for AI agents, served as a SKILL.md at
 * `/skills/SKILL.md` and pointed to from `/llms.txt`: how to find, inspect and
 * install a skill from here with the SourceWeft CLI, and what not to do.
 *
 * Written for a model to follow, so it is explicit about the two places where
 * a careless agent would do harm: skipping the user's say before installing
 * scripts, and scraping a skill's web page for "install steps" instead of
 * using the CLI, which verifies what it installs.
 */

/** Where the CLI looks when no `--registry` is given. */
export const CLI_DEFAULT_REGISTRY = "https://api.sourceweft.com";

export function agentSkillMarkdown(input: {
  /** This site, e.g. https://sourceweft.com — where the directory lives. */
  siteUrl: string;
  /** The API the directory reads from — the CLI's registry. */
  registryUrl: string;
}): string {
  const site = input.siteUrl.replace(/\/+$/, "");
  const registry = input.registryUrl.replace(/\/+$/, "");
  // A deployment other than SourceWeft's own has its own registry, which the
  // CLI has to be told about on every command.
  const flag = registry === CLI_DEFAULT_REGISTRY ? "" : ` --registry ${registry}`;
  const cli = `npx @sourceweft/cli skills`;
  return `---
name: sourceweft-skills
description: Find and install agent skills from the SourceWeft skills directory (${site}/skills) onto this machine with the SourceWeft CLI, which verifies every file before writing it. Use when the user asks for a skill, wants to extend what their coding agent can do, or names a skill from ${site}/skills.
---

# SourceWeft skills directory

The directory at ${site}/skills indexes public agent skills from GitHub
repositories. For each skill it records the repository, the exact commit it was
scanned at, and the hash of every file. It does not host the files: the CLI
downloads them from the repository at that commit and installs them only if
every file matches the record.

Use the CLI below for everything. Do not fetch a skill's web page to "learn the
install steps" or copy files by hand — the page is for people, and a manual
copy skips the hash check.

## Search

\`\`\`sh
${cli} search "<what the user needs>"${flag}
${cli} search --category <slug> --sort recommended${flag}
\`\`\`

Add \`--json\` for machine-readable output. Sorts: \`recommended\`,
\`popular\`, \`new\`, \`name\`.

## Inspect before installing

\`\`\`sh
${cli} info <slug>${flag}
\`\`\`

Show the user what it prints: the source repository and commit, the license,
whether the skill ships scripts, and any scan flags. Scan flags are advisory
notes from an automated scan (for example "makes outbound network calls");
say them out loud rather than deciding for the user.

## Install

\`\`\`sh
${cli} install <slug>${flag}
${cli} install <slug> --agent claude-code${flag}
\`\`\`

- \`--agent\` picks where it goes: \`claude-code\` (the default), \`codex\`,
  \`cursor\`, \`universal\` (the shared \`.agents/skills\` directory many agents
  read) and others — \`${cli} agents\` lists them.
- \`--scope project\` installs into the current project instead of the user's
  home directory.

Every file is checked against the hashes recorded when the skill was scanned.
Exit code 3 means the download did not match: nothing was written. Do not retry
with another tool or copy the files yourself — tell the user.

## Scripts need the user's agreement

A skill that ships scripts runs code on this machine when it is used. The CLI
asks for confirmation before installing, and without a terminal it stops with
exit code 4. Pass \`--yes\` only after the user has agreed to install that
specific skill, having seen what \`info\` showed. Never add \`--yes\` on your
own initiative.

## Keep installed skills current

\`\`\`sh
${cli} list
${cli} update [slug]
${cli} doctor
\`\`\`

\`update\` asks before replacing anything, since a new version can bring new
scripts; the same rule about \`--yes\` applies. Skills the CLI did not install
are never touched.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Success |
| 1 | Error |
| 2 | Usage error |
| 3 | The download did not match the recorded hashes; nothing was written |
| 4 | Confirmation needed and no terminal; ask the user, then re-run with \`--yes\` |

Browse the directory: ${site}/skills
`;
}

/**
 * `/llms.txt`: the site in a few lines for language models. Points agents at
 * the directory's SKILL.md, which says how to install with the CLI, rather
 * than at the pages meant for people.
 */
export function llmsText(siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, "");
  return `# SourceWeft

> SourceWeft is an AI notebook workspace. Its public skills directory indexes agent skills from GitHub repositories, pinned to the commit they were scanned at.

## Skills

- [Installing skills with the SourceWeft CLI](${site}/skills/SKILL.md): how an agent searches, inspects and installs skills from the directory. Read this instead of scraping skill pages.
- [Skills directory](${site}/skills): the directory for people.
`;
}
