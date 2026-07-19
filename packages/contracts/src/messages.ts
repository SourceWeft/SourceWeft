import { z } from "zod";

/** Shared with the messages table in @sourceweft/db. */
export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const chatMessageTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const chatMessageImagePartSchema = z.object({
  type: z.literal("image"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  storageBucket: z.string().nullable().optional(),
  storageKey: z.string().optional(),
  url: z.string(),
  visionDescription: z.string().optional(),
  visionModelAlias: z.string().optional(),
  visionProfileAlias: z.string().optional(),
});

export const chatMessagePartSchema = z.discriminatedUnion("type", [
  chatMessageTextPartSchema,
  chatMessageImagePartSchema,
]);

export const messageContentJsonSchema = z
  .object({
    version: z.literal(1).optional(),
    parts: z.array(chatMessagePartSchema).optional(),
  })
  .catchall(z.unknown());

export const messageSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  parentMessageId: z.string().nullable(),
  role: messageRoleSchema,
  content: z.string(),
  contentJson: messageContentJsonSchema,
  createdBy: z.string().nullable(),
  model: z.string().nullable(),
  creditsConsumed: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export type ChatMessageTextPart = z.infer<typeof chatMessageTextPartSchema>;
export type ChatMessageImagePart = z.infer<typeof chatMessageImagePartSchema>;
export type ChatMessagePart = z.infer<typeof chatMessagePartSchema>;
export type MessageContentJson = z.infer<typeof messageContentJsonSchema>;
export type Message = z.infer<typeof messageSchema>;
