import assert from "node:assert/strict";
import { describe, test, vi, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  mail: { provider: "console" },
}));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: mockConfig,
}));
vi.mock("../../shared/logger", () => ({ logger: mockLogger }));

import { ConsoleMailProvider } from "./providers/console-provider";
import { PlunkApiProvider } from "./providers/plunk-provider";
import { MailService } from "./service";

afterEach(() => {
  mockConfig.mail.provider = "console";
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("MailService.createProvider (via constructor default)", () => {
  test('"console" returns ConsoleMailProvider', () => {
    mockConfig.mail.provider = "console";
    const svc = new MailService();
    assert.ok(svc["provider"] instanceof ConsoleMailProvider);
  });

  test('"noop" returns ConsoleMailProvider', () => {
    mockConfig.mail.provider = "noop";
    const svc = new MailService();
    assert.ok(svc["provider"] instanceof ConsoleMailProvider);
  });

  test('"plunk" returns PlunkApiProvider', () => {
    mockConfig.mail.provider = "plunk";
    const svc = new MailService();
    assert.ok(svc["provider"] instanceof PlunkApiProvider);
  });

  test("unknown provider throws", () => {
    mockConfig.mail.provider = "sendgrid";
    assert.throws(
      () => new MailService(),
      /^Error: Unsupported mail provider: sendgrid$/,
    );
  });
});

test("template rendering failures are logged before a provider is called", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PUBLIC_WEB_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_WEB_BASE_URL", "");
  vi.stubEnv("BASE_URL", "");
  const provider = {
    send: vi.fn(async () => ({
      accepted: true,
      provider: "test",
      messageIds: ["message-id"],
    })),
  };

  await assert.rejects(
    new MailService(provider).sendTemplate({
      to: "test@example.com",
      templateId: "auth.email-otp.sign-in",
      messageType: "auth.email-otp",
      variables: { otp: "000000" },
    }),
    /Set PUBLIC_WEB_BASE_URL/,
  );

  assert.equal(provider.send.mock.calls.length, 0);
  assert.equal(
    mockLogger.error.mock.calls[0]?.[0],
    "Mail template render failed",
  );
  assert.equal(
    mockLogger.error.mock.calls[0]?.[1]?.templateId,
    "auth.email-otp.sign-in",
  );
});
