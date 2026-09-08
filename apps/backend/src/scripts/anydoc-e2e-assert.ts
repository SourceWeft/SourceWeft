/** Real HTTP assertions; no parser, OCR, storage or embedding mocks. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const base = process.env.E2E_API_URL || "http://localhost:3101";
assert.equal(
  new URL(base).hostname,
  "localhost",
  "This runner targets only the isolated local E2E API",
);
assert.equal(new URL(base).port, "3101");
const workspace = required("E2E_WORKSPACE_ID");
const mode = process.argv[2] || "assert";
assert.ok(
  ["assert", "pending", "cleanup"].includes(mode),
  "Expected assert, pending or cleanup",
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
assert.ok(cookie, "No session cookie returned");
async function request(path: string, method = "GET") {
  const response = await fetch(`${base}/v1/workspaces/${workspace}${path}`, {
    method,
    headers: { cookie, origin: "http://localhost:3100" },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${method} ${path} returned ${response.status}`);
  return await response.json();
}
const ids = {
  docx: required("E2E_DOCX_SOURCE_ID"),
  textPdf: required("E2E_TEXT_SOURCE_ID"),
  ocrPdf: required("E2E_OCR_SOURCE_ID"),
};
if (mode === "cleanup") {
  const cleanupIds = [
    ...Object.values(ids),
    ...(process.env.E2E_EXTRA_SOURCE_IDS || "").split(",").filter(Boolean),
  ];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  assert.match(workspace, uuid);
  for (const id of cleanupIds) assert.match(id, uuid);
  for (const id of cleanupIds) await request(`/sources/${id}`, "DELETE");
  console.log(
    `Deleted ${cleanupIds.length} explicitly selected test source records through the authenticated API.`,
  );
  // The current source-delete API does not remove stored source objects.
  if (process.env.E2E_DELETE_SOURCE_OBJECTS === "true") {
    const { deleteArtifactObjectsByPrefix } =
      await import("../modules/sources/storage");
    for (const id of cleanupIds)
      await deleteArtifactObjectsByPrefix({
        prefix: `workspaces/${workspace}/sources/${id}/`,
        maxObjects: 5,
      });
    console.log(
      "Removed objects only within the explicitly selected test source prefixes.",
    );
  }
} else {
  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    transport: "real authenticated HTTP",
    cases: {},
  };
  const cases = report.cases as Record<string, unknown>;
  for (const [kind, id] of Object.entries(ids)) {
    const detail = await request(`/sources/${id}`);
    const content = await request(`/sources/${id}/content`);
    const source = detail.source;
    const metadata = source.metadata;
    assert.equal(metadata.documentParseEntryEngine, "anydoc");
    assert.equal(source.parserVersion, "v3-anydoc-0.2.4");
    if (kind === "ocrPdf") {
      assert.equal(metadata.documentParseProviderResolved, "pdf2markdown");
      assert.equal(
        metadata.providerTaskId,
        required("E2E_OCR_TASK_ID"),
        "OCR task changed after worker restart",
      );
      if (mode === "pending") {
        assert.equal(source.status, "processing");
        assert.equal(
          metadata.documentParsePending.token.taskId,
          required("E2E_OCR_TASK_ID"),
        );
      } else {
        assert.equal(source.status, "indexed");
        assert.match(content.content, /cobalt lantern orchard/i);
        assert.match(content.content, /4321[.,]75/);
      }
    } else {
      assert.equal(source.status, "indexed");
      assert.equal(metadata.documentParseProviderResolved, "anydoc");
      assert.equal(metadata.pageLocationAvailable, false);
      if (kind === "docx") {
        assert.equal(source.estimatedPages, 1);
        assert.equal(metadata.billingPageCount, 1);
        assert.match(content.content, /中文测试/);
        assert.match(content.content, /1234\.56/);
      } else {
        assert.equal(source.estimatedPages, 2);
        assert.equal(metadata.pageCount, 2);
        assert.match(content.content, /alpha 1234/);
        assert.match(content.content, /beta 5678/);
      }
    }
    cases[kind] = {
      status: source.status,
      parserVersion: source.parserVersion,
      estimatedPages: source.estimatedPages,
      entryEngine: metadata.documentParseEntryEngine,
      backend: metadata.documentParseProviderResolved,
      taskId: metadata.providerTaskId ?? null,
      passed: true,
    };
  }
  const directory = new URL(
    "../../../../output/playwright/anydoc/",
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL(`api-${mode}-assertions.json`, directory),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
