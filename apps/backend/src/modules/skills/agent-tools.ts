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
        "If one of these is already installed and the user wants it turned on, call enable_skill with its slug. Otherwise install it with install_skill.",
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
    async ({ source, skill }: { source: string; skill?: string }) => {
      try {
        const { skills } = await contentSkillsService.installSkill({
          teamId: context.teamId,
          workspaceId: context.workspaceId,
          userId: context.userId,
          source,
          ...(skill ? { skill } : {}),
        });

        const lines: string[] = [];
        const installed = skills.filter((item) => item.status === "indexed");
        const queued = skills.filter((item) => item.status === "queued");
        const withScripts = installed.filter(
          (item) => item.capability === "executable",
        );

        if (installed.length > 0) {
          lines.push(
            `Installed ${installed.length} skill(s), all switched OFF:`,
            ...installed.map(describe),
            "",
            "Skills from a third-party repository do not switch themselves on: enabling one puts its author's instructions into every later turn. Ask the user which of these they want, then call enable_skill for each. Do not enable anything they did not ask for.",
          );
        }
        if (withScripts.length > 0) {
          lines.push(
            "",
            `Of those, ${withScripts.length} also ship executable scripts, so enabling them additionally makes that code runnable: ${withScripts
              .map((item) => item.slug)
              .join(", ")}. Say so when you offer them.`,
          );
        }
        if (queued.length > 0) {
          lines.push(
            "",
            `${queued.length} skill(s) were indexed but held for review, so they cannot be enabled at all yet:`,
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
        "Install skills from a repository into this workspace. `source` accepts a GitHub URL (optionally deep-linked to one skill's directory), the `owner/repo` shorthand, or the slug of a skill already in the catalog. A repository that is not indexed yet is fetched and indexed first. By default every skill it ships is installed; pass `skill` to install just one when the user named a specific capability. Everything installs switched OFF — use enable_skill afterwards for the ones the user wants. If the skill is already installed and the user simply wants it turned on, call enable_skill directly instead of installing again.",
      schema: z.object({
        skill: z
          .string()
          .optional()
          .describe(
            "Install only the skill with this name (the author's name, e.g. 'pdf'), instead of everything the repository ships. Use it whenever the user named one capability rather than asking for the whole repo.",
          ),
        source: z
          .string()
          .min(1)
          .describe(
            "A GitHub URL, an `owner/repo` shorthand, or a catalog slug.",
          ),
      }),
    },
  );

  const enableSkill = tool(
    async ({ slug }: { slug: string }) => {
      try {
        const { skill, alreadyEnabled } =
          await contentSkillsService.enableWorkspaceSkillBySlug({
            teamId: context.teamId,
            workspaceId: context.workspaceId,
            userId: context.userId,
            slug,
          });
        if (alreadyEnabled) {
          return `${skill.slug} is already enabled.`;
        }
        return [
          `Enabled ${skill.slug} — ${skill.displayName}.`,
          skill.registryCapability === "executable"
            ? "It ships executable scripts, which can now run in the sandbox."
            : "",
          "It takes effect on your NEXT turn; this turn's skill set was fixed before you started.",
        ]
          .filter(Boolean)
          .join(" ");
      } catch (error) {
        if (error instanceof ContentError) {
          logger.info("Agent skill enable rejected", {
            slug,
            workspaceId: context.workspaceId,
            code: error.code,
          });
          return `Could not enable '${slug}': ${error.message}`;
        }
        throw error;
      }
    },
    {
      name: "enable_skill",
      description:
        "Switch on a skill that is installed in this workspace but currently off. Installed skills start off, so this is what makes one usable. Call it ONLY when the user has asked for that skill to be turned on or to be used — never on your own initiative to complete a task, because enabling accepts a third party's instructions, and their scripts, into this workspace.",
      schema: z.object({
        slug: z
          .string()
          .min(1)
          .describe(
            "The skill's catalog slug, or the author's name for it (e.g. 'pdf').",
          ),
      }),
    },
  );

  return [searchSkills, installSkill, enableSkill];
}

/**
 * Human approval for `enable_skill`, merged into the turn's `interruptOn`.
 *
 * Enabling is the moment a person accepts a third party's instructions — and,
 * for an `executable` skill, their code — into the agent. Leaving that to the
 * model alone would make "installed off by default" a speed bump rather than a
 * decision: a model finishing a task is precisely the actor that would flip it
 * on as a means to an end, and a skill's own description is untrusted text that
 * can ask for exactly that. The prompt puts the choice back on the person, with
 * the skill named.
 */
export function createSkillToolInterruptConfigs() {
  return {
    enable_skill: {
      allowedDecisions: ["approve", "reject"] as Array<
        "approve" | "edit" | "reject"
      >,
      description:
        "Enable a third-party skill in this workspace. Its instructions will reach the agent on every turn, and if it ships scripts, those become runnable.",
    },
  };
}
