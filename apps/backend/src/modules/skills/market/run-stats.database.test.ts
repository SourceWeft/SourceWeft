import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  loadSkillDatabase,
  skillDatabaseEnabled,
} from "../../../test/skill-database";

/**
 * Sandbox run statistics against real PostgreSQL: that only registry skills
 * are recorded, that the 30-day aggregate counts runs, successes, workspaces
 * and the top errors, that the public answer holds back below its floor, that
 * a skill with no recent run loses its stats row, and that old events are
 * pruned. Every skill here is this file's own; the refresh itself is the
 * scheduler's global pass and only ever makes stats rows truer.
 */
describe.skipIf(!skillDatabaseEnabled)(
  "skill run stats (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let runStats: typeof import("./run-stats");
    const tag = randomUUID().slice(0, 8);
    const skillIds: string[] = [];

    beforeAll(async () => {
      data = await loadSkillDatabase();
      runStats = await import("./run-stats");
      // The module graph behind the sandbox package is slow to load cold.
    }, 120_000);
    afterAll(async () => {
      if (!data) return;
      // Events and stats cascade with their skill.
      if (skillIds.length > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, skillIds));
      await data.closeDatabase();
    });

    async function newSkill(input: {
      sourceType?: "registry_github" | "builtin";
      visibility?: "public" | "restricted";
    }) {
      const id = `runstats-${tag}-${randomUUID()}`;
      const versionId = randomUUID();
      const slug = `runstats-${tag}-${skillIds.length}`;
      skillIds.push(id);
      const registry =
        (input.sourceType ?? "registry_github") === "registry_github";
      await data.db.insert(data.skillDefinitions).values({
        id,
        sourceType: input.sourceType ?? "registry_github",
        slug,
        displayName: `Run stats ${slug}`,
        description: "fixture",
        visibility: input.visibility ?? "public",
        status: "active",
        ownerUserId: "runstats-owner",
        ...(registry
          ? {
              repoOwner: `runstats-${tag}`,
              repoName: `repo-${skillIds.length}`,
            }
          : {}),
      });
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId: id,
        version: "1.0.0",
        status: "published",
        storageType: "db_text",
        storagePointer: `db:${versionId}`,
        skillMd: "---\nname: x\n---\nBody\n",
        isCurrent: true,
        contentHash: "hash",
        publishedAt: new Date(),
        manifestJson: {
          slug,
          displayName: slug,
          version: "1.0.0",
          description: "fixture",
          visibility: input.visibility ?? "public",
          categories: [],
        } as never,
      });
      return { id, versionId, slug };
    }

    function daysAgo(days: number) {
      return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }

    async function insertEvents(
      skill: { id: string; versionId: string },
      events: Array<{
        workspace: string;
        errorClass?: "missing_dependency" | "timeout" | "permission" | "other";
        subject?: string;
        at?: Date;
      }>,
    ) {
      await data.db.insert(data.skillRunEvents).values(
        events.map((event) => ({
          id: randomUUID(),
          skillId: skill.id,
          skillVersionId: skill.versionId,
          workspaceHash: runStats.skillRunWorkspaceHash(
            `${tag}-${event.workspace}`,
          ),
          exitCode: event.errorClass ? 1 : 0,
          durationMs: 10,
          errorClass: event.errorClass ?? null,
          errorSubject: event.subject ?? null,
          createdAt: event.at ?? new Date(),
        })),
      );
    }

    async function statsOf(skillId: string) {
      const [row] = await data.db
        .select()
        .from(data.skillRunStats)
        .where(eq(data.skillRunStats.skillId, skillId));
      return row ?? null;
    }

    async function eventsOf(skillId: string) {
      return data.db
        .select()
        .from(data.skillRunEvents)
        .where(eq(data.skillRunEvents.skillId, skillId));
    }

    test("records registry skills only, with a keyed workspace hash", async () => {
      const registry = await newSkill({});
      const builtin = await newSkill({
        sourceType: "builtin",
        visibility: "restricted",
      });
      const written = await runStats.recordSkillRuns({
        workspaceId: `${tag}-ws-a`,
        skillVersionIds: [registry.versionId, builtin.versionId, "missing"],
        exitCode: 1,
        durationMs: 42.4,
        classification: {
          errorClass: "missing_dependency",
          errorSubject: "pptx",
        },
      });
      expect(written).toBe(1);
      const [event] = await eventsOf(registry.id);
      expect(event).toMatchObject({
        skillVersionId: registry.versionId,
        exitCode: 1,
        durationMs: 42,
        errorClass: "missing_dependency",
        errorSubject: "pptx",
      });
      expect(event!.workspaceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(event!.workspaceHash).not.toContain(`${tag}-ws-a`);
      expect(event!.workspaceHash).toBe(
        runStats.skillRunWorkspaceHash(`${tag}-ws-a`),
      );
      expect(await eventsOf(builtin.id)).toHaveLength(0);

      // A subject is only ever kept for a missing dependency.
      await runStats.recordSkillRuns({
        workspaceId: `${tag}-ws-a`,
        skillVersionIds: [registry.versionId],
        exitCode: 1,
        durationMs: 1,
        classification: { errorClass: "other", errorSubject: "stray" },
      });
      expect(
        (await eventsOf(registry.id)).find((row) => row.errorClass === "other")
          ?.errorSubject,
      ).toBeNull();
    });

    test("aggregates 30 days, holds back below the floor, clears and prunes", async () => {
      const popular = await newSkill({});
      const sparse = await newSkill({});
      const stale = await newSkill({});

      // 12 runs in the window from 4 workspaces: 7 ok, 3 missing pptx, 1
      // missing sharp, 1 timeout. Plus one 40-day-old failure the window
      // ignores and one 100-day-old event the prune removes.
      await insertEvents(popular, [
        ...Array.from({ length: 7 }, (_, i) => ({ workspace: `w${i % 4}` })),
        ...Array.from({ length: 3 }, () => ({
          workspace: "w1",
          errorClass: "missing_dependency" as const,
          subject: "pptx",
        })),
        {
          workspace: "w2",
          errorClass: "missing_dependency",
          subject: "sharp",
        },
        { workspace: "w3", errorClass: "timeout" },
        { workspace: "w9", errorClass: "permission", at: daysAgo(40) },
        { workspace: "w9", at: daysAgo(100) },
      ]);
      // Many runs, two workspaces: never public.
      await insertEvents(
        sparse,
        Array.from({ length: 20 }, (_, i) => ({ workspace: `s${i % 2}` })),
      );
      // Only runs outside the window, and a stats row left from before.
      await insertEvents(stale, [{ workspace: "x", at: daysAgo(45) }]);
      await data.db.insert(data.skillRunStats).values({
        skillId: stale.id,
        runs: 99,
        successes: 99,
        workspaces: 9,
      });

      const result = await runStats.refreshSkillRunStats();
      expect(result.skills).toBeGreaterThanOrEqual(2);
      expect(result.cleared).toBeGreaterThanOrEqual(1);
      expect(result.pruned).toBeGreaterThanOrEqual(1);

      const stats = await statsOf(popular.id);
      expect(stats).toMatchObject({ runs: 12, successes: 7, workspaces: 4 });
      expect(stats!.topErrors).toEqual([
        { errorClass: "missing_dependency", subject: "pptx", count: 3 },
        { errorClass: "missing_dependency", subject: "sharp", count: 1 },
        { errorClass: "timeout", subject: null, count: 1 },
      ]);
      expect(await statsOf(stale.id)).toBeNull();

      // Pruned past 90 days; the 40-day-old event is kept.
      const events = await eventsOf(popular.id);
      expect(events).toHaveLength(13);
      expect(
        events.every(
          (event) => event.createdAt.getTime() > daysAgo(90).getTime(),
        ),
      ).toBe(true);
      expect(await eventsOf(stale.id)).toHaveLength(1);

      expect(await runStats.getPublicSkillRunStats(popular.id)).toEqual({
        available: true,
        runs: 12,
        successRate: 7 / 12,
        workspaces: 4,
        topErrors: stats!.topErrors,
        windowDays: 30,
      });
      expect(await runStats.getPublicSkillRunStats(sparse.id)).toEqual({
        available: false,
      });
      expect(await runStats.getFullSkillRunStats(sparse.id)).toMatchObject({
        runs: 20,
        successes: 20,
        successRate: 1,
        workspaces: 2,
        publiclyVisible: false,
      });

      // Idempotent: a second pass computes the same numbers.
      await runStats.refreshSkillRunStats();
      expect(await statsOf(popular.id)).toMatchObject({
        runs: 12,
        successes: 7,
        workspaces: 4,
      });
    });

    test("top errors keep the five most common", async () => {
      const skill = await newSkill({});
      await insertEvents(
        skill,
        ["a", "b", "c", "d", "e", "f", "g"].flatMap((subject, index) =>
          Array.from({ length: 7 - index }, () => ({
            workspace: "w",
            errorClass: "missing_dependency" as const,
            subject,
          })),
        ),
      );
      await runStats.refreshSkillRunStats();
      const stats = await statsOf(skill.id);
      expect(
        stats!.topErrors.map((error) => [error.subject, error.count]),
      ).toEqual([
        ["a", 7],
        ["b", 6],
        ["c", 5],
        ["d", 4],
        ["e", 3],
      ]);
    });

    test("finds the skill a slug or id names, and whether it is public", async () => {
      const listed = await newSkill({});
      const unlisted = await newSkill({ visibility: "restricted" });
      const builtin = await newSkill({
        sourceType: "builtin",
        visibility: "public",
      });
      expect(await runStats.findRunStatsSkill({ slug: listed.slug })).toEqual({
        id: listed.id,
        isPublic: true,
      });
      expect(
        await runStats.findRunStatsSkill({ skillId: unlisted.id }),
      ).toEqual({ id: unlisted.id, isPublic: false });
      expect(
        await runStats.findRunStatsSkill({ slug: builtin.slug }),
      ).toBeNull();
      expect(
        await runStats.findRunStatsSkill({ slug: `nothing-${tag}` }),
      ).toBeNull();
    });
  },
);
