import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where each coding agent looks for skills, taken from that agent's own
 * documentation (checked 2026-09-21) — not from third-party lists, which
 * disagree with each other and with the vendors.
 *
 * Each entry names the agent's OWN documented directory. Several agents also
 * read the shared `.agents/skills` convention; `universal` is the way to
 * install once for all of them. Where an entry deliberately differs from a
 * common belief, the reason is next to it.
 */

export type AgentProfile = {
  id: string;
  label: string;
  /** Under the home directory. */
  userDir: string;
  /** Under the project root. */
  projectDir: string;
  /** Also reads the shared `.agents/skills` directory (user and project). */
  readsShared?: boolean;
};

const skills = (...parts: string[]) => join(...parts, "skills");

export const AGENTS: readonly AgentProfile[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    userDir: skills(".claude"),
    projectDir: skills(".claude"),
  },
  {
    id: "universal",
    label: "Shared .agents directory",
    userDir: skills(".agents"),
    projectDir: skills(".agents"),
  },
  {
    // Codex's docs give `.agents/skills` as its directory. The `~/.codex/skills`
    // that third-party lists show is not in them.
    id: "codex",
    label: "OpenAI Codex CLI",
    userDir: skills(".agents"),
    projectDir: skills(".agents"),
    readsShared: true,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    userDir: skills(".gemini"),
    projectDir: skills(".gemini"),
    readsShared: true,
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    userDir: skills(".qwen"),
    projectDir: skills(".qwen"),
  },
  {
    // User directory follows Amp's own announcement; its docs page also lists
    // `~/.agents/skills`. The default location moves with XDG_CONFIG_HOME,
    // which is not honoured here.
    id: "amp",
    label: "Amp",
    userDir: skills(".config", "agents"),
    projectDir: skills(".agents"),
    readsShared: true,
  },
  {
    // Cursor documents both `.cursor/skills` and `.agents/skills`; the two
    // third-party lists each had half of that.
    id: "cursor",
    label: "Cursor",
    userDir: skills(".cursor"),
    projectDir: skills(".cursor"),
    readsShared: true,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    userDir: skills(".codeium", "windsurf"),
    projectDir: skills(".windsurf"),
    readsShared: true,
  },
  {
    // Cline documents only its own directories; `.agents/skills` is not
    // mentioned in its docs.
    id: "cline",
    label: "Cline",
    userDir: skills(".cline"),
    projectDir: skills(".cline"),
  },
  {
    id: "roo",
    label: "Roo Code",
    userDir: skills(".roo"),
    projectDir: skills(".roo"),
    readsShared: true,
  },
  {
    // Copilot's project directory is `.github/skills`, not a dot-directory of
    // its own. VS Code and the Copilot CLI agree on `~/.copilot/skills`.
    id: "github-copilot",
    label: "GitHub Copilot",
    userDir: skills(".copilot"),
    projectDir: skills(".github"),
    readsShared: true,
  },
  {
    // The user directory follows XDG_CONFIG_HOME in OpenCode; its skills docs
    // do not say so, so the default `~/.config/opencode` is used.
    id: "opencode",
    label: "OpenCode",
    userDir: skills(".config", "opencode"),
    projectDir: skills(".opencode"),
    readsShared: true,
  },
  {
    id: "goose",
    label: "Goose",
    userDir: skills(".agents"),
    projectDir: skills(".agents"),
    readsShared: true,
  },
  {
    id: "kiro",
    label: "Kiro",
    userDir: skills(".kiro"),
    projectDir: skills(".kiro"),
  },
];

export type InstallScope = "user" | "project";

export function findAgent(id: string): AgentProfile | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

export type ResolveRootInput = {
  agent: AgentProfile;
  scope: InstallScope;
  /** Overrides the agent's directory entirely. */
  dir?: string;
  home?: string;
  cwd?: string;
};

/** The skills directory an install writes into. */
export function resolveSkillsRoot(input: ResolveRootInput): string {
  const cwd = input.cwd ?? process.cwd();
  if (input.dir) {
    return isAbsolute(input.dir) ? input.dir : resolve(cwd, input.dir);
  }
  return input.scope === "user"
    ? join(input.home ?? homedir(), input.agent.userDir)
    : join(cwd, input.agent.projectDir);
}

export type AgentTarget = { root: string; agents: AgentProfile[] };

/**
 * The distinct directories to install into for these agents. Agents that share
 * a directory (Codex, Goose and `universal` all use `.agents/skills`) get one
 * install between them rather than the same files written three times.
 */
export function resolveTargets(input: {
  agents: readonly AgentProfile[];
  scope: InstallScope;
  dir?: string;
  home?: string;
  cwd?: string;
}): AgentTarget[] {
  const targets = new Map<string, AgentTarget>();
  for (const agent of input.agents) {
    const root = resolve(
      resolveSkillsRoot({
        agent,
        scope: input.scope,
        ...(input.dir ? { dir: input.dir } : {}),
        ...(input.home ? { home: input.home } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }),
    );
    const target = targets.get(root);
    if (target) {
      target.agents.push(agent);
    } else {
      targets.set(root, { root, agents: [agent] });
    }
  }
  return [...targets.values()];
}
