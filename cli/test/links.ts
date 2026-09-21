import { symlink } from "node:fs/promises";
import type { TestContext } from "node:test";

/** Making a link was refused by the OS or the filesystem, not by a bug. */
export class LinkNotPermitted extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `cannot create a symlink or junction at ${path} on ${process.platform} (${
        (cause as NodeJS.ErrnoException).code ?? "unknown error"
      }): ${(cause as Error).message}`,
      { cause },
    );
    this.name = "LinkNotPermitted";
  }
}

const isRefusal = (error: unknown) =>
  ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );

/**
 * Makes `path` a link to the directory `target`. On Windows a symlink needs a
 * privilege (administrator, or Developer Mode) that an ordinary account lacks;
 * a junction needs none, and Node reports it as a link the same way (`lstat`
 * says symbolic link, `readdir` says not a directory), so it stands in for it.
 * Throws `LinkNotPermitted` only when neither can be made.
 */
export async function linkDirectory(
  target: string,
  path: string,
): Promise<void> {
  try {
    await symlink(target, path, "dir");
    return;
  } catch (error) {
    if (!isRefusal(error)) {
      throw error;
    }
    if (process.platform !== "win32") {
      throw new LinkNotPermitted(path, error);
    }
  }
  try {
    await symlink(target, path, "junction");
  } catch (error) {
    throw isRefusal(error) ? new LinkNotPermitted(path, error) : error;
  }
}

/**
 * `linkDirectory` for a test that is about links. If the OS will not allow one,
 * the test is reported as skipped, with the reason, and this returns false so
 * the caller can stop; it never lets such a test pass without having tested
 * anything.
 */
export async function linkOrSkip(
  t: TestContext,
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await linkDirectory(target, path);
    return true;
  } catch (error) {
    if (error instanceof LinkNotPermitted) {
      t.skip(error.message);
      return false;
    }
    throw error;
  }
}
