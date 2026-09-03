import { tool } from "langchain";
import { z } from "zod";
import type { AgentTurnTool } from "../threads/agent/capability-tools/types";
import { ContentError } from "../content/errors";
import { contentSkillsService } from "./service";
import { RegistrySubmissionError } from "./registry/errors";
import { logger } from "../../shared/logger";

/**
 * Skill discovery and installation as agent tools.
 *
 * Without these the catalog is reachable only through the UI, so "find me
 * something that can turn these notes into a deck" is a dead end mid-turn. The
 * pair mirrors what the rest of the ecosystem exposes — LobeHub's
 * `lh skill install <source>`, Continue's `readSkill` — with the CLI
 * indirection dropped, since we already are a tool-calling agent.
 *
 * A skill installed here takes effect on the NEXT turn: the turn's skill set is
 * written into the checkpoint before the model runs, so the /skills mount and
 * the available-skills list are fixed for the current turn. The tool result
 * says so explicitly, because the alternative — the model installing a skill
 * and then confidently trying to use it in the same breath — reads as a bug to
 * the user. (OpenHands hit the same wall and answers it with a banner telling
 * the user to start a new conversation; ours is one turn, not one thread.)
 */

export type SkillAgentToolContext = {
  teamId: string;
  workspaceId: string;
  userId: string;
};

function describe(input: {
  slug: string;
  displayName: string;
  description: string;
}): string {
  return `- ${input.slug} — ${input.displayName}: ${input.description}`;
}

export function buildSkillAgentTools(
  context: SkillAgentToolContext,
): AgentTurnTool[] {
  const searchSkills = tool(
    async ({ query }: { query: string }) => {
      const { items } = await contentSkillsService.searchRegistry({
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        query,
      });
      if (items.length === 0) {
        return `No skills match "${query}". Only skills already indexed in this deployment's catalog are searchable; to add a new one, call install_skill with its GitHub URL or owner/repo.`;
      }
      return [
        `${items.length} skill(s) matching "${query}":`,
        ...items.map((item) =>
          describe({
            slug: item.slug,
            displayName: item.displayName,
            description: item.description,
          }),
        ),
        "",
        "Install one by passing its slug to install_skill.",
      ].join("\n");
    },
    {
      name: "search_skills",
      description:
        "Search the skill catalog for skills already indexed in this deployment. Returns each match's slug, name and description. Use it when the user asks what skills exist, or before installing, to see whether a suitable skill is already available. It does NOT search GitHub — to add a skill that is not indexed yet, call install_skill with its repository URL.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe("What the skill should do, e.g. 'pdf' or 'code review'."),
      }),
    },
  );

  const installSkill = tool(
    async ({ source }: { source: string }) => {
      try {
        const { skills } = await contentSkillsService.installSkill({
          teamId: context.teamId,
          workspaceId: context.workspaceId,
          userId: context.userId,
          source,
        });

        const lines: string[] = [];
        const ready = skills.filter((skill) => skill.enabled);
        const needsEnabling = skills.filter(
          (skill) => !skill.enabled && skill.status === "indexed",
        );
        const queued = skills.filter((skill) => skill.status === "queued");

        if (ready.length > 0) {
          lines.push(
            `Installed and enabled ${ready.length} skill(s):`,
            ...ready.map(describe),
            "",
            "These become available on your NEXT turn — this turn's skill set was fixed before you started. Tell the user they are installed; do not try to read or use them yet.",
          );
        }
        if (needsEnabling.length > 0) {
          lines.push(
            `${needsEnabling.length} skill(s) ship executable scripts, so they were installed but left DISABLED:`,
            ...needsEnabling.map(describe),
            "",
            "Running third-party code is the user's call, not yours. Tell them these are installed and that enabling them in workspace skill settings will let their scripts run.",
          );
        }
        if (queued.length > 0) {
          lines.push(
            `${queued.length} skill(s) were indexed but held for review, so they cannot be used yet:`,
            ...queued.map(describe),
          );
        }
        return lines.join("\n");
      } catch (error) {
        if (
          error instanceof RegistrySubmissionError ||
          error instanceof ContentError
        ) {
          logger.info("Agent skill install rejected", {
            source,
            workspaceId: context.workspaceId,
            code: error.code,
          });
          return `Could not install '${source}': ${error.message}`;
        }
        throw error;
      }
    },
    {
      name: "install_skill",
      description:
        "Install a skill into this workspace so it is available from the next turn onward. `source` accepts a GitHub URL (optionally deep-linked to one skill's directory), the `owner/repo` shorthand, or the slug of a skill already in the catalog. A repository that is not indexed yet is fetched and indexed first, and a repo shipping several skills installs all of them. Skills that ship executable scripts install disabled and need the user to enable them.",
      schema: z.object({
        source: z
          .string()
          .min(1)
          .describe(
            "A GitHub URL, an `owner/repo` shorthand, or a catalog slug.",
          ),
      }),
    },
  );

  return [searchSkills, installSkill];
}
