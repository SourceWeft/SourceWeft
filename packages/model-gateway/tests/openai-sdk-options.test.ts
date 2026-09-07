import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Resolve the SDK that the installed LangChain adapter actually loads, so an
// upgrade or an unapplied patch cannot pass by testing a separate SDK copy.
const require = createRequire(import.meta.url);
const adapterRequire = createRequire(require.resolve("@langchain/openai"));
const sdkPath = adapterRequire.resolve("openai");
const formats = [
  ["CommonJS", adapterRequire("openai").OpenAI],
  [
    "ESM",
    (await import(pathToFileURL(sdkPath.replace(/\.js$/, ".mjs")).href)).OpenAI,
  ],
] as const;

async function withAmbientCredentials(run: () => Promise<void>) {
  const values = {
    OPENAI_API_KEY: "ambient-key-must-not-leak",
    OPENAI_ADMIN_KEY: "ambient-admin-must-not-leak",
    OPENAI_ORG_ID: "ambient-org-must-not-leak",
    OPENAI_PROJECT_ID: "ambient-project-must-not-leak",
    OPENAI_CUSTOM_HEADERS:
      "Authorization: Bearer ambient-header-must-not-leak\nX-Secret: ambient-secret-must-not-leak",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const [format, OpenAI] of formats) {
  test(`${format} SDK still rejects absent credentials unless explicitly enabled`, async () => {
    await withAmbientCredentials(async () => {
      for (const allowUnauthenticated of [undefined, false, "true"]) {
        assert.throws(
          () =>
            new OpenAI({
              baseURL: "http://127.0.0.1:11434/v1",
              apiKey: null,
              adminAPIKey: null,
              allowUnauthenticated,
            }),
          /Missing credentials/,
        );
      }
    });
  });

  test(`${format} SDK no-auth opt-in works without environment credentials or custom headers`, async () => {
    await withAmbientCredentials(async () => {
      let calls = 0;
      const client = new OpenAI({
        baseURL: "http://127.0.0.1:11434/v1",
        apiKey: null,
        adminAPIKey: null,
        organization: null,
        project: null,
        allowUnauthenticated: true,
        defaultHeaders: { "X-Explicit": "retained" },
        maxRetries: 0,
        fetch: async (_input: unknown, init: RequestInit) => {
          const headers = new Headers(init.headers);
          assert.equal(headers.get("authorization"), null);
          assert.equal(headers.get("api-key"), null);
          assert.equal(headers.get("openai-organization"), null);
          assert.equal(headers.get("openai-project"), null);
          assert.equal(headers.get("x-secret"), null);
          assert.equal(headers.get("x-explicit"), "retained");
          calls++;
          return Response.json({ object: "list", data: [] });
        },
      });
      await client.models.list();
      await client.withOptions({ timeout: 500 }).models.list();
      assert.equal(calls, 2);
    });
  });

  test(`${format} SDK isolates environment headers while preserving explicit authenticated headers`, async () => {
    await withAmbientCredentials(async () => {
      let calls = 0;
      const client = new OpenAI({
        baseURL: "http://127.0.0.1:11434/v1",
        apiKey: "byok-user-key",
        adminAPIKey: null,
        ignoreEnvironmentHeaders: true,
        defaultHeaders: { "X-Explicit": "retained" },
        maxRetries: 0,
        fetch: async (_input: unknown, init: RequestInit) => {
          const headers = new Headers(init.headers);
          assert.equal(headers.get("authorization"), "Bearer byok-user-key");
          assert.equal(headers.get("x-secret"), null);
          assert.equal(headers.get("x-explicit"), "retained");
          calls++;
          return Response.json({ object: "list", data: [] });
        },
      });
      await client.models.list();
      await client.withOptions({ timeout: 500 }).models.list();
      assert.equal(calls, 2);
    });
  });
}
