import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

beforeEach(() => {
  for (const name of [
    "DOCUMENT_PARSE_STRATEGY",
    "DOCUMENT_PARSE_PROVIDER",
    "DOCUMENT_PARSE_OCR_ENABLED",
    "DOCUMENT_PARSE_OCR_PROVIDER",
    "DOCUMENT_PARSE_IMAGE_STRATEGY",
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-auth-secret-at-least-32-chars");
  vi.stubEnv(
    "MODEL_GATEWAY_ENCRYPTION_SECRET",
    "test-model-secret-at-least-32-chars",
  );
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("AnyDoc selection is explicit and an OCR credential never enables its OCR branch", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", " ANYDOC ");
  vi.stubEnv("PDF2MARKDOWN_API_KEY", "test-key-never-output");
  const { config } = await import("./config");
  assert.equal(config.documentParsing.provider, "anydoc");
  assert.equal(config.documentParsing.ocrEnabled, false);
  assert.equal(config.documentParsing.ocrProvider, "pdf2markdown");
  assert.equal(config.documentParsing.imageStrategy, "vision");
});

for (const [value, expected] of [
  ["true", true],
  ["  TRUE ", true],
  ["1", true],
  ["false", false],
  [" 0 ", false],
] as const) {
  test(`OCR activation strictly parses ${JSON.stringify(value)}`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", value);
    const { config } = await import("./config");
    assert.equal(config.documentParsing.ocrEnabled, expected);
  });
}

for (const [name, value] of [
  ["DOCUMENT_PARSE_OCR_ENABLED", "yes"],
  ["DOCUMENT_PARSE_OCR_ENABLED", ""],
  ["DOCUMENT_PARSE_OCR_PROVIDER", "firecrawl"],
  ["DOCUMENT_PARSE_OCR_PROVIDER", ""],
  ["DOCUMENT_PARSE_IMAGE_STRATEGY", "vision_then_ocr"],
  ["DOCUMENT_PARSE_IMAGE_STRATEGY", ""],
]) {
  test(`invalid ${name} fails configuration loading`, async () => {
    vi.stubEnv(name!, value!);
    await assert.rejects(import("./config"), new RegExp(name!));
  });
}

test("an explicit image OCR policy and provider normalize case and whitespace", async () => {
  vi.stubEnv("DOCUMENT_PARSE_IMAGE_STRATEGY", " OCR ");
  vi.stubEnv("DOCUMENT_PARSE_OCR_PROVIDER", " PDF2MARKDOWN ");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  const { config } = await import("./config");
  assert.equal(config.documentParsing.imageStrategy, "ocr");
  assert.equal(config.documentParsing.ocrProvider, "pdf2markdown");
  assert.equal(config.documentParsing.ocrEnabled, true);
});

test("Docker and backend examples agree on explicit migration and OCR defaults", () => {
  const backend = readFileSync(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  const docker = readFileSync(
    new URL("../../../../docker/.env.example", import.meta.url),
    "utf8",
  );
  const compose = readFileSync(
    new URL("../../../../docker/docker-compose.yml", import.meta.url),
    "utf8",
  );
  for (const [name, value] of Object.entries({
    DOCUMENT_PARSE_PROVIDER: "pdf2markdown",
    DOCUMENT_PARSE_OCR_ENABLED: "false",
    DOCUMENT_PARSE_OCR_PROVIDER: "pdf2markdown",
    DOCUMENT_PARSE_IMAGE_STRATEGY: "vision",
  })) {
    assert.ok(backend.includes(`${name}=${value}`));
    assert.ok(docker.includes(`${name}=${value}`));
    assert.ok(compose.includes(`${name}: ${"${"}${name}:-${value}}`));
  }
});

test("misspelled legacy strategy fails instead of selecting a different routing strategy", async () => {
  vi.stubEnv("DOCUMENT_PARSE_STRATEGY", "balaned");
  await assert.rejects(
    import("./config"),
    /DOCUMENT_PARSE_STRATEGY must be one of/,
  );
});

test("legacy strategy normalizes an explicit supported value", async () => {
  vi.stubEnv("DOCUMENT_PARSE_STRATEGY", " BALANCED ");
  const { config } = await import("./config");
  assert.equal(config.documentParsing.strategy, "balanced");
});
