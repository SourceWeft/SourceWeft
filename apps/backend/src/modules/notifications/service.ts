import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { database, db, notifications } from "@sourceweft/db";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import {
  NOTIFICATION_MERGE_WINDOW_MS,
  NOTIFICATION_PAYLOAD_MAX_BYTES,
  notificationKindDefinition,
  type NotificationKind,
  type NotificationPayload,
} from "./kinds";

export type NotificationRef = { kind: string; id: string };

export type NotifyInput = {
  kind: NotificationKind;
  teamId: string;
  userId: string;
  /** What the notification is about; repeats merge per ref. */
  ref?: NotificationRef;
  payload?: NotificationPayload;
  /** Overrides the kind's email default (a per-task toggle, for example). */
  email?: boolean;
  now?: Date;
};

export type NotifyResult = { id: string; merged: boolean; emailed: boolean };

export type NotificationItem = {
  id: string;
  kind: string;
  ref: NotificationRef | null;
  payload: NotificationPayload;
  occurrenceCount: number;
  readAt: Date | null;
  createdAt: Date;
  lastOccurredAt: Date;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function assertPayload(payload: NotificationPayload) {
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") >
    NOTIFICATION_PAYLOAD_MAX_BYTES
  ) {
    throw new Error("Notification payload is too large");
  }
}

