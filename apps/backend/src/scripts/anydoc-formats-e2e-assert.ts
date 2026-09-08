/** Manifest-driven live API checks for every uploaded AnyDoc format. No mocks. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const mode = process.argv[2] || "assert";
assert.ok(
  ["assert", "cleanup", "reparse"].includes(mode),
  "Expected assert, cleanup or reparse",
);
const manifest = z
  .object({
    workspaceId: z.string().uuid(),
    parserVersion: z.string().min(1),
    cases: z
      .array(
        z.object({
          sourceId: z.string().uuid(),
          fileName: z.string().min(1),
          detectedFormat: z.string().optional(),
          contains: z.array(z.string()).default([]),
          estimatedPages: z.number().int().nonnegative().optional(),
          pageCount: z.number().int().positive().optional(),
          expectedError: z.string().optional(),
        }),
      )
      .min(1),
  })
  .strict()
  .parse(JSON.parse(await readFile(required("E2E_CASES_PATH"), "utf8")));
assert.equal(
  new Set(manifest.cases.map((item) => item.sourceId)).size,
  manifest.cases.length,
  "Duplicate source IDs",
);
const base = process.env.E2E_API_URL || "http://localhost:3101";
assert.equal(
  new URL(base).origin,
  "http://localhost:3101",
  "Only the isolated local API is permitted",
);
const login = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "http://localhost:3100",
  },
  body: JSON.stringify({
    email: required("E2E_EMAIL"),
    password: required("E2E_PASSWORD"),
  }),
  signal: AbortSignal.timeout(30000),
});
assert.equal(login.status, 200, "Test account sign-in failed");
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert.ok(cookie, "Missing authenticated session");
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(
    `${base}/v1/workspaces/${manifest.workspaceId}${path}`,
    {
      method,
      headers: {
        cookie,
        origin: "http://localhost:3100",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    },
  );
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
if (mode === "reparse") {
  const selected = manifest.cases.find(
    (item) => item.fileName === required("E2E_REPARSE_FILE"),
  );
  assert.ok(
    selected && !selected.expectedError,
    "Choose a successful fixture from this manifest",
  );
  const before = await request(`/sources/${selected.sourceId}`);
  assert.equal(before.source.metadata.fileName, selected.fileName);
  const previousRevisions = new Set(
    before.revisions.map((revision: { id: string }) => revision.id),
  );
  await request(`/sources/${selected.sourceId}/reparse`, "POST", {
    forceRefresh: true,
  });
  const deadline = Date.now() + 60000;
  let completed = false;
  while (Date.now() < deadline) {
    const detail = await request(`/sources/${selected.sourceId}`);
    if (detail.source.status === "failed")
      throw new Error(`Reparse failed for ${selected.fileName}`);
    if (
      detail.source.status === "indexed" &&
      detail.revisions.some(
        (revision: { id: string }) => !previousRevisions.has(revision.id),
      )
    ) {
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(
    completed,
    "Reparse did not produce an indexed new revision within 60 seconds",
  );
}
const results: Record<string, unknown>[] = [];
let failures = 0;
for (const item of manifest.cases) {
  try {
    const detail = await request(`/sources/${item.sourceId}`);
    const source = detail.source;
    assert.equal(
      source.metadata.fileName,
      item.fileName,
      "Manifest filename does not match source",
    );
    if (mode === "cleanup") {
      await request(`/sources/${item.sourceId}`, "DELETE");
      if (process.env.E2E_DELETE_SOURCE_OBJECTS === "true") {
        const { deleteArtifactObjectsByPrefix } =
          await import("../modules/sources/storage");
        await deleteArtifactObjectsByPrefix({
          prefix: `workspaces/${manifest.workspaceId}/sources/${item.sourceId}/`,
          maxObjects: 5,
        });
      }
      results.push({ fileName: item.fileName, deleted: true });
      continue;
    }
    const { content } = await request(`/sources/${item.sourceId}/content`);
    assert.equal(source.parserVersion, manifest.parserVersion);
    assert.equal(
      source.metadata.providerTaskId ?? null,
      null,
      "This round must not submit new OCR tasks",
    );
    if (item.expectedError) {
      assert.equal(source.status, "failed");
      const error = source.error ?? source.metadata.error;
      const message = typeof error === "string" ? error : error?.message;
      assert.ok(
        typeof message === "string" && message.includes(item.expectedError),
        "Expected actionable failure is missing",
      );
    } else {
      assert.equal(source.status, "indexed");
      assert.equal(source.metadata.documentParseEntryEngine, "anydoc");
      assert.equal(source.metadata.documentParseProviderResolved, "anydoc");
      assert.equal(source.metadata.parserEngine, "anydoc");
      if (item.detectedFormat)
        assert.equal(source.metadata.detectedFormat, item.detectedFormat);
      if (item.estimatedPages !== undefined)
        assert.equal(source.estimatedPages, item.estimatedPages);
      if (item.pageCount !== undefined)
        assert.equal(source.metadata.pageCount, item.pageCount);
      for (const expected of item.contains)
        assert.ok(
          content.includes(expected),
          `Missing fixture content: ${expected}`,
        );
      assert.ok(detail.chunks.length > 0, "No indexed chunks returned");
    }
    results.push({
      fileName: item.fileName,
      passed: true,
      status: source.status,
      backend: source.metadata.documentParseProviderResolved ?? null,
      format: source.metadata.detectedFormat ?? null,
      chunkCount: detail.chunks.length,
      estimatedPages: source.estimatedPages,
    });
  } catch (error) {
    failures++;
    results.push({
      fileName: item.fileName,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
const report = {
  timestamp: new Date().toISOString(),
  mode,
  parserVersion: manifest.parserVersion,
  failures,
  results,
};
const directory = new URL(
  "../../../../output/playwright/anydoc-formats/",
  import.meta.url,
);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL(`api-${mode}-results.json`, directory),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (failures) process.exitCode = 1;
