import { z } from "zod";
import { fileRelativePathSchema } from "@sourceweft/contracts";
import { localCall } from "./service";
import type { LocalExecutionCaller } from "./access";
import { ContentError } from "../content/errors";

export async function grepLocalFilePaths(input: {
  userId: string;
  deviceId: string;
  threadId: string;
  workspaceId: string;
  root: string;
  paths: string[];
  pattern: string;
  literal?: boolean;
  ignoreCase?: boolean;
  firstPerFile?: boolean;
  caller?: LocalExecutionCaller;
  signal?: AbortSignal;
}) {
  const root = input.root.replace(/\/+$/, "");
  const paths = input.paths.map((path) => {
    if (!path.startsWith(`${root}/`))
      throw new ContentError(
        403,
        "FILE_SCOPE_DENIED",
        "Search files inside the bound directory.",
      );
    return fileRelativePathSchema.parse(path.slice(root.length + 1));
  });
  const raw = await localCall({
    deviceId: input.deviceId,
    userId: input.userId,
    threadId: input.threadId,
    caller: input.caller,
    signal: input.signal,
    action: "file.grep",
    payload: {
      workspaceId: input.workspaceId,
      path: ".",
      paths,
      pattern: input.pattern,
      literal: input.literal === true,
      ignoreCase: input.ignoreCase === true,
      firstPerFile: input.firstPerFile === true,
    },
  });
  const result = z
    .object({
      matches: z
        .array(
          z.object({
            path: fileRelativePathSchema,
            line: z.number().int().positive(),
            text: z.string().max(4000),
          }),
        )
        .max(100),
      visited: z.number().int().min(0).max(paths.length),
      skipped: z.array(fileRelativePathSchema),
      truncated: z.boolean(),
    })
    .parse(raw);
  const requested = new Set(paths);
  if (
    result.matches.some((match) => !requested.has(match.path)) ||
    result.skipped.some((path) => !requested.has(path))
  )
    throw new ContentError(
      502,
      "SEARCH_SCOPE_VIOLATION",
      "The computer returned files outside the requested search scope.",
    );
  return {
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      path: `${root}/${match.path}`,
    })),
    skipped: result.skipped.map((path) => `${root}/${path}`),
    visitedPaths: input.paths.slice(0, result.visited),
  };
}
