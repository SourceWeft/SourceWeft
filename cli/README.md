# SourceWeft CLI

Install skills from the SourceWeft marketplace onto a local coding agent.

The marketplace only **indexes** skills: it records where each one lives (a
GitHub repository, pinned to a commit) and what every file in it hashes to. The
CLI downloads the files from that repository and installs them only if every
file matches the record — so what lands on your machine is the content that was
scanned, not whatever the upstream branch holds today.

```
npx @sourceweft/cli skills search pdf
npm install -g @sourceweft/cli   # then: sourceweft skills …
```

Requires Node 20 or newer. Until a release is published, run it from the
repository: `pnpm --filter @sourceweft/cli build`, then `node cli/dist/main.js …`.

## Commands

```
sourceweft skills search [query]   Search the marketplace
sourceweft skills info <slug>      Show a skill and where it comes from
sourceweft skills install <slug>   Install a skill for a coding agent
sourceweft skills list             List skills installed by sourceweft
sourceweft skills update [slug]    Update installed skills to the registry's version
sourceweft skills remove <slug>    Remove an installed skill
sourceweft skills doctor           Check installed skills for problems
```

Options: `--registry <url>`, `--agent <ids>`, `--scope user|project|all`,
`--dir <path>`, `--force`, `--dry-run`, `-y/--yes`, `--category`, `--sort`,
`--limit`, `--json`.

The registry defaults to `https://api.sourceweft.com`; `--registry` points the
command at another one. `list`, `remove` and `doctor` are purely local; `update`
talks to the registry each skill was installed from.

## Where skills go

| Agent            | `--scope user`               | `--scope project`  |
| ---------------- | ---------------------------- | ------------------ |
| `claude-code`    | `~/.claude/skills`           | `.claude/skills`   |
| `codex`          | `~/.agents/skills`           | `.agents/skills`   |
| `gemini-cli`     | `~/.gemini/skills`           | `.gemini/skills`   |
| `qwen-code`      | `~/.qwen/skills`             | `.qwen/skills`     |
| `amp`            | `~/.config/agents/skills`    | `.agents/skills`   |
| `cursor`         | `~/.cursor/skills`           | `.cursor/skills`   |
| `windsurf`       | `~/.codeium/windsurf/skills` | `.windsurf/skills` |
| `cline`          | `~/.cline/skills`            | `.cline/skills`    |
| `roo`            | `~/.roo/skills`              | `.roo/skills`      |
| `github-copilot` | `~/.copilot/skills`          | `.github/skills`   |
| `opencode`       | `~/.config/opencode/skills`  | `.opencode/skills` |
| `goose`          | `~/.agents/skills`           | `.agents/skills`   |
| `kiro`           | `~/.kiro/skills`             | `.kiro/skills`     |
| `universal`      | `~/.agents/skills`           | `.agents/skills`   |

Each entry is the agent's own documented directory (checked against its
official docs on 2026-09-21; `sourceweft skills agents` prints the same table).
Several agents also read the shared `.agents/skills` directory — Codex, Goose,
Gemini CLI, Cursor, Windsurf, Roo Code, GitHub Copilot, OpenCode and Amp — so
`--agent universal` installs once for all of them. Claude Code, Qwen Code, Cline
and Kiro do not document it.

Default is `--agent claude-code --scope user`. `--dir <path>` installs into that
directory instead. Agents that share a directory are installed for once; otherwise each gets its own copy. `update` refreshes
all of them and `doctor` reports copies that have drifted apart.

Each skill is a directory `<skills dir>/<name>/` holding its files plus a
`.sourceweft.json` recording the registry, commit, and the hash of every file.
That file is how the CLI knows a directory is its own: it never touches one that
lacks it.

## What it will and will not do

- **Verifies before writing.** The download is checked file by file against the
  registry's hashes. Any mismatch, missing file or oversize entry aborts with
  exit code 3 and nothing is written. Files in the repository that the registry
  did not list are never installed.
- **Installs atomically.** Files go into a temporary sibling directory first and
  are moved into place only when all are down.
- **Never overwrites what it did not create**, and never follows a symbolic link
  at a skill's location.
- **Protects your edits.** If you edited, deleted or added files inside an
  installed skill, `update` and `remove` refuse unless you pass `--force`.
- **Asks before running someone else's code.** Installing or updating prints the
  source, license, and whether the skill ships scripts, and asks to confirm.
  Without a terminal it exits with code 4 unless you pass `--yes`.
- Sends no telemetry.

## Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Success                                                  |
| 1    | Error (also: `doctor` found a problem)                   |
| 2    | Usage error                                              |
| 3    | The download did not match the registry's record         |
| 4    | Confirmation needed but no terminal; re-run with `--yes` |

## Development

```
pnpm --filter @sourceweft/cli test
pnpm --filter @sourceweft/cli check-types
pnpm --filter @sourceweft/cli lint
pnpm --filter @sourceweft/cli build
```

The parts shared with the backend — the content-hash definition, path and name
rules, size limits, and the in-memory zip reader — live in
`packages/skill-format` so both sides agree on them.
