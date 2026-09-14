import { afterEach, expect, test, vi } from "vitest";
vi.mock("../../../lib/internal-api-base-url", () => ({
  internalApiBaseUrl: () => "http://api:3001",
}));
import { GET } from "./route";
afterEach(() => vi.unstubAllGlobals());
test("source preview forwards the session only to the private API and preserves original bytes", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response("file bytes", {
        headers: {
          "content-type": "text/plain",
          "content-security-policy": "sandbox",
        },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const response = await GET(
    new Request(
      "http://web:3000/api/source-file?workspaceId=w&sourceId=s&inline=true",
      { headers: { cookie: "session=test" } },
    ),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "http://api:3001/v1/workspaces/w/sources/s/download?inline=true",
    expect.objectContaining({
      redirect: "manual",
      headers: { cookie: "session=test" },
    }),
  );
  expect(await response.text()).toBe("file bytes");
  expect(response.headers.get("content-security-policy")).toBe("sandbox");
});
test("a missing resource identifier never dispatches an upstream request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect((await GET(new Request("http://web/api/source-file"))).status).toBe(
    400,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
