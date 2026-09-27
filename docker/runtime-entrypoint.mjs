import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function runtimeEnvironment(input) {
  const env = { ...input };
  for (const key of [
    "DB_PASSWORD",
    "S3_SECRET_ACCESS_KEY",
    "BETTER_AUTH_SECRET",
    "MODEL_GATEWAY_ENCRYPTION_SECRET",
  ]) {
    if (env[key] === "GENERATED_BY_INIT")
      throw new Error(
        `Initialize .env before starting: ${key} still contains a template marker`,
      );
  }
  for (const key of [
    "PUBLIC_WEB_BASE_URL",
    "PUBLIC_API_BASE_URL",
    "INTERNAL_API_BASE_URL",
  ]) {
    if (!env[key]) continue;
    const url = new URL(env[key]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        `${key} must be an HTTP(S) base URL without credentials, query or fragment`,
      );
  }
  if (
    !env.DATABASE_URL &&
    ["DB_USER", "DB_PASSWORD", "DB_NAME", "DB_HOST"].some((key) => env[key])
  ) {
    for (const key of ["DB_USER", "DB_PASSWORD", "DB_NAME"])
      if (!env[key])
        throw new Error(`${key} is required when DATABASE_URL is not set`);
    env.DATABASE_URL = `postgresql://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_PASSWORD)}@${env.DB_HOST || "postgres"}:${env.DB_PORT || "5432"}/${encodeURIComponent(env.DB_NAME)}`;
  }
  return env;
}
/** The Web server the image runs by default (the Dockerfile CMD). */
export const WEB_SERVER_SCRIPT = "/app/web-standalone/apps/web/server.js";

/**
 * The step a backend container runs before its command: bring the database
 * schema up to date (or, with MIGRATION_ENABLED=false, check it) under the
 * migration lock, whatever the backend command is. Two kinds of container skip
 * it: the Web server, which only reads the database and does not carry the
 * backend's configuration, and a container with no database — utility commands
 * such as `pnpm --version`.
 */
export function databasePreparationCommand(env, command = []) {
  if (!env.DATABASE_URL) return null;
  if (command.includes(WEB_SERVER_SCRIPT)) return null;
  return [
    process.execPath,
    [
      fileURLToPath(new URL("../apps/backend/dist/launch.js", import.meta.url)),
      "prepare",
    ],
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("A service command is required");
  const env = runtimeEnvironment(process.env);
  let child = null;
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      stopping = true;
      child?.kill(signal);
    });
  const run = (file, fileArgs) =>
    new Promise((resolve) => {
      child = spawn(file, fileArgs, { env, stdio: "inherit" });
      child.on("error", (error) => {
        console.error(error.message);
        resolve(1);
      });
      child.on("exit", (code, signal) => {
        child = null;
        resolve(code ?? (signal === "SIGTERM" ? 143 : 1));
      });
    });

  const preparation = databasePreparationCommand(env, [command, ...args]);
  const prepared = preparation ? await run(...preparation) : 0;
  // A failed preparation, or a stop during it, ends the container before its
  // command starts.
  process.exit(
    prepared !== 0 || stopping ? prepared || 143 : await run(command, args),
  );
}
