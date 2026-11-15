import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Throws unless `path` is covered by a .gitignore rule of the repository that
 * contains it. Used before writing files that hold user content, so they can
 * never be staged by accident. It fails closed: a path outside a git
 * repository, a tracked file, or a git error all count as "not ignored".
 */
export async function assertGitIgnored(path: string) {
  const absolute = resolve(path);
  try {
    await run("git", ["check-ignore", "-q", "--", absolute], {
      cwd: await existingAncestor(absolute),
    });
  } catch {
    throw new Error(
      `Refusing to use ${absolute}: it is not git-ignored, so it could be committed. Choose a path under an ignored folder such as .local-eval/.`,
    );
  }
}

async function existingAncestor(path: string) {
  const { stat } = await import("node:fs/promises");
  let current = dirname(path);
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // keep climbing
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
