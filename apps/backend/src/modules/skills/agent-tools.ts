import { tool } from "langchain";
import { z } from "zod";
import type { AgentTurnTool } from "../threads/agent/capability-tools/types";
import { ContentError } from "../content/errors";
import { contentSkillsService } from "./service";
import { resolveSelectedSkills } from "./selection";
import type { EnabledSkillDescriptor } from "./types";
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
 * A turn's skill set is written into the checkpoint before the model runs, so
 * the available-skills list in the prompt is fixed for the current turn. What
 * is NOT fixed is the /skills mount: `mountSkill` adds a freshly installed
 * skill to it, so the tool result can hand the model the path to read and the
 * skill is usable in the same breath — the alternative (OpenHands' banner
 * telling the user to start over; our earlier "takes effect next turn") reads
 * as a bug to the person who just asked for the thing. Scripts follow when the
 * turn can stage them: `mountSkill` also registers the bundle with the turn's
 * sandbox, which stages it the first time a command references /skills, and
 * reports back whether that is possible. The sandbox prompt of a turn that
 * started without skills still forbids /skills in execute (it is kept
 * byte-identical on purpose), so the result is what tells the model the paths
 * are runnable. Where staging is not possible — no sandbox this turn, a bundle
 * over the staging caps — the scripts wait for the next turn, and the result
 * says so.
 */

export type SkillAgentToolContext = {
  teamId: string;
  workspaceId: string;
  userId: string;
  /**
   * Adds a skill to this turn's /skills mount. Absent → next-turn only.
   * `scriptsStageable` says whether the turn's sandbox can still stage the
   * skill's bundle, i.e. whether its scripts are runnable before the next turn.
   */
  mountSkill?: (skill: EnabledSkillDescriptor) => { scriptsStageable: boolean };
};

type MountedSkill = { path: string; scriptsStageable: boolean };

/**
 * Mount what was just installed into the running turn; returns the slugs that
 * are now readable. Best effort — a failure here must not turn a successful
 * install into an error, it only means the skill waits for the next turn.
 */
