import { ContentError } from "../../errors";

export type ThreadsCursor = {
  id: string;
  updatedAt: string;
};

export function encodeThreadsCursor(input: ThreadsCursor) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

export function decodeThreadsCursor(cursor: string): ThreadsCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ThreadsCursor>;

    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }

    const date = new Date(parsed.updatedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid cursor timestamp");
    }

    return {
      id: parsed.id,
      updatedAt: date.toISOString(),
    };
  } catch {
    throw new ContentError(400, "INVALID_CURSOR", "Invalid threads cursor");
  }
}
