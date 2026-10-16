import React from "react";
import { createRoot } from "react-dom/client";
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
createRoot(document.getElementById("root")!).render(
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
              downloadUrl: "/report.pdf?artifactVersionId=version-1&download=1",
              byteLength: 45,
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