async function mountInstalledSkills(
  context: SkillAgentToolContext,
  workspaceSkillIds: string[],
): Promise<Map<string, MountedSkill>> {
  const mounted = new Map<string, MountedSkill>();
  if (!context.mountSkill || workspaceSkillIds.length === 0) {
    return mounted;
  }
  try {
    const wanted = new Set(workspaceSkillIds);
    // Resolves every enabled skill; the ones already mounted are skipped.
    const skills = await resolveSelectedSkills({
      teamId: context.teamId,
      workspaceId: context.workspaceId,
      skillIds: [],
    });
    for (const skill of skills) {
      if (wanted.has(skill.workspaceSkillId)) {
        const { scriptsStageable } = context.mountSkill(skill);
        mounted.set(skill.workspaceSkillId, {
          path: `/skills/${skill.name}/SKILL.md`,
          scriptsStageable,
        });
      }
    }
  } catch (error) {
    logger.warn("Could not mount installed skill into the running turn", {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return mounted;
}

/**
 * Provenance the model needs to make, or advise on, a judgement.
 *
 * A slug and a description say what a skill claims to do; they say nothing
 * about who wrote it or under what terms. LobeHub's agent-facing skill page
 * leads with exactly this — author, version, license, rating, install count —
 * because an agent asked to install something arbitrary has otherwise no basis
 * to tell a maintained MIT library from an unlicensed stranger. We have no
 * ratings to report, but publisher, license, review state and the pinned source
 * URL we already compute for the catalog, and were simply not passing on.
 */
function provenanceOf(input: {
  sourceType?: string;
  license?: string | null;
  flagged?: boolean;
  verified?: boolean;
  sourceUrl?: string | null;
}): string {
  if (input.sourceType && input.sourceType !== "registry_github") {
    return `  [${
      input.sourceType === "builtin"
        ? "built-in, first-party"
        : input.sourceType === "team_custom"
          ? "written by this team"
          : "written in this workspace"
    }]`;
  }
  const parts = [
    // Saying it out loud is the point: a registry skill is third-party text.
    input.verified ? "verified" : "community, unverified",
    `license: ${input.license ?? "none declared"}`,
  ];
  if (input.flagged) {
    parts.push("FLAGGED by the safety scan");
  }
  if (input.sourceUrl) {
    parts.push(input.sourceUrl);
  }
  return `  [${parts.join(" · ")}]`;
}

function describe(input: {
  slug: string;
  displayName: string;
  description: string;
  sourceType?: string;
  license?: string | null;
  flagged?: boolean;
  verified?: boolean;
  sourceUrl?: string | null;
}): string {
  return `- ${input.slug} — ${input.displayName}: ${input.description}\n${provenanceOf(input)}`;
}

export function buildSkillAgentTools(
  context: SkillAgentToolContext,
): AgentTurnTool[] {
  const searchSkills = tool(
    async ({ query }: { query: string }) => {
      const { items, total } = await contentSkillsService.searchCatalog({
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        query,
      });
      if (items.length === 0) {
        // An empty result is where a model gives up or wanders off, so say what
        // to do next (LobeHub's skill store spells out the same two rules).
        return [
          `No skills match "${query}".`,
          "Matching is textual: retry ONCE with a single short keyword — the core noun, in English and in the user's language — before concluding nothing fits.",
          "If the user gave you a skill slug, a SourceWeft skill link or a GitHub repository, do not search: pass it to install_skill. Otherwise, with nothing suitable here, answer normally.",
        ].join(" ");
      }
      return [
        total > items.length
          ? `${total} skills match "${query}"; the best ${items.length}:`
          : `${items.length} skill(s) match "${query}":`,
        ...items.map((item, index) =>
          [
            `${index + 1}. ${item.slug} — ${item.displayName}: ${item.description}`,
            `${provenanceOf({
              sourceType: item.sourceType,
              license: item.license,
              flagged: item.flagged,
              verified: item.verified,
              sourceUrl: item.sourceUrl,
            })}${item.installCount > 0 ? ` · on in ${item.installCount} workspace(s)` : ""}${item.enabled ? " · ALREADY installed and on here" : ""}${item.installable === false ? " · HELD for review — cannot be installed yet" : ""}`,
          ].join("\n"),
        ),
        "",
        "Results are ordered best match first; among equals, built-in before this workspace's own before community, then by adoption. To use one, call install_skill with its slug (it also switches it on). If it is already on here, it is in your available skills — just use it.",
      ].join("\n");
    },
    {
      name: "search_skills",
      description:
        "Search this workspace's skill catalog — its own and its team's skills, the opt-in built-ins, and public community skills. Each result gives the slug to install, what the skill does, where it comes from (for a community skill: publisher, license, scan state, source URL) and how many workspaces keep it on. It searches this catalog only, never GitHub or the web.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "One or two short keywords for the capability, e.g. 'pdf', 'code review', 'feynman'. Short beats descriptive: every word is matched separately.",
          ),
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
          ref: { kind: "source", source, ...(skill ? { skill } : {}) },
          installedVia: "agent",
        });

        const lines: string[] = [];
        const already = skills.filter(
          (item) => item.status === "already_installed",
        );
        // Mounted too: a skill switched on by an earlier call this turn is
        // "already installed" and still not in this turn's starting set.
        const installed = skills.filter((item) => item.status !== "queued");
        const queued = skills.filter((item) => item.status === "queued");
        const withScripts = installed.filter(
          (item) =>
            item.capability === "executable" &&
            item.status !== "already_installed",
        );

        const mounted = await mountInstalledSkills(
          context,
          installed.flatMap((item) =>
            item.workspaceSkill ? [item.workspaceSkill.id] : [],
          ),
        );
        if (installed.length > 0) {
          lines.push(
            already.length === installed.length
              ? `Already installed and on — nothing changed (${installed.length} skill(s)):`
              : `Installed and switched on ${installed.length - already.length} skill(s)${already.length > 0 ? ` (${already.length} more were already on)` : ""}:`,
            ...installed.map((item) => {
              const path = item.workspaceSkill
                ? mounted.get(item.workspaceSkill.id)?.path
                : undefined;
              return `${describe(item)}${path ? `\n  [read now: ${path}]` : ""}`;
            }),
            "",
            mounted.size === installed.length
              ? "They are usable in THIS turn: before acting on one, read its SKILL.md at the path shown and follow it. They are not in your available-skills list until the next turn, so go by these paths. Tell the user what you installed and where it came from."
              : "They take effect on your NEXT turn; this turn's skill set was fixed before you started. Tell the user what you installed and where it came from.",
          );
        }
        const runnableNow = withScripts.filter(
          (item) =>
            item.workspaceSkill &&
            mounted.get(item.workspaceSkill.id)?.scriptsStageable === true,
        );
        const runnableNextTurn = withScripts.filter(
          (item) => !runnableNow.includes(item),
        );
        if (runnableNow.length > 0) {
          // Spelled out because a turn that started without skills was told,
          // in its sandbox rules, never to put /skills in an execute command.
          lines.push(
            "",
            `${runnableNow.length} ship executable scripts that are runnable in THIS turn: ${runnableNow
              .map(
                (item) =>
                  `${item.slug} (${mounted
                    .get(item.workspaceSkill!.id)!
                    .path.replace(/SKILL\.md$/u, "")}…)`,
              )
              .join(
                ", ",
              )}. Their scripts are staged on first use this turn; run them with execute from those /skills paths exactly as the SKILL.md says (for example python3 /skills/<name>/scripts/tool.py) — for these paths this replaces any earlier rule against /skills in execute commands. Never write to /skills. If such a command fails with SANDBOX_SKILL_STAGING_UNAVAILABLE, the scripts could not be staged: keep following the instructions and say the scripts will be runnable from the NEXT turn.`,
          );
        }
        if (runnableNextTurn.length > 0) {
          lines.push(
            "",
            `Of those, ${runnableNextTurn.length} ship executable scripts: ${runnableNextTurn
              .map((item) => item.slug)
              .join(", ")}. Their instructions apply now, but the scripts are staged into the sandbox when a turn starts, so they become runnable from the NEXT turn. Say so.`,
          );
        }
        if (queued.length > 0) {
          lines.push(
            ...(lines.length > 0 ? [""] : []),
            `${queued.length} skill(s) were indexed but held for review by the safety scan, so they are not installed:`,
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
        "Install a skill into this workspace and switch it on, then use it in this same turn. `source` is a slug from search_skills, the author's short name for a skill, a link to this SourceWeft deployment's skill page, a GitHub URL (optionally deep-linked to one skill's directory) or `owner/repo`. When you already hold one of these, call this directly — do not search first. A GitHub repository not in the catalog yet is fetched, scanned and indexed first; every skill it ships is installed unless you pass `skill`. The result tells you which SKILL.md to read; anything the safety scan held for review is reported and not installed. Links to other sites are refused — ask for the GitHub repository instead.",
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
            "A catalog slug or short name, a SourceWeft skill page link, a GitHub URL, or an `owner/repo` shorthand.",
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
        "Switch back on a skill that is installed in this workspace but was switched off. Installing already enables, so a skill that is off was turned off by someone on purpose — call this ONLY when the user asks for that skill to be turned on again, never on your own initiative to complete a task.",
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
 * Installing enables, so the only skill this tool can act on is one a person
 * deliberately switched off. Undoing that is theirs to confirm: a model
 * finishing a task is precisely the actor that would flip it back on as a means
 * to an end, and a skill's own description is untrusted text that can ask for
 * exactly that. `install_skill` carries no such prompt — what the catalog
 * offers a workspace is gated at ingest and by visibility, not per install.
 */
export function createSkillToolInterruptConfigs() {
  return {
    enable_skill: {
      allowedDecisions: ["approve", "reject"] as Array<
        "approve" | "edit" | "reject"
      >,
      // Named per skill at prompt time, so the person knows which one they are
      // agreeing to switch back on.
      description: async (call: {
        args?: Record<string, unknown>;
      }): Promise<string> => {
        const slug =
          typeof call.args?.slug === "string" ? call.args.slug : "this skill";
        return [
          `Switch '${slug}' back on in this workspace?`,
          "It is installed but was switched off.",
          "Once on, its instructions reach the assistant on every turn, and any scripts it ships become runnable in the sandbox.",
        ].join(" ");
      },
    },
  };
}
