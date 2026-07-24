import { jobsQueue } from "../../../shared/queue";
import { PRESENCE_TTL_MS, PRESENCE_TTL_SECONDS } from "./constants";

/**
 * Redis-backed viewer presence for a thread. Membership is per-CONNECTION
 * (`userId:connId`), so a user with two tabs is two members and one tab closing
 * never flickers them out of the roster. State lives in the shared BullMQ Redis
 * (like the chat-run stream log), so it is correct across api replicas.
 *
 * There is no client heartbeat: the room SSE generator calls `touchPresence` on
 * connect and on every 15s beat, and `dropPresence` in its finally. The whole-key
 * TTL is the crash backstop, and reads sweep stale members lazily — no reaper.
 */
const presenceKey = (threadId: string) => `presence:thread:${threadId}`;
const presenceMember = (userId: string, connId: string) => `${userId}:${connId}`;

export function userIdFromMember(member: string): string {
  // userId and connId are both UUIDs (no ':'), so the last ':' splits them.
  const separator = member.lastIndexOf(":");
  return separator >= 0 ? member.slice(0, separator) : member;
}

/**
 * Collapse `userId:connId` members to distinct userIds. A user with two tabs is
 * two members but one viewer.
 */
export function distinctViewerIds(members: string[]): string[] {
  const userIds = new Set<string>();
  for (const member of members) {
    userIds.add(userIdFromMember(member));
  }
  return [...userIds];
}

/** Join or heartbeat: upsert this connection's timestamp and refresh the TTL. */
export async function touchPresence(
  threadId: string,
  userId: string,
  connId: string,
): Promise<void> {
  const redis = await jobsQueue.client;
  await redis
    .multi()
    .zadd(presenceKey(threadId), Date.now(), presenceMember(userId, connId))
    .expire(presenceKey(threadId), PRESENCE_TTL_SECONDS)
    .exec();
}

/** Leave: remove exactly this connection. TTL is the fallback if this is missed. */
export async function dropPresence(
  threadId: string,
  userId: string,
  connId: string,
): Promise<void> {
  const redis = await jobsQueue.client;
  await redis.zrem(presenceKey(threadId), presenceMember(userId, connId));
}

/** Current distinct viewer userIds, sweeping stale members on the way (lazy). */
export async function readPresence(threadId: string): Promise<string[]> {
  const redis = await jobsQueue.client;
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const results = await redis
    .multi()
    .zremrangebyscore(presenceKey(threadId), "-inf", cutoff - 1)
    .zrangebyscore(presenceKey(threadId), cutoff, "+inf")
    .exec();

  const members = (results?.[1]?.[1] as string[] | undefined) ?? [];
  return distinctViewerIds(members);
}