/**
 * Records a notification for one person and emails it when the kind (or the
 * caller) asks for email. The same kind for the same ref inside the merge
 * window folds into the existing row and does not email again, so a job that
 * fails every hour produces one inbox entry and one email a day.
 *
 * A mail failure never fails the notification: the row is the source of truth,
 * the email is best effort, and a failed send is retried by the next merged
 * occurrence.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const definition = notificationKindDefinition(input.kind);
  const payload = input.payload ?? {};
  assertPayload(payload);
  const now = input.now ?? new Date();
  const refKind = input.ref?.kind ?? null;
  const refId = input.ref?.id ?? null;
  const wantEmail =
    definition.template !== null && (input.email ?? definition.defaultEmail);
  const lockKey = [input.userId, input.kind, refKind, refId].join("|");

  const stored = await db.transaction(async (tx) => {
    // Serializes concurrent identical events so exactly one inserts and the
    // rest merge into it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, input.userId),
          eq(notifications.teamId, input.teamId),
          eq(notifications.kind, input.kind),
          sql`${notifications.refKind} is not distinct from ${refKind}::text`,
          sql`${notifications.refId} is not distinct from ${refId}::text`,
          sql`${notifications.createdAt} > ${new Date(
            now.getTime() - NOTIFICATION_MERGE_WINDOW_MS,
          ).toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);

    // The email is claimed inside the transaction (emailed_at is the claim),
    // so two racing events cannot both decide to send it.
    const claimEmail = wantEmail && (existing ? !existing.emailedAt : true);

    if (existing) {
      await tx
        .update(notifications)
        .set({
          occurrenceCount: existing.occurrenceCount + 1,
          lastOccurredAt: now,
          payloadJson: payload,
          readAt: null,
          emailedAt: claimEmail ? now : existing.emailedAt,
        })
        .where(eq(notifications.id, existing.id));
      return { id: existing.id, merged: true, claimEmail };
    }
    const id = randomUUID();
    await tx.insert(notifications).values({
      id,
      teamId: input.teamId,
      userId: input.userId,
      kind: input.kind,
      refKind,
      refId,
      payloadJson: payload,
      lastOccurredAt: now,
      createdAt: now,
      emailedAt: claimEmail ? now : null,
    });
    return { id, merged: false, claimEmail };
  });

  let emailed = false;
  if (stored.claimEmail) {
    emailed = await sendNotificationEmail({
      kind: input.kind,
      userId: input.userId,
      refId,
      payload,
    });
    if (!emailed) {
      // Release the claim so a later occurrence can try again.
      await db
        .update(notifications)
        .set({ emailedAt: null })
        .where(
          and(
            eq(notifications.id, stored.id),
            eq(notifications.emailedAt, now),
          ),
        );
    }
  }
  return { id: stored.id, merged: stored.merged, emailed };
}

const FALLBACK_TASK_NAME: Record<string, string> = {
  en: "A scheduled task",
  "zh-CN": "一个定时任务",
  "zh-TW": "一個定時任務",
};

async function sendNotificationEmail(input: {
  kind: NotificationKind;
  userId: string;
  refId: string | null;
  payload: NotificationPayload;
}): Promise<boolean> {
  const definition = notificationKindDefinition(input.kind);
  if (!definition.template) return false;
  try {
    const result = await database.query<{ email: string | null }>(
      'select email from "user" where id = $1',
      [input.userId],
    );
    const to = result.rows[0]?.email;
    if (!to) return false;
    const { resolveMailLocale } = await import("../auth/mail-locale");
    const { mailService } = await import("../mail");
    const locale = await resolveMailLocale({ userId: input.userId });
    // Only the task's name and a link: never prompts, results or the payload
    // as a whole, because mail is forwarded and stored outside our control.
    const rawName =
      typeof input.payload.taskName === "string" ? input.payload.taskName : "";
    const fallbackName = definition.fallbackName ?? FALLBACK_TASK_NAME;
    const taskName =
      rawName.replace(/\s+/g, " ").trim().slice(0, 80) ||
      fallbackName[locale] ||
      fallbackName.en!;
    const url = new URL(
      definition.path({ refId: input.refId, payload: input.payload }),
      config.auth.webBaseUrl,
    ).toString();
    await mailService.sendTemplate({
      to,
      templateId: definition.template,
      messageType: "biz.notification",
      locale,
      variables: { taskName, url },
    });
    return true;
  } catch (error) {
    logger.error("notification_email_failed", {
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function encodeCursor(row: { lastOccurredAt: Date; id: string }) {
  return Buffer.from(
    `${row.lastOccurredAt.getTime()}.${row.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string) {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(".");
  const ms = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 1 || !Number.isFinite(ms) || !id) {
    throw new Error("Invalid notifications cursor");
  }
  return { at: new Date(ms), id };
}

function toItem(row: typeof notifications.$inferSelect): NotificationItem {
  return {
    id: row.id,
    kind: row.kind,
    ref: row.refKind && row.refId ? { kind: row.refKind, id: row.refId } : null,
    payload: row.payloadJson as NotificationPayload,
    occurrenceCount: row.occurrenceCount,
    readAt: row.readAt,
    createdAt: row.createdAt,
    lastOccurredAt: row.lastOccurredAt,
  };
}

/** The person's notifications in one team, newest activity first. */
export async function listNotifications(input: {
  userId: string;
  teamId: string;
  limit?: number;
  cursor?: string;
  unreadOnly?: boolean;
}): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, input.userId),
        eq(notifications.teamId, input.teamId),
        input.unreadOnly ? isNull(notifications.readAt) : undefined,
        cursor
          ? or(
              lt(notifications.lastOccurredAt, cursor.at),
              and(
                eq(notifications.lastOccurredAt, cursor.at),
                lt(notifications.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.lastOccurredAt), desc(notifications.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map(toItem),
    nextCursor:
      rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

export async function unreadCount(input: { userId: string; teamId: string }) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, input.userId),
        eq(notifications.teamId, input.teamId),
        isNull(notifications.readAt),
      ),
    );
  return row?.count ?? 0;
}

/** Marks one of the person's notifications read; false when it is not theirs. */
export async function markRead(input: {
  userId: string;
  teamId: string;
  id: string;
}) {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(
      and(
        eq(notifications.id, input.id),
        eq(notifications.userId, input.userId),
        eq(notifications.teamId, input.teamId),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Erases everything the person was notified about. Owners are plain text here
 * (the auth tables live outside the drizzle schema), so account deletion calls
 * this instead of relying on a foreign key.
 */
export async function deleteUserNotifications(userId: string) {
  const rows = await db
    .delete(notifications)
    .where(eq(notifications.userId, userId))
    .returning({ id: notifications.id });
  return rows.length;
}

/** Marks every unread notification of the person in the team read. */
export async function markAllRead(input: { userId: string; teamId: string }) {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, input.userId),
        eq(notifications.teamId, input.teamId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
