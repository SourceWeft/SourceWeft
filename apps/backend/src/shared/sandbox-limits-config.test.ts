import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DEPLOYMENT_LIMITS = {
  SOURCEWEFT_SANDBOX_MAX_PREPARE_FILE_BYTES: 10 * 1024 * 1024,
  SOURCEWEFT_SANDBOX_MAX_PREPARE_TOTAL_BYTES: 25 * 1024 * 1024,
  SOURCEWEFT_SANDBOX_MAX_COLLECT_FILE_BYTES: 25 * 1024 * 1024,
  SOURCEWEFT_SANDBOX_MAX_COLLECT_TOTAL_BYTES: 50 * 1024 * 1024,
} as const;

const repositoryFile = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)),
    "utf8",
  );

describe("sandbox deployment transfer limits", () => {
  it("keeps Compose and both example environments on the host defaults", () => {
    const compose = repositoryFile("docker/docker-compose.yml");
    const examples = [
      repositoryFile("docker/.env.example"),
      repositoryFile("apps/backend/.env.example"),
    ];

    for (const [name, bytes] of Object.entries(DEPLOYMENT_LIMITS)) {
      expect(compose).toContain(`${name}: \${${name}:-${bytes}}`);
      for (const example of examples) {
        expect(example).toContain(`${name}=${bytes}`);
      }
    }
  });
});
