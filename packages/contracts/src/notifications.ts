import { z } from "zod";

/**
 * A person's in-app inbox in one workspace's team. Payloads are flat and small
 * and carry only what a list row may show (a task name, a thread id).
 */

export const notificationItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  ref: z.object({ kind: z.string(), id: z.string() }).nullable(),
  payload: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
  /** How many times the event repeated into this row inside the merge window. */
  occurrenceCount: z.number().int().positive(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
  lastOccurredAt: z.string(),
  /** Where the notification leads, relative to the web base URL. */
  path: z.string(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const listNotificationsRequestSchema = z.object({
  cursor: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unreadOnly: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ListNotificationsRequest = {
  cursor?: string;
  limit?: number;
  unreadOnly?: boolean;
};

export const listNotificationsResponseSchema = z.object({
  notifications: z.array(notificationItemSchema),
  nextCursor: z.string().nullable(),
});
export type ListNotificationsResponse = z.infer<
  typeof listNotificationsResponseSchema
>;

export const notificationUnreadCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type NotificationUnreadCountResponse = z.infer<
  typeof notificationUnreadCountResponseSchema
>;

export const markNotificationsReadResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
});
export type MarkNotificationsReadResponse = z.infer<
  typeof markNotificationsReadResponseSchema
>;
