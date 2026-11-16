import { test, expect, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * End-to-end check for voice dictation (#589) in a real Chromium, with the
 * microphone replaced by Chromium's fake audio-capture device fed the
 * generated three-burst WAV (e2e/fixtures/make-dictation-audio.mjs). Both
 * dictation routes are stubbed with page.route, so these checks do not need
 * a real transcription model, but the audio itself is real: the composer
 * only receives text because the speech segmenter
 * (packages/ui/src/lib/audio/speech-segmenter.ts) cut genuinely captured
 * frames into segments, which the first test also confirms by checking each
 * posted segment's own WAV duration. Runs against the isolated skill test
 * deployment and seeded accounts described in e2e/README.md.
 */

const web = process.env.SKILL_E2E_WEB_URL ?? "http://localhost:3310";
const accounts = JSON.parse(
  readFileSync(resolve("../backend/.skills-e2e-accounts.json"), "utf8"),
) as Record<string, { email: string; password: string }>;

// apps/web/e2e/dictation.spec.ts -> repository root, the same root
// fixtures/make-dictation-audio.mjs writes under.
const AUDIO_PATH = resolve(
  "../../output/playwright/dictation/three-bursts.wav",
);
if (!existsSync(AUDIO_PATH)) {
  throw new Error(
    `Missing fake-microphone fixture at ${AUDIO_PATH}. Generate it first: ` +
      `node e2e/fixtures/make-dictation-audio.mjs (run from apps/web).`,
  );
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${AUDIO_PATH}%noloop`,
    ],
  },
});

// The text each stubbed segment answers with, indexed by its seq.
const SEGMENT_TEXT = ["第一句。", "second sentence.", "third one."];

type MultipartField = {
  name: string | undefined;
  filename: string | undefined;
  content: Buffer;
};

/** Parses a multipart/form-data body into its named fields (no dependency needed: content-client.ts posts plain FormData). */
function parseMultipart(
  body: Buffer,
  contentType: string | null,
): MultipartField[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  if (!match) {
    throw new Error("dictation segment request had no multipart boundary");
  }
  const boundary = (match[1] ?? match[2])!;
  const boundaryBuf = Buffer.from(`--${boundary}`);

  const fields: MultipartField[] = [];
  let start = body.indexOf(boundaryBuf) + boundaryBuf.length;
  for (;;) {
    const next = body.indexOf(boundaryBuf, start);
    if (next === -1) break;
    const part = body.subarray(start, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      let content = part.subarray(headerEnd + 4);
      if (content.subarray(content.length - 2).toString("ascii") === "\r\n") {
        content = content.subarray(0, content.length - 2);
      }
      fields.push({
        name: /name="([^"]+)"/.exec(headerText)?.[1],
        filename: /filename="([^"]+)"/.exec(headerText)?.[1],
        content: Buffer.from(content),
      });
    }
    start = next + boundaryBuf.length;
    if (body.subarray(start, start + 2).toString("ascii") === "--") break;
  }
  return fields;
}

/** Duration of a 44-byte-header canonical WAV (packages/ui/src/lib/audio/wav.ts). */
function wavDurationSec(wav: Buffer): number {
  const sampleRate = wav.readUInt32LE(24);
  const dataSize = wav.readUInt32LE(40);
  return dataSize / 2 / sampleRate;
}

async function signIn(
  browser: Browser,
): Promise<
  Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>>
> {
  const context = await browser.newContext({ baseURL: web });
  try {
    const page = await context.newPage();
    await page.goto("/auth/sign-in", { timeout: 180_000 });
    await page.getByLabel("Email", { exact: true }).fill(accounts.owner!.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(accounts.owner!.password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout: 60_000 });
    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function stubAvailability(page: Page, available: boolean): Promise<void> {
  await page.route("**/dictation", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { available } });
  });
}

function dictationButton(page: Page) {
  return page.locator('[data-dictation-button="true"]');
}

function editor(page: Page) {
  return page.locator('[data-prompt-input-editor="true"]');
}

let session: Awaited<ReturnType<typeof signIn>>;

test.beforeAll(async ({ browser }) => {
  session = await signIn(browser);
});

test("three spoken bursts appear in the composer in order", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: web, storageState: session });
  const page = await context.newPage();
  await stubAvailability(page, true);

  const seen = new Map<number, { sessionId: string; wavDurationSec: number }>();
  // seq 1 is answered first; seq 0's handler waits for it, so the test proves
  // the client reorders by seq rather than by arrival.
  let resolveSeq1: () => void;
  const seq1Answered = new Promise<void>((r) => (resolveSeq1 = r));
  await page.route("**/dictation/segments", async (route) => {
    const request = route.request();
    const body = request.postDataBuffer();
    if (!body) {
      await route.fulfill({
        status: 400,
        json: { code: "DICTATION_INVALID_AUDIO", message: "empty body" },
      });
      return;
    }
    const fields = parseMultipart(body, request.headers()["content-type"] ?? null);
    const seq = Number(
      fields.find((f) => f.name === "seq")?.content.toString("utf8"),
    );
    const sessionId = fields.find((f) => f.name === "sessionId")?.content.toString("utf8") ?? "";
    const file = fields.find((f) => f.name === "file");
    seen.set(seq, {
      sessionId,
      wavDurationSec: file ? wavDurationSec(file.content) : 0,
    });

    if (seq === 0) {
      await seq1Answered;
    }
    await route.fulfill({ json: { text: SEGMENT_TEXT[seq] ?? "", durationSec: 1 } });
    if (seq === 1) {
      resolveSeq1();
    }
  });

  await page.goto("/dashboard/chat");
  await dictationButton(page).click();
  await expect(editor(page)).toHaveText(
    "第一句。second sentence. third one.",
    { timeout: 20_000 },
  );

  // Stop dictation so the test does not leave the fake capture running.
  await dictationButton(page).click();
  await expect(dictationButton(page)).toHaveAttribute("aria-label", "Dictate");

  expect([...seen.keys()].sort()).toEqual([0, 1, 2]);
  const sessionIds = new Set([...seen.values()].map((v) => v.sessionId));
  expect(sessionIds.size).toBe(1);
  for (const { wavDurationSec: duration } of seen.values()) {
    expect(duration).toBeGreaterThanOrEqual(2);
    expect(duration).toBeLessThanOrEqual(3);
  }

  await context.close();
});

test("send during dictation stops it and sends nothing", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: web, storageState: session });
  const page = await context.newPage();
  await stubAvailability(page, true);
  await page.route("**/dictation/segments", async (route) => {
    const request = route.request();
    const body = request.postDataBuffer();
    const fields = body
      ? parseMultipart(body, request.headers()["content-type"] ?? null)
      : [];
    const seq = Number(
      fields.find((f) => f.name === "seq")?.content.toString("utf8"),
    );
    await route.fulfill({ json: { text: SEGMENT_TEXT[seq] ?? "", durationSec: 1 } });
  });

  const threadRequests: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      /\/threads(\/|\?|$)/.test(new URL(req.url()).pathname)
    ) {
      threadRequests.push(req.url());
    }
  });

  await page.goto("/dashboard/chat");
  await dictationButton(page).click();
  // Wait until the first result is in the editor, then send while dictation is
  // still active. More segments may still be arriving, so match on "contains".
  await expect(editor(page)).toContainText(SEGMENT_TEXT[0]!, { timeout: 20_000 });

  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Send during dictation stops it and sends nothing; the composer is kept.
  // The second burst can still be landing, so do not race an exact text match:
  // assert no thread was started, the button is back to Dictate, and the first
  // result is still present.
  await expect(dictationButton(page)).toHaveAttribute("aria-label", "Dictate", {
    timeout: 20_000,
  });
  expect(threadRequests).toEqual([]);
  await expect(editor(page)).toContainText(SEGMENT_TEXT[0]!);

  await context.close();
});

test("without the profile there is no microphone button", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: web, storageState: session });
  const page = await context.newPage();
  await stubAvailability(page, false);

  await page.goto("/dashboard/chat");
  // Give the composer a chance to render before asserting absence.
  await expect(
    page.getByRole("button", { name: "Add image", exact: true }),
  ).toBeVisible();
  await expect(dictationButton(page)).toHaveCount(0);

  await context.close();
});

test("a 402 stops dictation and shows the credits notice", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: web, storageState: session });
  const page = await context.newPage();
  await stubAvailability(page, true);
  await page.route("**/dictation/segments", async (route) => {
    await route.fulfill({
      status: 402,
      json: {
        code: "DICTATION_INSUFFICIENT_CREDITS",
        message: "The team has no credits left to cover the accrued audio.",
      },
    });
  });

  await page.goto("/dashboard/chat");
  await dictationButton(page).click();

  await expect(
    page.getByText("Not enough credits to keep dictating.", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(dictationButton(page)).toHaveAttribute("aria-label", "Dictate");

  await context.close();
});

test("the page is served with microphone=(self)", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: web, storageState: session });
  const page = await context.newPage();
  await stubAvailability(page, false);

  const response = await page.goto("/dashboard/chat");
  expect(response).not.toBeNull();
  expect(response!.headers()["permissions-policy"]).toBe(
    "camera=(), microphone=(self), geolocation=()",
  );

  await context.close();
});
