import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  loadSkillDatabase,
  skillDatabaseEnabled,
} from "../../../test/skill-database";

/**
 * Ratings and reviews against real PostgreSQL: who may review (someone in a
 * workspace that installed the skill), one editable review per person, what
 * hiding does to the page and the counts, the aggregate copies on
 * `skill_definitions`, and who may answer a review.
 *
 * Every organization, workspace, user and skill here is this file's own, and
 * only those are cleaned up.
 */
describe.skipIf(!skillDatabaseEnabled)(
  "skill reviews (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let reviews: typeof import("./reviews");
    const tag = randomBytes(5).toString("hex");
    const orgId = `review-org-${tag}`;
    const defaultWorkspaceId = `review-ws-default-${tag}`;
    const projectWorkspaceId = `review-ws-project-${tag}`;
    const skillIds = new Set<string>();
    const userIds = new Set<string>();
    const repoOwner = `review-${tag}`;

    beforeAll(async () => {
      data = await loadSkillDatabase();
      reviews = await import("./reviews");
      await data.db.execute(sql`
        insert into organization (id, name, slug, "createdAt")
        values (${orgId}, 'Review tests', ${orgId}, now())
      `);
      await data.db.insert(data.workspaces).values([
        {
          id: defaultWorkspaceId,
          organizationId: orgId,
          name: "Default",
          slug: `default-${tag}`,
          isDefault: true,
        },
        {
          id: projectWorkspaceId,
          organizationId: orgId,
          name: "Project",
          slug: `project-${tag}`,
        },
      ]);
    });
    afterAll(async () => {
      if (!data) return;
      if (skillIds.size > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, [...skillIds]));
      await data.db
        .delete(data.skillRepoClaims)
        .where(eq(data.skillRepoClaims.repoOwner, repoOwner));
      await data.db
        .delete(data.workspaces)
        .where(
          inArray(data.workspaces.id, [defaultWorkspaceId, projectWorkspaceId]),
        );
      await data.db.execute(sql`delete from organization where id = ${orgId}`);
      for (const id of userIds)
        await data.db.execute(sql`delete from "user" where id = ${id}`);
      await data.closeDatabase();
    });

    async function user(
      input: {
        member?: boolean;
        guestOf?: string;
        addedTo?: string;
        name?: string;
      } = {},
    ) {
      const id = `review-user-${randomUUID()}`;
      userIds.add(id);
      await data.db.execute(sql`
        insert into "user" (id, name, email, "emailVerified", image)
        values (${id}, ${input.name ?? "Reviewer"}, ${`${id}@example.test`}, true, ${`https://img.example.test/${id}.png`})
      `);
      if (input.member)
        await data.db.execute(sql`
          insert into member (id, "organizationId", "userId", role, "createdAt")
          values (${randomUUID()}, ${orgId}, ${id}, 'member', now())
        `);
      if (input.addedTo)
        await data.db.insert(data.workspaceMemberships).values({
          workspaceId: input.addedTo,
          userId: id,
          role: "editor",
          source: "direct",
        });
      if (input.guestOf)
        await data.db.insert(data.workspaceMemberships).values({
          workspaceId: input.guestOf,
          userId: id,
          role: "viewer",
          source: "guest",
        });
      return id;
    }

    async function skill(
      input: {
        visibility?: "public" | "restricted";
        installedIn?: string[];
        ownerUserId?: string;
      } = {},
    ) {
      const id = randomUUID();
      const versionId = randomUUID();
      const slug = `review-${tag}-${randomBytes(4).toString("hex")}`;
      const visibility = input.visibility ?? "public";
      skillIds.add(id);
      await data.db.insert(data.skillDefinitions).values({
        id,
        sourceType: "registry_github",
        slug,
        displayName: "Review fixture",
        description: "A skill people review.",
        visibility,
        status: "active",
        ownerUserId: input.ownerUserId ?? null,
        repoOwner,
        repoName: "skills",
      });
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId: id,
        version: "1.2.0",
        status: "published",
        storageType: "db_text",
        storagePointer: `db://${versionId}`,
        isCurrent: true,
        contentHash: "hash",
        manifestJson: {
          slug,
          displayName: "Review fixture",
          version: "1.2.0",
          description: "A skill people review.",
          visibility,
          categories: [],
        },
      });
      for (const workspaceId of input.installedIn ?? [defaultWorkspaceId])
        await data.db.insert(data.workspaceSkills).values({
          id: randomUUID(),
          teamId: orgId,
          workspaceId,
          skillId: id,
          skillVersionId: versionId,
        });
      return { id, versionId, slug };
    }

    async function definition(skillId: string) {
      const [row] = await data.db
        .select({
          ratingCount: data.skillDefinitions.ratingCount,
          ratingAvg: data.skillDefinitions.ratingAvg,
          rankScore: data.skillDefinitions.rankScore,
          installCount: data.skillDefinitions.installCount,
          repoStars: data.skillDefinitions.repoStars,
        })
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, skillId));
      return row!;
    }

    const viewer = (userId: string, isMarketAdmin = false) => ({
      userId,
      isMarketAdmin,
    });
    const list = (
      slug: string,
      who: { userId: string; isMarketAdmin: boolean } | null,
      request: Partial<{
        cursor: string;
        limit: number;
        sort: "newest" | "highest" | "lowest";
      }> = {},
    ) =>
      reviews.listSkillReviews({
        slug,
        viewer: who,
        request: { limit: 20, sort: "newest", ...request },
      });

    async function events(skillId: string, action: string) {
      return data.db
        .select()
        .from(data.skillMarketEvents)
        .where(
          and(
            eq(data.skillMarketEvents.skillId, skillId),
            eq(data.skillMarketEvents.action, action),
          ),
        );
    }

    // --- eligibility ---------------------------------------------------------

    test("only someone in a workspace that installed the skill may review", async () => {
      const fixture = await skill({ installedIn: [projectWorkspaceId] });
      const outsider = await user();
      // In the organization, so in its default workspace — but the skill is
      // installed in the project workspace, which they were never added to.
      const colleague = await user({ member: true });
      const projectMember = await user({
        member: true,
        addedTo: projectWorkspaceId,
      });
      const guest = await user({ guestOf: projectWorkspaceId });

      for (const userId of [outsider, colleague]) {
        await expect(
          reviews.upsertMySkillReview({
            slug: fixture.slug,
            userId,
            rating: 4,
            body: "",
          }),
        ).rejects.toMatchObject({
          statusCode: 403,
          code: "SKILL_REVIEW_NOT_INSTALLED",
        });
        const page = await list(fixture.slug, viewer(userId));
        expect(page?.viewer).toEqual({
          canReview: false,
          reason: "not_installed",
          canReply: false,
        });
      }
      for (const userId of [projectMember, guest]) {
        const review = await reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId,
          rating: 5,
          body: "Works",
        });
        expect(review).toMatchObject({ rating: 5, body: "Works" });
        const page = await list(fixture.slug, viewer(userId));
        expect(page?.viewer.canReview).toBe(true);
        expect(page?.viewer.ownReview?.id).toBe(review.id);
      }

      const anonymous = await list(fixture.slug, null);
      expect(anonymous?.viewer).toEqual({
        canReview: false,
        reason: "signed_out",
        canReply: false,
      });
      expect(anonymous?.items).toHaveLength(2);
    });

    test("an unknown, archived or non-community skill cannot be reviewed", async () => {
      const member = await user({ member: true });
      await expect(
        reviews.upsertMySkillReview({
          slug: `missing-${tag}`,
          userId: member,
          rating: 3,
          body: "",
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "SKILL_NOT_FOUND" });
      const archived = await skill();
      await data.db
        .update(data.skillDefinitions)
        .set({ status: "archived" })
        .where(eq(data.skillDefinitions.id, archived.id));
      await expect(
        reviews.upsertMySkillReview({
          slug: archived.slug,
          userId: member,
          rating: 3,
          body: "",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(await list(archived.slug, viewer(member))).toBeNull();
    });

    // --- upsert, delete, aggregates -----------------------------------------

    test("one review per person: a second write edits it, records the version, refreshes the counts", async () => {
      const fixture = await skill();
      const member = await user({ member: true, name: "Ada" });
      const first = await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: member,
        rating: 2,
        body: "Meh",
      });
      expect(first).toMatchObject({
        rating: 2,
        body: "Meh",
        status: "visible",
        version: "1.2.0",
        reviewer: {
          name: "Ada",
          image: `https://img.example.test/${member}.png`,
        },
        authorReply: null,
      });
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 1,
        ratingAvg: 2,
      });

      const second = await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: member,
        rating: 5,
        body: "Better after the update",
      });
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt >= first.updatedAt).toBe(true);
      const rows = await data.db
        .select()
        .from(data.skillReviews)
        .where(eq(data.skillReviews.skillId, fixture.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.skillVersionId).toBe(fixture.versionId);
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 1,
        ratingAvg: 5,
      });
      const written = await events(fixture.id, "review.written");
      expect(written.map((event) => event.detail)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rating: 2, created: true }),
          expect.objectContaining({ rating: 5, created: false }),
        ]),
      );

      expect(
        await reviews.deleteMySkillReview({
          slug: fixture.slug,
          userId: member,
        }),
      ).toBe(true);
      expect(
        await reviews.deleteMySkillReview({
          slug: fixture.slug,
          userId: member,
        }),
      ).toBe(false);
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 0,
        ratingAvg: null,
      });
      expect(await events(fixture.id, "review.deleted")).toHaveLength(1);
    });

    test("writes past the hourly limit are refused, and a refused delete keeps the review", async () => {
      const fixture = await skill();
      const member = await user({ member: true });
      for (let i = 0; i < reviews.SKILL_REVIEW_WRITES_PER_HOUR; i += 1)
        await reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId: member,
          rating: 1 + (i % 5),
          body: `edit ${i}`,
        });
      await expect(
        reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId: member,
          rating: 5,
          body: "one too many",
        }),
      ).rejects.toMatchObject({
        statusCode: 429,
        code: "SKILL_REVIEW_RATE_LIMITED",
      });
      await expect(
        reviews.deleteMySkillReview({ slug: fixture.slug, userId: member }),
      ).rejects.toMatchObject({ statusCode: 429 });
      const [row] = await data.db
        .select({ body: data.skillReviews.body })
        .from(data.skillReviews)
        .where(eq(data.skillReviews.skillId, fixture.id));
      expect(row?.body).toBe(
        `edit ${reviews.SKILL_REVIEW_WRITES_PER_HOUR - 1}`,
      );
    });

    test("refreshSkillRatings recomputes from visible reviews and writes only what changed", async () => {
      const fixture = await skill();
      const members = await Promise.all(
        [4, 5, 3].map(() => user({ member: true })),
      );
      for (const [index, rating] of [4, 5, 3].entries())
        await reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId: members[index]!,
          rating,
          body: "",
        });
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 3,
        ratingAvg: 4,
      });
      // Out of step, as a copy can be: the global pass puts it right.
      await data.db
        .update(data.skillDefinitions)
        .set({ ratingCount: 99, ratingAvg: 1 })
        .where(eq(data.skillDefinitions.id, fixture.id));
      expect((await reviews.refreshSkillRatings()).updated).toBeGreaterThan(0);
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 3,
        ratingAvg: 4,
      });
      // In step: nothing to write for this skill.
      expect(
        (await reviews.refreshSkillRatings({ skillId: fixture.id })).updated,
      ).toBe(0);
      // A skill without reviews ends at zero and null.
      const bare = await skill();
      await data.db
        .update(data.skillDefinitions)
        .set({ ratingCount: 7, ratingAvg: 3 })
        .where(eq(data.skillDefinitions.id, bare.id));
      expect(
        (await reviews.refreshSkillRatings({ skillId: bare.id })).updated,
      ).toBe(1);
      expect(await definition(bare.id)).toMatchObject({
        ratingCount: 0,
        ratingAvg: null,
      });
    });

    test("the rank score SQL and rank.ts agree on every rating, halves included", async () => {
      const rank = await import("./rank");
      const fixture = await skill();
      const cases: Array<[number, number | null, number]> = [
        [0, null, 0],
        [4, 5, 3],
        [5, 3.25, 0], // a term of exactly -7.5
        [5, 1, 0],
        [7, 24 / 7, 12],
        [30, 4.9, 2],
        [13, 1.3846153846153846, 40],
        [1000, 4.123, 999],
      ];
      for (const [ratingCount, ratingAvg, repoStars] of cases) {
        await data.db
          .update(data.skillDefinitions)
          .set({ ratingCount, ratingAvg, repoStars, installCount: 1 })
          .where(eq(data.skillDefinitions.id, fixture.id));
        await data.db.execute(sql`
          update skill_definitions set rank_score = ${rank.skillRankScoreSql}
          where id = ${fixture.id}
        `);
        const row = await definition(fixture.id);
        expect(row.rankScore, JSON.stringify(row)).toBe(
          rank.skillRankScore(row),
        );
      }
    });

    test("five visible reviews move the rank score by the rating term", async () => {
      const rank = await import("./rank");
      const fixture = await skill();
      const members = await Promise.all(
        [0, 1, 2, 3].map(() => user({ member: true })),
      );
      for (const userId of members)
        await reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId,
          rating: 5,
          body: "",
        });
      const four = await definition(fixture.id);
      expect(four.ratingCount).toBe(4);
      expect(four.rankScore).toBe(rank.skillRankScore(four));
      expect(rank.skillRatingRankTerm(four)).toBe(0);

      await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: await user({ member: true }),
        rating: 5,
        body: "",
      });
      const five = await definition(fixture.id);
      expect(five.ratingCount).toBe(5);
      expect(rank.skillRatingRankTerm(five)).toBe(45);
      expect(five.rankScore).toBe(rank.skillRankScore(five));
      expect(five.rankScore - four.rankScore).toBe(45);
    });

    // --- moderation ----------------------------------------------------------

    test("a hidden review leaves the page and the counts; its author still sees it", async () => {
      const fixture = await skill();
      const author = await user({ member: true });
      const other = await user({ member: true });
      const admin = `review-admin-${tag}`;
      const hiddenOne = await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: author,
        rating: 1,
        body: "spam spam",
      });
      await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: other,
        rating: 5,
        body: "",
      });

      expect(
        await reviews.setSkillReviewStatus({
          reviewId: hiddenOne.id,
          status: "hidden",
          actorUserId: admin,
          reason: "spam",
        }),
      ).toEqual({
        reviewId: hiddenOne.id,
        skillId: fixture.id,
        status: "hidden",
      });
      const [row] = await data.db
        .select()
        .from(data.skillReviews)
        .where(eq(data.skillReviews.id, hiddenOne.id));
      expect(row).toMatchObject({ status: "hidden", hiddenBy: admin });
      expect(row!.hiddenAt).toBeInstanceOf(Date);
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 1,
        ratingAvg: 5,
      });

      const publicPage = await list(fixture.slug, null);
      expect(publicPage?.items.map((item) => item.id)).not.toContain(
        hiddenOne.id,
      );
      expect(publicPage?.summary).toEqual({
        count: 1,
        average: 5,
        distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 },
      });
      const own = await list(fixture.slug, viewer(author));
      expect(own?.viewer.ownReview).toMatchObject({
        id: hiddenOne.id,
        status: "hidden",
      });

      // Editing does not bring it back.
      await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: author,
        rating: 2,
        body: "edited",
      });
      expect(
        (await list(fixture.slug, viewer(author)))?.viewer.ownReview,
      ).toMatchObject({ status: "hidden", body: "edited" });

      const hiddenEvents = await events(fixture.id, "review.hidden");
      expect(hiddenEvents).toHaveLength(1);
      expect(hiddenEvents[0]).toMatchObject({
        actorKind: "admin",
        actorUserId: admin,
        detail: expect.objectContaining({
          reviewId: hiddenOne.id,
          reason: "spam",
        }),
      });

      // Hiding it again changes nothing and records nothing.
      await reviews.setSkillReviewStatus({
        reviewId: hiddenOne.id,
        status: "hidden",
        actorUserId: admin,
      });
      expect(await events(fixture.id, "review.hidden")).toHaveLength(1);

      await reviews.setSkillReviewStatus({
        reviewId: hiddenOne.id,
        status: "visible",
        actorUserId: admin,
      });
      const [shown] = await data.db
        .select()
        .from(data.skillReviews)
        .where(eq(data.skillReviews.id, hiddenOne.id));
      expect(shown).toMatchObject({
        status: "visible",
        hiddenBy: null,
        hiddenAt: null,
      });
      expect(await events(fixture.id, "review.shown")).toHaveLength(1);
      expect(await definition(fixture.id)).toMatchObject({
        ratingCount: 2,
        ratingAvg: 3.5,
      });

      expect(
        await reviews.setSkillReviewStatus({
          reviewId: `missing-${tag}`,
          status: "hidden",
          actorUserId: admin,
        }),
      ).toBeNull();
    });

    // --- author replies ------------------------------------------------------

    test("only the verified claimant of the repository may reply, once per review", async () => {
      const fixture = await skill();
      const reviewer = await user({ member: true });
      const claimant = await user();
      const stranger = await user();
      const review = await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: reviewer,
        rating: 3,
        body: "Missing docs",
      });

      const reply = (userId: string, body: string | null) =>
        reviews.setSkillReviewReply({
          slug: fixture.slug,
          reviewId: review.id,
          userId,
          body,
        });

      // Nobody has claimed the repository yet.
      await expect(reply(claimant, "Thanks")).rejects.toMatchObject({
        statusCode: 403,
        code: "SKILL_REVIEW_REPLY_FORBIDDEN",
      });
      const claimId = randomUUID();
      await data.db.insert(data.skillRepoClaims).values({
        id: claimId,
        repoOwner,
        repoName: "skills",
        userId: claimant,
        method: "admin_grant",
        status: "verified",
        verifiedAt: new Date(),
      });
      try {
        await expect(reply(stranger, "Hi")).rejects.toMatchObject({
          statusCode: 403,
        });
        // The reviewer cannot answer themselves either.
        await expect(reply(reviewer, "Hi")).rejects.toMatchObject({
          statusCode: 403,
        });
        expect(
          (await list(fixture.slug, viewer(claimant)))?.viewer.canReply,
        ).toBe(true);

        const answered = await reply(claimant, "Docs added in 1.3");
        expect(answered.authorReply?.body).toBe("Docs added in 1.3");
        const replaced = await reply(claimant, "Docs added in 1.3.1");
        expect(replaced.authorReply?.body).toBe("Docs added in 1.3.1");
        const [row] = await data.db
          .select()
          .from(data.skillReviews)
          .where(eq(data.skillReviews.id, review.id));
        expect(row).toMatchObject({
          authorReply: "Docs added in 1.3.1",
          authorReplyBy: claimant,
        });
        const replied = await events(fixture.id, "review.replied");
        expect(replied).toHaveLength(2);
        expect(replied[0]).toMatchObject({ actorKind: "owner" });

        // Editing the review keeps the answer.
        await reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId: reviewer,
          rating: 4,
          body: "Docs are fine now",
        });
        const [publicReview] = (await list(fixture.slug, null))!.items;
        expect(publicReview?.authorReply?.body).toBe("Docs added in 1.3.1");

        const removed = await reply(claimant, null);
        expect(removed.authorReply).toBeNull();
        expect(await events(fixture.id, "review.reply_removed")).toHaveLength(
          1,
        );

        // A hidden review cannot be answered; one on another skill is not found.
        await reviews.setSkillReviewStatus({
          reviewId: review.id,
          status: "hidden",
          actorUserId: `review-admin-${tag}`,
        });
        await expect(reply(claimant, "Hello?")).rejects.toMatchObject({
          statusCode: 404,
        });
        const other = await skill();
        await expect(
          reviews.setSkillReviewReply({
            slug: other.slug,
            reviewId: review.id,
            userId: claimant,
            body: "Wrong skill",
          }),
        ).rejects.toMatchObject({ statusCode: 404 });

        // A revoked claim answers nothing.
        await data.db
          .update(data.skillRepoClaims)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(data.skillRepoClaims.id, claimId));
        await expect(reply(claimant, "Still me")).rejects.toMatchObject({
          statusCode: 403,
        });
      } finally {
        await data.db
          .delete(data.skillRepoClaims)
          .where(eq(data.skillRepoClaims.id, claimId));
      }
    });

    // --- reading ---------------------------------------------------------------

    test("pages walk every sort without gaps or repeats, with a live summary", async () => {
      const fixture = await skill();
      const ratings = [5, 1, 4, 4, 2, 5, 3];
      const members = await Promise.all(
        ratings.map(() => user({ member: true })),
      );
      const written: Array<{ id: string; rating: number }> = [];
      for (const [index, rating] of ratings.entries()) {
        const review = await reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId: members[index]!,
          rating,
          body: `review ${index}`,
        });
        written.push({ id: review.id, rating });
      }

      async function walk(
        sort: "newest" | "highest" | "lowest",
        limit: number,
      ) {
        const seen: Array<{ id: string; rating: number }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await list(fixture.slug, null, {
            sort,
            limit,
            ...(cursor ? { cursor } : {}),
          });
          seen.push(
            ...result!.items.map((item) => ({
              id: item.id,
              rating: item.rating,
            })),
          );
          if (!result!.nextCursor) break;
          cursor = result!.nextCursor;
        }
        return seen;
      }

      for (const limit of [1, 2, 3, 50]) {
        const newest = await walk("newest", limit);
        expect(newest.map((item) => item.id)).toEqual(
          [...written].reverse().map((item) => item.id),
        );
        const highest = await walk("highest", limit);
        expect(highest.map((item) => item.rating)).toEqual(
          [...ratings].sort((a, b) => b - a),
        );
        expect(new Set(highest.map((item) => item.id)).size).toBe(7);
        const lowest = await walk("lowest", limit);
        expect(lowest.map((item) => item.rating)).toEqual(
          [...ratings].sort((a, b) => a - b),
        );
        expect(new Set(lowest.map((item) => item.id)).size).toBe(7);
      }

      const first = await list(fixture.slug, null);
      expect(first?.summary).toEqual({
        count: 7,
        average: 24 / 7,
        distribution: { "1": 1, "2": 1, "3": 1, "4": 2, "5": 2 },
      });
      expect(first?.items[0]?.reviewer.name).toBe("Reviewer");

      // A cursor of one sort is refused by another.
      const newestCursor = (await list(fixture.slug, null, { limit: 1 }))!
        .nextCursor!;
      await expect(
        list(fixture.slug, null, { sort: "highest", cursor: newestCursor }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "SKILL_REVIEW_CURSOR_INVALID",
      });
    });

    test("a restricted skill's reviews are read only by those who can see it", async () => {
      const submitter = await user();
      const fixture = await skill({
        visibility: "restricted",
        ownerUserId: submitter,
      });
      const member = await user({ member: true });
      const outsider = await user();
      await reviews.upsertMySkillReview({
        slug: fixture.slug,
        userId: member,
        rating: 4,
        body: "",
      });

      expect(await list(fixture.slug, null)).toBeNull();
      expect(await list(fixture.slug, viewer(outsider))).toBeNull();
      expect((await list(fixture.slug, viewer(member)))?.items).toHaveLength(1);
      expect((await list(fixture.slug, viewer(submitter)))?.items).toHaveLength(
        1,
      );
      expect(
        (await list(fixture.slug, viewer(outsider, true)))?.items,
      ).toHaveLength(1);
      // Writing is refused as if the skill were not there.
      await expect(
        reviews.upsertMySkillReview({
          slug: fixture.slug,
          userId: outsider,
          rating: 5,
          body: "",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      // A grant to a workspace the user is in opens it too.
      const granted = await skill({
        visibility: "restricted",
        installedIn: [],
      });
      const projectMember = await user({
        member: true,
        addedTo: projectWorkspaceId,
      });
      expect(await list(granted.slug, viewer(projectMember))).toBeNull();
      await data.db.insert(data.skillEntitlements).values({
        id: randomUUID(),
        skillId: granted.id,
        teamId: orgId,
        workspaceId: projectWorkspaceId,
      });
      expect(await list(granted.slug, viewer(projectMember))).not.toBeNull();
    });
  },
);
