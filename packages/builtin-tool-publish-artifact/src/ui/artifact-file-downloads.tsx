"use client";

import { z } from "zod";
import { artifactFileNameSchema } from "@sourceweft/contracts/artifact-version-files";
import { Download } from "lucide-react";

const primaryPreviewFileSchema = z.object({
  fileName: artifactFileNameSchema,
  role: z.literal("primary"),
  access: z.literal("artifact").optional(),
  contentType: z.string().min(1).optional(),
});

/** Preview metadata comes from the authorized version manifest, independently of downloads. */
export function artifactPrimaryPreviewFile(value: unknown) {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const parsed = primaryPreviewFileSchema.safeParse(entry);
    if (parsed.success) return parsed.data;
  }
  return null;
}

const projectedFileSchema = z.object({
  fileName: z.string().min(1),
  role: z.enum(["primary", "asset"]),
  access: z.literal("artifact").optional(),
  downloadUrl: z
    .string()
    .refine(
      (url) =>
        /^https?:\/\//i.test(url) ||
        (url.startsWith("/") && !url.startsWith("//")),
    ),
  byteLength: z.number().int().positive().optional(),
});

/** Only host-projected deliverables have authority to become download links. */
export function artifactDownloadFiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = projectedFileSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function ArtifactFileDownloads({ files }: { files: unknown }) {
  const downloads = artifactDownloadFiles(files);
  if (!downloads.length) return null;
  return (
    <nav
      aria-label="Download files"
      className="flex shrink-0 flex-wrap gap-2 border-b bg-muted/20 px-3 py-2"
    >
      {downloads.map((file) => (
        <a
          key={file.fileName}
          href={file.downloadUrl}
          rel="noopener"
          aria-label={`Download ${file.fileName}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
        >
          <Download className="size-3.5 shrink-0" />
          <span className="truncate">{file.fileName}</span>
          {file.byteLength !== undefined && (
            <span className="shrink-0 text-muted-foreground">
              ({file.byteLength.toLocaleString()} bytes)
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
