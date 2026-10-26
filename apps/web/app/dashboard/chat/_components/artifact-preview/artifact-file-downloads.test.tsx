// @vitest-environment jsdom

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ArtifactFileDownloads } from "@sourceweft/builtin-tool-publish-artifact/ui";
import {
  HtmlPreview,
  type HtmlPreviewFile,
} from "../../../../../../../packages/builtin-tool-publish-artifact/src/ui/html-preview";
import { artifactPreviewRenderers } from "./preview-registry";
import { mount, unmountAll } from "@/test/react";

vi.mock("@sourceweft/preview/react", () => ({
  Preview: ({
    source,
  }: {
    source: { name: string; mimeType?: string; url: string };
  }) => (
    <div
      data-testid="medium-preview"
      data-name={source.name}
      data-mime={source.mimeType}
      data-url={source.url}
    />
  ),
}));

afterEach(unmountAll);

const files: HtmlPreviewFile[] = [
  {
    fileName: "report.html",
    role: "primary",
    url: "/inline?v=2",
    downloadUrl: "/primary?v=2&download=1",
    byteLength: 124,
  },
  {
    fileName: "report.pdf",
    role: "asset",
    url: "/pdf?v=2",
    downloadUrl: "/pdf?v=2&download=1",
  },
  {
    fileName: "draft.json",
    url: null,
    role: "source",
    access: "private",
    downloadUrl: "/secret",
  },
  {
    fileName: "private.pdf",
    url: null,
    role: "asset",
    access: "private",
    downloadUrl: "/private",
  },
  {
    fileName: "preview.jpg",
    url: null,
    role: "preview",
    downloadUrl: "/preview",
  },
  { fileName: "missing.docx", role: "asset", url: "/inline-only" },
  {
    fileName: "unsafe.pdf",
    url: null,
    role: "asset",
    downloadUrl: "javascript:alert(1)",
  },
];

test("download list renders exact projected primary and asset links without private files", async () => {
  const { container } = await mount(<ArtifactFileDownloads files={files} />);
  assert.deepEqual(
    [...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ["/primary?v=2&download=1", "/pdf?v=2&download=1"],
  );
  assert.match(container.textContent ?? "", /124 bytes/);
  assert.doesNotMatch(
    container.textContent ?? "",
    /draft|private|preview|missing|unsafe/,
  );
});

test("HTML preview exposes all projected formats and retains its pinned iframe", async () => {
  const { container } = await mount(
    <HtmlPreview
      fileUrl="/inline?v=2"
      downloadUrl="/primary?v=2&download=1"
      title="Report"
      files={files}
    />,
  );
  assert.equal(
    container.querySelector("iframe")?.getAttribute("src"),
    // The pinned version is kept; `runtime=1` asks the host for the injected
    // link and storage runtime.
    "/inline?v=2&runtime=1",
  );
  assert.equal(
    container
      .querySelector('a[aria-label="Download report.pdf"]')
      ?.getAttribute("href"),
    "/pdf?v=2&download=1",
  );
  assert.equal(
    container.querySelectorAll('a[href="/primary?v=2&download=1"]').length,
    1,
  );
  assert.doesNotMatch(container.textContent ?? "", /draft.json|private.pdf/);
});

test("legacy or malformed projections render no invented download links", async () => {
  const { container, render } = await mount(
    <ArtifactFileDownloads files={undefined} />,
  );
  assert.equal(container.querySelector("nav"), null);
  await render(
    <ArtifactFileDownloads
      files={{ fileName: "report.pdf", downloadUrl: "/fake" }}
    />,
  );
  assert.equal(container.querySelector("a"), null);
});

test("generic file preview wrapper renders the same projected downloads", async () => {
  const renderer = artifactPreviewRenderers.find(
    (item) => item.id === "file-preview",
  )!;
  const { container } = await mount(
    <>
      {renderer.render({
        artifact: { status: "ready", storageKey: "report.bin" },
        proxyFileUrl: "/file?artifactVersionId=v2",
        title: "Report",
        payload: { versionFiles: files },
      } as never)}
    </>,
  );
  assert.equal(
    container
      .querySelector('a[aria-label="Download report.pdf"]')
      ?.getAttribute("href"),
    "/pdf?v=2&download=1",
  );
  assert.doesNotMatch(container.textContent ?? "", /draft.json|private.pdf/);
});

test("generic preview uses primary manifest metadata over a conflicting title without requiring downloadUrl", async () => {
  const renderer = artifactPreviewRenderers.find(
    (item) => item.id === "file-preview",
  )!;
  const { container, render } = await mount(
    <>
      {renderer.render({
        artifact: { status: "ready", storageKey: null },
        proxyFileUrl: "/exact?v=2",
        title: "report.md",
        payload: {
          versionFiles: [
            {
              fileName: "private.txt",
              role: "primary",
              access: "private",
              contentType: "text/plain",
            },
            {
              fileName: "report.pdf",
              role: "primary",
              url: "/exact?v=2",
              contentType: "application/pdf",
            },
          ],
        },
      } as never)}
    </>,
  );
  const preview = container.querySelector('[data-testid="medium-preview"]')!;
  assert.equal(preview.getAttribute("data-name"), "report.pdf");
  assert.equal(preview.getAttribute("data-mime"), "application/pdf");
  assert.equal(preview.getAttribute("data-url"), "/exact?v=2");
  await render(
    <>
      {renderer.render({
        artifact: { status: "ready", storageKey: "old/report.docx" },
        proxyFileUrl: "/legacy",
        title: "report.md",
        payload: {},
      } as never)}
    </>,
  );
  assert.equal(
    container
      .querySelector('[data-testid="medium-preview"]')
      ?.getAttribute("data-name"),
    "report.docx",
  );
});
