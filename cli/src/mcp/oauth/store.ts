import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpInspectError } from "../../errors";
import { isRecord } from "../jsonrpc";

/**
 * What a sign-in leaves on the user's machine so the next run does not need
 * the browser: the client the server registered for this CLI and the tokens
 * it issued, one record per (endpoint, authorization server). Nothing here
 * ever leaves the machine except to the endpoint and the server that issued
 * it, and nothing is printed.
 */

export type StoredTokens = {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  /** Epoch ms the access token stops working at; absent when the server did not say. */
  expiresAt?: number;
};

export type StoredClient = {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
};

export type OAuthRecord = {
  version: 1;
  /** The endpoint the user passed, reduced to origin and path. */
  resource: string;
  /** The authorization server's issuer. */
  issuer: string;
  /** The token endpoint the client and tokens belong to; a changed one is not trusted with them. */
  tokenEndpoint: string;
  client: StoredClient;
  tokens?: StoredTokens;
};

export interface McpOAuthStore {
  load(resource: string, issuer: string): Promise<OAuthRecord | undefined>;
  save(record: OAuthRecord): Promise<void>;
  /**
   * Runs `work` while holding the record's lock, so two runs of the CLI do not
   * both spend one rotating refresh token. Waits for a holder; a lock left by
   * a crashed run is broken after a minute.
   */
  withLock<T>(resource: string, issuer: string, work: () => Promise<T>): Promise<T>;
  /** Removes every record for the endpoint; returns how many there were. */
  deleteResource(resource: string): Promise<number>;
}

/** The endpoint without query, fragment or userinfo — what keys a record. */
export function resourceKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

/** The directory the CLI keeps what it stores for the user in. */
export function defaultStoreDirectory(home: string = homedir()): string {
  return join(home, ".sourceweft", "mcp-oauth");
}

function isRecordFile(value: unknown): value is OAuthRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.resource === "string" &&
    typeof value.issuer === "string" &&
    typeof value.tokenEndpoint === "string" &&
    isRecord(value.client) &&
    typeof value.client.client_id === "string" &&
    (value.tokens === undefined ||
      (isRecord(value.tokens) && typeof value.tokens.access_token === "string"))
  );
}

/** One 0600 JSON file per record under a 0700 directory. */
export function createFileStore(directory: string): McpOAuthStore {
  const fileFor = (resource: string, issuer: string) =>
    join(
      directory,
      `${createHash("sha256").update(`${resource}\n${issuer}`).digest("hex")}.json`,
    );
  const read = async (file: string): Promise<OAuthRecord | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      return isRecordFile(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const ensureDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // `mkdir` leaves an existing directory's mode alone, and the process
    // umask can narrow the one it makes; Windows has no such modes.
    if (process.platform !== "win32") await chmod(directory, 0o700);
  };
  const lockWaitMs = 30_000;
  const lockStaleMs = 60_000;
  return {
    load: (resource, issuer) => read(fileFor(resource, issuer)),
    async withLock(resource, issuer, work) {
      await ensureDirectory();
      const lockFile = `${fileFor(resource, issuer)}.lock`;
      const deadline = Date.now() + lockWaitMs;
      for (;;) {
        try {
          const handle = await open(lockFile, "wx", 0o600);
          await handle.close();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const age = await stat(lockFile).then(
            (info) => Date.now() - info.mtimeMs,
            () => 0,
          );
          if (age > lockStaleMs) {
            await rm(lockFile, { force: true });
            continue;
          }
          if (Date.now() > deadline) {
            throw new McpInspectError(
              `Another sourceweft run is using this sign-in (${lockFile}); try again in a moment.`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      try {
        return await work();
      } finally {
        await rm(lockFile, { force: true });
      }
    },
    async save(record) {
      await ensureDirectory();
      const file = fileFor(record.resource, record.issuer);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, file);
    },
    async deleteResource(resource) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = join(directory, name);
        const record = await read(file);
        if (record?.resource === resource) {
          await rm(file, { force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}
