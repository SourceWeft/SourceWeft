import { z } from "zod";

export const generateVideoPresentationSchema = z
  .object({
    source_content: z.string().min(1).max(50_000),
    video_title: z.string().max(160).optional(),
    user_prompt: z.string().max(2000).optional(),
    narration: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GenerateVideoPresentationArgs = z.infer<
  typeof generateVideoPresentationSchema
>;

export function parseGenerateVideoPresentationArgs(
  input: unknown,
): GenerateVideoPresentationArgs {
  const parsed = generateVideoPresentationSchema.parse(input);
  const sourceContent = parsed.source_content.trim();
  if (!sourceContent) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["source_content"],
        message: "source_content is required.",
      },
    ]);
  }
  const videoTitle = parsed.video_title?.trim();
  const userPrompt = parsed.user_prompt?.trim();
  return {
    ...parsed,
    source_content: sourceContent,
    ...(videoTitle ? { video_title: videoTitle } : {}),
    ...(userPrompt ? { user_prompt: userPrompt } : {}),
  };
}
