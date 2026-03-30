import type { ConnectionOptions } from "bullmq";
import { config } from "./config";

function parseRedisUrl(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  const database = parsed.pathname
    ? Number(parsed.pathname.slice(1) || "0")
    : 0;

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isNaN(database) ? 0 : database,
    maxRetriesPerRequest: null,
  };
}

export const connectionOptions = parseRedisUrl(config.redisUrl);
