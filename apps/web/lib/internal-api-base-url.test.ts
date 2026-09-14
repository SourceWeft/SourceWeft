import { afterEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { internalApiBaseUrl } from "./internal-api-base-url";
afterEach(() => vi.unstubAllEnvs());
test("SSR uses the explicit private API endpoint independently of browser URLs", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("INTERNAL_API_BASE_URL", "http://api:3001/");
  vi.stubEnv("PUBLIC_API_BASE_URL", "https://notes.example");
  expect(internalApiBaseUrl()).toBe("http://api:3001");
});
test("production SSR fails on missing internal URL instead of requesting localhost or the public host", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("INTERNAL_API_BASE_URL", "");
  expect(() => internalApiBaseUrl()).toThrow("INTERNAL_API_BASE_URL");
});

test("development keeps an explicitly configured separate API port", () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("INTERNAL_API_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:3401");
  expect(internalApiBaseUrl()).toBe("http://localhost:3401");
});
