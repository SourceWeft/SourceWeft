import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

// Hiding a review is the reviews module's own function, built alongside this
// one; the queue only has to call it with the right review.
const reviews = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));
vi.mock("./reviews", () => ({
  setSkillReviewStatus: async (input: {
    reviewId: string;
    status: "visible" | "hidden";
  }) => {
    reviews.calls.push(input);
    return { reviewId: input.reviewId, skillId: "x", status: input.status };
  },
}));

/**
 * Skill reports against real PostgreSQL: who can report which skill, that a
 * report changes nothing by itself, the per-address and per-account limits,
 * the admin queue, and each admin decision with its audit event.
 *
 * Every user, workspace, skill and report here is this file's own; other
 * reports in the shared database are only ever read around, never touched.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "skill reports (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let reports: typeof import("./reports");
    const teamId = `report-team-${randomUUID()}`;
    const workspaceId = `report-ws-${randomUUID()}`;
    const skillIds = new Set<string>();
    const userIds = new Set<string>();

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      reports = await import("./reports");
      await data.db.insert(data.workspaces).values({
        id: workspaceId,
        organizationId: teamId,
        name: "Skill report tests",
        slug: randomUUID(),
      });
      // The market modules are a large import graph on a busy machine.
    }, 180_000);
    afterAll(async () => {
      if (!data) return;
      if (skillIds.size > 0) {
        // Reports, reviews, installs and events go with their skill.
        await data.db
          .delete(data.skillMarketEvents)
          .where(inArray(data.skillMarketEvents.skillId, [...skillIds]));
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, [...skillIds]));
      }
      await data.db
        .delete(data.workspaces)
        .where(eq(data.workspaces.id, workspaceId));
      for (const id of userIds)
        await data.db.execute(sql`delete from "user" where id = ${id}`);
      await data.closeDatabase();
    });

    // Hashed before use, so any unique string stands in for an address.
    const ip = () => `test-ip-${randomUUID()}`;

    async function user(name: string | null = "Report tester") {
      const id = `report-user-${randomUUID()}`;
      userIds.add(id);
      await data.db.execute(sql`
        insert into "user" (id, name, email, "emailVerified")
        values (${id}, ${name ?? ""}, ${`${id}@example.test`}, true)
      `);
      return id;
    }

    /** A registry skill with one published, current version. */
    async function registrySkill(
      input: {
        visibility?: "public" | "restricted";
        ownerUserId?: string;
      } = {},
    ) {
      const skillId = randomUUID();
      const versionId = randomUUID();
      const slug = `gh-report-${randomBytes(6).toString("hex")}`;
      skillIds.add(skillId);
      await data.db.insert(data.skillDefinitions).values({
        id: skillId,
        sourceType: "registry_github",
        slug,
        displayName: "Report fixture",
        description: "A skill somebody reports.",
        visibility: input.visibility ?? "public",
        ownerUserId: input.ownerUserId ?? null,
      });
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId,
        version: "aaaaaaaaaaaa",
        status: "published",
        storageType: "db_text",
        storagePointer: `github:report/fixture@${"a".repeat(40)}#${slug}`,
        isCurrent: true,
        contentHash: randomUUID(),
        skillMd: "---\nname: fixture\n---\nBody\n",
        publishedAt: new Date(),
        manifestJson: {
          slug,
          displayName: "Report fixture",
          description: "A skill somebody reports.",
          version: "aaaaaaaaaaaa",
          visibility: input.visibility ?? "public",
          categories: [],
          registry: {
            identifier: `gh:report/fixture/${slug}`,
            sourceUrl: "https://github.com/report/fixture",
            repoUrl: "https://github.com/report/fixture",
            submittedBy: input.ownerUserId ?? "system:test",
            committedAt: "2026-01-01T00:00:00.000Z",
            capability: "prompt-only",
            scan: { reviewRequired: false, flags: [] },
          },
        } as never,
      });
      return { skillId, versionId, slug };
    }

    async function review(skillId: string, body = "Great. ".repeat(80)) {
      const id = randomUUID();
      await data.db.insert(data.skillReviews).values({
        id,
        skillId,
        userId: await user(),
        rating: 2,
        body,
      });
      return id;
    }

    async function definition(skillId: string) {
      const [row] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, skillId));
      return row!;
    }

    async function report(id: string) {
      const [row] = await data.db
        .select()
        .from(data.skillReports)
        .where(eq(data.skillReports.id, id));
      return row!;
    }

    async function submit(
      slug: string,
      extra: Partial<Parameters<typeof reports.createSkillReport>[0]> = {},
    ) {
      const result = await reports.createSkillReport({
        slug,
        reason: "spam",
        details: "Looks copied",
        contactEmail: "visitor@example.test",
        reporterUserId: null,
        clientIp: ip(),
        ...extra,
      });
      if (!result.ok) throw new Error(`report refused: ${result.reason}`);
      return result.report.id;
    }

    test("anyone may report a public skill, and the report changes nothing", async () => {
      const skill = await registrySkill();
      const before = await definition(skill.skillId);
      const address = ip();
      const result = await reports.createSkillReport({
        slug: skill.slug,
        reason: "copyright",
        details: "This is my work",
        contactEmail: "owner@example.test",
        reporterUserId: null,
        clientIp: address,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = await report(result.report.id);
      expect(row).toMatchObject({
        skillId: skill.skillId,
        reviewId: null,
        reason: "copyright",
        details: "This is my work",
        contactEmail: "owner@example.test",
        reporterUserId: null,
        status: "open",
        ipHash: reports.hashSkillReporterIp(address),
      });
      expect(row.ipHash).not.toContain(address);
      const after = await definition(skill.skillId);
      expect({
        visibility: after.visibility,
        listingHold: after.listingHold,
        status: after.status,
      }).toEqual({
        visibility: before.visibility,
        listingHold: before.listingHold,
        status: before.status,
      });
    });

    test("a skill that is not public is reportable only by its importer or a member of a workspace that installed it", async () => {
      const importer = await user();
      const member = await user();
      const stranger = await user();
      const skill = await registrySkill({
        visibility: "restricted",
        ownerUserId: importer,
      });
      await data.db
        .insert(data.workspaceMemberships)
        .values({ workspaceId, userId: member });
      await data.db.insert(data.workspaceSkills).values({
        id: randomUUID(),
        teamId,
        workspaceId,
        skillId: skill.skillId,
        skillVersionId: skill.versionId,
      });
      const attempt = (reporterUserId: string | null) =>
        reports.createSkillReport({
          slug: skill.slug,
          reason: "broken",
          details: "",
          contactEmail: reporterUserId ? undefined : "x@example.test",
          reporterUserId,
          clientIp: ip(),
        });

      // Not there and not visible are the same answer.
      expect(await attempt(null)).toEqual({
        ok: false,
        reason: "skill_not_found",
      });
      expect(await attempt(stranger)).toEqual({
        ok: false,
        reason: "skill_not_found",
      });
      expect(
        await reports.createSkillReport({
          slug: `gh-report-missing-${randomUUID()}`,
          reason: "broken",
          details: "",
          contactEmail: "x@example.test",
          reporterUserId: null,
          clientIp: ip(),
        }),
      ).toEqual({ ok: false, reason: "skill_not_found" });
      expect((await attempt(importer)).ok).toBe(true);
      expect((await attempt(member)).ok).toBe(true);
    });

    test("an archived skill cannot be reported, and a review must be of the reported skill", async () => {
      const skill = await registrySkill();
      const other = await registrySkill();
      const otherReview = await review(other.skillId);
      expect(
        await reports.createSkillReport({
          slug: skill.slug,
          reason: "spam",
          details: "",
          contactEmail: "x@example.test",
          reviewId: otherReview,
          reporterUserId: null,
          clientIp: ip(),
        }),
      ).toEqual({ ok: false, reason: "review_not_found" });
      const ownReview = await review(skill.skillId);
      const id = await submit(skill.slug, { reviewId: ownReview });
      expect((await report(id)).reviewId).toBe(ownReview);

      await data.db
        .update(data.skillDefinitions)
        .set({ status: "archived" })
        .where(eq(data.skillDefinitions.id, skill.skillId));
      await expect(submit(skill.slug)).rejects.toThrow("skill_not_found");
    });

    test("one address, and one account, may send only so many reports", async () => {
      const skill = await registrySkill();
      const [hour] = reports.SKILL_REPORT_LIMITS;
      const address = ip();
      for (let index = 0; index < hour.max; index += 1) {
        await submit(skill.slug, { clientIp: address });
      }
      const limited = await reports.createSkillReport({
        slug: skill.slug,
        reason: "spam",
        details: "",
        contactEmail: "x@example.test",
        reporterUserId: null,
        clientIp: address,
      });
      expect(limited).toMatchObject({ ok: false, reason: "rate_limited" });
      if (!limited.ok && limited.reason === "rate_limited") {
        expect(limited.retryAfterSeconds).toBeGreaterThan(3500);
        expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
      }
      // A different address is its own bucket.
      await submit(skill.slug, { clientIp: ip() });

      // An account is limited across addresses.
      const reporter = await user();
      for (let index = 0; index < hour.max; index += 1) {
        await submit(skill.slug, {
          reporterUserId: reporter,
          contactEmail: undefined,
        });
      }
      expect(
        await reports.createSkillReport({
          slug: skill.slug,
          reason: "spam",
          details: "",
          reporterUserId: reporter,
          clientIp: ip(),
        }),
      ).toMatchObject({ ok: false, reason: "rate_limited" });

      // Reports older than the window no longer count.
      const later = new Date(Date.now() + hour.windowMs + 60_000);
      expect(
        (
          await reports.createSkillReport({
            slug: skill.slug,
            reason: "spam",
            details: "",
            contactEmail: "x@example.test",
            reporterUserId: null,
            clientIp: address,
            now: later,
          })
        ).ok,
      ).toBe(true);
    });

    test("the queue shows the skill, the review, the reporter and the other open reports", async () => {
      const skill = await registrySkill();
      const reviewId = await review(skill.skillId);
      const named = await user("Ada Reporter");
      const unnamed = await user(null);
      const anonymousId = await submit(skill.slug);
      const namedId = await submit(skill.slug, {
        reporterUserId: named,
        contactEmail: undefined,
        reviewId,
      });
      const unnamedId = await submit(skill.slug, {
        reporterUserId: unnamed,
        contactEmail: "alt@example.test",
      });

      const page = await reports.listSkillReports({
        status: "open",
        limit: 100,
      });
      const mine = new Map(
        page.items
          .filter((item) => item.skill.id === skill.skillId)
          .map((item) => [item.id, item]),
      );
      expect([...mine.keys()]).toEqual([unnamedId, namedId, anonymousId]);
      expect(mine.get(anonymousId)).toMatchObject({
        reason: "spam",
        details: "Looks copied",
        status: "open",
        review: null,
        skill: {
          slug: skill.slug,
          displayName: "Report fixture",
          visibility: "public",
          listingHold: false,
        },
        reporter: {
          userId: null,
          displayName: "anonymous",
          contactEmail: "visitor@example.test",
          accountEmail: null,
        },
        otherOpenReports: 2,
      });
      const aboutReview = mine.get(namedId)!;
      expect(aboutReview.reporter).toEqual({
        userId: named,
        displayName: "Ada Reporter",
        contactEmail: null,
        accountEmail: `${named}@example.test`,
      });
      expect(aboutReview.review).toMatchObject({
        id: reviewId,
        rating: 2,
        status: "visible",
      });
      expect(aboutReview.review!.excerpt.length).toBe(280);
      expect(mine.get(unnamedId)!.reporter.displayName).toBe(unnamed);

      // Pages follow one another without repeating an item.
      const first = await reports.listSkillReports({
        status: "open",
        limit: 1,
      });
      expect(first.nextCursor).not.toBeNull();
      const second = await reports.listSkillReports({
        status: "open",
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
      expect(Date.parse(second.items[0]!.createdAt)).toBeLessThanOrEqual(
        Date.parse(first.items[0]!.createdAt),
      );
      await expect(
        reports.listSkillReports({ status: "open", limit: 1, cursor: "%%%" }),
      ).rejects.toMatchObject({ code: "SKILL_REPORT_CURSOR_INVALID" });
    });

    async function events(skillId: string) {
      return data.db
        .select()
        .from(data.skillMarketEvents)
        .where(eq(data.skillMarketEvents.skillId, skillId));
    }

    test("dismissing closes the report, leaves the skill alone, and is audited", async () => {
      const admin = await user();
      const skill = await registrySkill();
      const id = await submit(skill.slug);
      const result = await reports.resolveSkillReport({
        reportId: id,
        action: "dismiss",
        resolution: "Not a copy",
        actorUserId: admin,
      });
      expect(result).toEqual({
        reportId: id,
        status: "dismissed",
        action: "dismiss",
        resolvedReportIds: [id],
      });
      expect(await report(id)).toMatchObject({
        status: "dismissed",
        resolution: "Not a copy",
        resolvedBy: admin,
      });
      expect((await report(id)).resolvedAt).toBeInstanceOf(Date);
      expect((await definition(skill.skillId)).visibility).toBe("public");
      expect(await events(skill.skillId)).toMatchObject([
        {
          action: "report.dismissed",
          actorKind: "admin",
          actorUserId: admin,
          detail: { reportId: id, action: "dismiss", reason: "spam" },
        },
      ]);

      // Decided once.
      await expect(
        reports.resolveSkillReport({
          reportId: id,
          action: "none",
          actorUserId: admin,
        }),
      ).rejects.toMatchObject({ code: "SKILL_REPORT_ALREADY_RESOLVED" });
      expect(
        await reports.resolveSkillReport({
          reportId: randomUUID(),
          action: "dismiss",
          actorUserId: admin,
        }),
      ).toBeNull();
    });

    test("withdrawing takes the skill off the market and can close the other reports on it", async () => {
      const admin = await user();
      const skill = await registrySkill();
      const reviewId = await review(skill.skillId);
      const first = await submit(skill.slug);
      const second = await submit(skill.slug, { reason: "malicious" });
      const aboutReview = await submit(skill.slug, { reviewId });

      const result = await reports.resolveSkillReport({
        reportId: first,
        action: "withdraw_skill",
        resolution: "Confirmed",
        alsoResolveSameTarget: true,
        actorUserId: admin,
      });
      expect(result?.status).toBe("actioned");
      expect(result?.resolvedReportIds).toEqual([first, second]);
      const after = await definition(skill.skillId);
      expect(after).toMatchObject({
        visibility: "restricted",
        listingHold: true,
        listingHoldBy: "admin",
      });
      expect(await report(second)).toMatchObject({
        status: "actioned",
        resolution: "Confirmed",
      });
      // A report about a review is a different target.
      expect((await report(aboutReview)).status).toBe("open");
      const [event] = (await events(skill.skillId)).filter(
        (row) => row.action === "report.actioned",
      );
      expect(event?.detail).toMatchObject({
        reportId: first,
        action: "withdraw_skill",
        alsoResolved: [second],
      });
    });

    test("revoking takes down the current version; with none left the report stays open", async () => {
      const admin = await user();
      const skill = await registrySkill();
      const id = await submit(skill.slug, { reason: "malicious" });
      const later = await submit(skill.slug, { reason: "malicious" });
      await reports.resolveSkillReport({
        reportId: id,
        action: "revoke_version",
        actorUserId: admin,
      });
      const [version] = await data.db
        .select()
        .from(data.skillVersions)
        .where(eq(data.skillVersions.id, skill.versionId));
      expect(version).toMatchObject({ status: "deprecated", isCurrent: false });
      expect((await report(id)).status).toBe("actioned");
      expect(
        (await events(skill.skillId)).find(
          (row) => row.action === "report.actioned",
        )?.detail,
      ).toMatchObject({
        action: "revoke_version",
        skillVersionId: skill.versionId,
      });

      await expect(
        reports.resolveSkillReport({
          reportId: later,
          action: "revoke_version",
          actorUserId: admin,
        }),
      ).rejects.toMatchObject({ code: "SKILL_REPORT_TARGET_GONE" });
      expect((await report(later)).status).toBe("open");
    });

    test("hiding a review goes through the reviews module; only a review report can", async () => {
      const admin = await user();
      const skill = await registrySkill();
      const reviewId = await review(skill.skillId);
      const aboutSkill = await submit(skill.slug);
      await expect(
        reports.resolveSkillReport({
          reportId: aboutSkill,
          action: "hide_review",
          actorUserId: admin,
        }),
      ).rejects.toMatchObject({ code: "SKILL_REPORT_NOT_ABOUT_A_REVIEW" });
      expect((await report(aboutSkill)).status).toBe("open");

      const aboutReview = await submit(skill.slug, { reviewId });
      reviews.calls.length = 0;
      await reports.resolveSkillReport({
        reportId: aboutReview,
        action: "hide_review",
        resolution: "Abusive",
        actorUserId: admin,
      });
      expect(reviews.calls).toEqual([
        { reviewId, status: "hidden", actorUserId: admin, reason: "Abusive" },
      ]);
      expect(
        await data.db
          .select({ status: data.skillReports.status })
          .from(data.skillReports)
          .where(
            and(
              eq(data.skillReports.skillId, skill.skillId),
              eq(data.skillReports.status, "open"),
            ),
          ),
      ).toHaveLength(1);
    });
  },
);
