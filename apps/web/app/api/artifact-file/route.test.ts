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

  assert.equal(response.headers.get("content-type"), "application/octet-stream");
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
