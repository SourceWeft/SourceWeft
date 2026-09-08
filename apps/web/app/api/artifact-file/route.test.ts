import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("artifact file proxy does not patch generic HTML previews", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      assert.match(url.toString(), /\/file$/);
      return new Response("<html><body>preview</body></html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
        status: 200,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1",
    ),
  );

  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /sandbox/);
  assert.match(csp, /script-src 'none'/);
  assert.doesNotMatch(csp, /allow-scripts/);
  assert.equal(await response.text(), "<html><body>preview</body></html>");
});

test("artifact file proxy downloads without patching HTML", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      assert.match(url.toString(), /\/download$/);
      return new Response("<html><body>raw</body></html>", {
        headers: {
          "content-disposition": "attachment; filename*=UTF-8''deck.html",
          "content-type": "text/html",
        },
        status: 200,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&download=1",
    ),
  );

  assert.equal(response.headers.get("content-type"), "text/html");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(
    response.headers.get("content-disposition"),
    "attachment; filename*=UTF-8''deck.html",
  );
  assert.equal(await response.text(), "<html><body>raw</body></html>");
});

test("artifact file proxy streams artifact assets", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      assert.match(
        url.toString(),
        /\/v1\/workspaces\/workspace-1\/artifacts\/artifact-1\/assets\/narration-slide-01\.mp3$/,
      );
      return new Response("audio-bytes", {
        headers: {
          "content-disposition":
            "inline; filename*=UTF-8''narration-slide-01.mp3",
          "content-type": "audio/mpeg",
        },
        status: 200,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&assetFileName=narration-slide-01.mp3",
    ),
  );

  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(
    response.headers.get("content-disposition"),
    "inline; filename*=UTF-8''narration-slide-01.mp3",
  );
  assert.equal(await response.text(), "audio-bytes");
});

test("artifact file proxy streams preview image assets", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      assert.match(
        url.toString(),
        /\/v1\/workspaces\/workspace-1\/artifacts\/artifact-1\/preview-image$/,
      );
      return new Response("jpeg-bytes", {
        headers: {
          "content-disposition": "inline; filename*=UTF-8''preview.jpg",
          "content-type": "image/jpeg",
        },
        status: 200,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&asset=previewImage",
    ),
  );

  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(
    response.headers.get("content-disposition"),
    "inline; filename*=UTF-8''preview.jpg",
  );
  assert.equal(await response.text(), "jpeg-bytes");
});

test("artifact file proxy rejects unknown semantic assets", async () => {
  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&asset=cover",
    ),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /asset must be previewImage/);
});

test("artifact file proxy does not treat missing content type as HTML", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      assert.match(url.toString(), /\/file$/);
      return new Response(new TextEncoder().encode("raw-bytes"), {
        status: 200,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1",
    ),
  );

  assert.equal(
    response.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(await response.text(), "raw-bytes");
});

test("artifact file proxy rejects nested artifact asset names", async () => {
  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&assetFileName=nested%2Ffile.mp3",
    ),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /flat artifact asset file name/);
});

test("artifact file proxy preserves exact-version video range responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      assert.match(
        url.toString(),
        /\/artifacts\/artifact-1\/versions\/version-1\/media\/video$/,
      );
      assert.equal(new Headers(init?.headers).get("range"), "bytes=4-7");
      return new Response(new Uint8Array([4, 5, 6, 7]), {
        headers: {
          "accept-ranges": "bytes",
          "content-length": "4",
          "content-range": "bytes 4-7/10",
          "content-type": "video/mp4",
          etag: '"sha256-video"',
        },
        status: 206,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&artifactVersionId=version-1&versionMedia=video",
      { headers: { Range: "bytes=4-7" } },
    ),
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 4-7/10");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("etag"), '"sha256-video"');
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-cache, max-age=0, must-revalidate",
  );
});

test("artifact file proxy preserves exact-version media 304 responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init?: RequestInit) => {
      assert.equal(
        new Headers(init?.headers).get("if-none-match"),
        '"sha256-video"',
      );
      return new Response(null, {
        headers: { etag: '"sha256-video"' },
        status: 304,
      });
    }),
  );

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost:3000/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&artifactVersionId=version-1&versionMedia=video",
      { headers: { "If-None-Match": '"sha256-video"' } },
    ),
  );

  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"sha256-video"');
});

test("registered HTML execution survives the proxy with exact bytes and version", async () => {
  const html = "<!doctype html><html><body>final</body></html>";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      assert.equal(url.searchParams.get("artifactVersionId"), "version-2");
      return new Response(html, {
        headers: {
          "content-type": "text/html",
          "x-sourceweft-artifact-execution": "sandboxed-html",
        },
      });
    }),
  );
  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(
      "http://localhost/api/artifact-file?workspaceId=w&artifactId=a&artifactVersionId=version-2",
    ),
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /sandbox allow-scripts/,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /connect-src 'none'/,
  );
  assert.doesNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /allow-same-origin/,
  );
  assert.equal(await response.text(), html);
});

test("an empty or ambiguous version never falls through to the current file", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { GET } = await import("./route");
  for (const suffix of [
    "artifactVersionId=",
    "artifactVersionId=v1&artifactVersionId=v2",
  ]) {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/artifact-file?workspaceId=w&artifactId=a&" +
          suffix,
      ),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});
