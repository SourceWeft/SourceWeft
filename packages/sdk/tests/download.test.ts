import assert from "node:assert/strict";
import test from "node:test";
import { ContentClient } from "../src/content-client";
import { HttpClient } from "../src/http-client";

function withFetch(response: Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return response;
  }) as typeof fetch;
  return run()
    .then(() => urls)
    .finally(() => {
      globalThis.fetch = original;
    });
}

test("getDownload reads the UTF-8 file name before the ASCII fallback", async () => {
  const http = new HttpClient({ baseUrl: "https://api.test/" });
  let result: { blob: Blob; fileName: string | null } | undefined;

  const urls = await withFetch(
    new Response("# 预算\n", {
      headers: {
        "content-disposition":
          "attachment; filename=\"__.md\"; filename*=UTF-8''%E9%A2%84%E7%AE%97.md",
      },
    }),
    async () => {
      result = await http.getDownload("/v1/x");
    },
  );

  assert.deepEqual(urls, ["https://api.test/v1/x"]);
  assert.equal(result?.fileName, "预算.md");
  assert.equal(await result?.blob.text(), "# 预算\n");
});

test("getDownload falls back to the plain file name, or null", async () => {
  const http = new HttpClient({ baseUrl: "https://api.test" });
  let plain: string | null | undefined;
  await withFetch(
    new Response("x", {
      headers: { "content-disposition": 'attachment; filename="Plan.md"' },
    }),
    async () => {
      plain = (await http.getDownload("/v1/x")).fileName;
    },
  );
  assert.equal(plain, "Plan.md");

  let none: string | null | undefined;
  await withFetch(new Response("x"), async () => {
    none = (await http.getDownload("/v1/x")).fileName;
  });
  assert.equal(none, null);
});

test("exportThread asks for the chat's export with locale and time zone", async () => {
  const paths: string[] = [];
  const client = new ContentClient({
    getDownload: async (path: string) => {
      paths.push(path);
      return { blob: new Blob(["x"]), fileName: "a.md" };
    },
  } as never);

  const result = await client.exportThread("ws / 1", "t 1", {
    locale: "zh-TW",
    timeZone: "Asia/Taipei",
  });

  assert.equal(result.fileName, "a.md");
  assert.deepEqual(paths, [
    "/v1/workspaces/ws%20%2F%201/threads/t%201/export?locale=zh-TW&timeZone=Asia%2FTaipei",
  ]);
});
