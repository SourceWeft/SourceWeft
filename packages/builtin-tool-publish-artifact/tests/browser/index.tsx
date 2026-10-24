import React from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactRecordsTransport } from "@sourceweft/contracts/artifact-records";
import { HtmlPreview } from "../../src/ui/html-preview";
const presentation = new URLSearchParams(location.search).has("plain")
  ? undefined
  : {
      protocol: "presentation/v1" as const,
      pages: [
        { id: "first", title: "Overview" },
        { id: "second", title: "Details" },
      ],
    };
// Storage mode: an in-memory backend on the host page, so records outlive the
// iframe (reloads and navigation) exactly as server-side records would.
const records = new Map<string, unknown>();
const storageTransport: ArtifactRecordsTransport = {
  async execute(operation) {
    const key = `${operation.scope}:${operation.collection}:${"id" in operation ? operation.id : ""}`;
    if (operation.op === "get")
      return {
        op: "get",
        record: records.has(key)
          ? {
              id: operation.id,
              data: records.get(key),
              etag: "fixture-etag",
              createdAt: "",
              updatedAt: "",
            }
          : null,
      };
    if (operation.op === "set") {
      records.set(key, operation.data);
      return { op: "set", etag: "fixture-etag", updatedAt: "" };
    }
    if (operation.op === "delete")
      return { op: "delete", deleted: records.delete(key) };
    return { op: "query", records: [], cursor: null };
  },
};
const root = createRoot(document.getElementById("root")!);
if (new URLSearchParams(location.search).has("storage")) {
  root.render(
    <HtmlPreview
      title="Storage fixture"
      fileUrl="/storage.html?artifactVersionId=version-1"
      downloadUrl={null}
      storage={{ storage: true, shared: false }}
      records={storageTransport}
    />,
  );
} else
  root.render(
    <HtmlPreview
      title="Independent HTML producer"
      fileUrl={
        presentation
          ? "/document.html?artifactVersionId=version-1"
          : "/plain.html?artifactVersionId=version-1"
      }
      downloadUrl="/document.html?download=1&artifactVersionId=version-1"
      files={
        new URLSearchParams(location.search).has("files")
          ? [
              {
                fileName: "report.html",
                role: "primary",
                url: "/document.html?artifactVersionId=version-1",
                downloadUrl:
                  "/document.html?download=1&artifactVersionId=version-1",
              },
              {
                fileName: "report.pdf",
                role: "asset",
                url: "/report.pdf?artifactVersionId=version-1",
                downloadUrl:
                  "/report.pdf?artifactVersionId=version-1&download=1",
                byteLength: 50,
              },
              {
                fileName: "source.json",
                role: "source",
                access: "private",
                url: "/source.json",
                downloadUrl: "/source.json?download=1",
              },
            ]
          : []
      }
      presentation={presentation}
    />,
  );
