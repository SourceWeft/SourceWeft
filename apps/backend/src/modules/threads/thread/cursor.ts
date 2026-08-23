import { ContentError } from "../../content/errors";

export type ThreadsCursor = {
  id: string;
  activityAt: string;
};

export function encodeThreadsCursor(input: ThreadsCursor) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

export function decodeThreadsCursor(cursor: string): ThreadsCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ThreadsCursor> & { updatedAt?: string };

    // Tolerate cursors minted before the sort key moved off updated_at, so a
    // page token already in flight at deploy time keeps paginating.
    const activityAt = parsed?.activityAt ?? parsed?.updatedAt;

    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof activityAt !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }

    const date = new Date(activityAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid cursor timestamp");
    }

    return {
      id: parsed.id,
      activityAt: date.toISOString(),
    };
  } catch {
    throw new ContentError(400, "INVALID_CURSOR", "Invalid threads cursor");
  }
}
