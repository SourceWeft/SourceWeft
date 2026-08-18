import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const nextRoot = path.join(repoRoot, "apps", "web", ".next");
const targets = [path.join(nextRoot, "dev"), path.join(nextRoot, "cache")];
const lockPath = path.join(nextRoot, "dev", "lock");

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function assertExpectedTarget(target) {
  const resolved = path.resolve(target);
  if (
    !targets.includes(resolved) ||
    !resolved.startsWith(`${nextRoot}${path.sep}`)
  ) {
    throw new Error(`refusing unexpected cache path: ${resolved}`);
  }
}

async function pathSize(target) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  if (info.isSymbolicLink()) return info.size;
  if (!info.isDirectory()) return info.size;

  let total = info.size;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    total += await pathSize(path.join(target, entry.name));
  }
  return total;
}

async function assertNextDevStopped() {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(`cannot read Next dev lock ${lockPath}: ${error.message}`);
  }

  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse Next dev lock ${lockPath}: ${error.message}`);
  }

  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
    throw new Error(
      `Next dev lock has an invalid pid: ${JSON.stringify(lock.pid)}`,
    );
  }

  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(`cannot verify Next dev pid ${lock.pid}: ${error.message}`);
  }

  throw new Error(
    `Next dev is still running as pid ${lock.pid}; stop it before cleaning the cache.`,
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (args.length > 0 && !dryRun) {
    throw new Error(`unsupported arguments: ${args.join(" ")}`);
  }

  for (const target of targets) assertExpectedTarget(target);

  const sizes = await Promise.all(targets.map((target) => pathSize(target)));
  const total = sizes.reduce((sum, size) => sum + size, 0);

  for (const [index, target] of targets.entries()) {
    console.log(
      `${path.relative(repoRoot, target)}: ${formatBytes(sizes[index])}`,
    );
  }
  console.log(`${dryRun ? "would free" : "freeing"}: ${formatBytes(total)}`);

  if (dryRun || total === 0) return;

  await assertNextDevStopped();
  for (const target of targets) {
    const info = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw new Error(`refusing symbolic-link cache target: ${target}`);
    }
    if (info) await rm(target, { force: true, recursive: true });
  }

  console.log(`freed: ${formatBytes(total)}`);
}

main().catch((error) => {
  console.error(
    `clean:web-cache: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
