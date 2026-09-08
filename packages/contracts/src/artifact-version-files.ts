import { z } from "zod";
import { isSafeFlatArtifactAssetFileName } from "./artifact-urls";

export const artifactContentDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);

export const artifactFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      isSafeFlatArtifactAssetFileName(name) &&
      !/[\u0000-\u001f\u007f]/u.test(name),
    "Expected a flat artifact file name",
  );

/** Storage coordinates are host-owned and never sent to the browser. */
export const artifactVersionFileSchema = z
  .object({
    fileName: artifactFileNameSchema,
    contentType: z.string().trim().min(1),
    byteLength: z.number().int().positive(),
    contentDigest: artifactContentDigestSchema,
    storageBucket: z.string().nullable(),
    storageKey: z.string().min(1),
    role: z.enum(["primary", "preview", "asset", "source"]),
    access: z.enum(["artifact", "private"]),
  })
  .strict()
  .refine(
    (file) => file.role !== "source" || file.access === "private",
    "Authoring source must remain private",
  );

export const artifactVersionFilesSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(artifactVersionFileSchema).max(200),
  })
  .strict()
  .superRefine(({ files }, context) => {
    const names = new Set<string>();
    for (const [index, file] of files.entries()) {
      if (names.has(file.fileName)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "fileName"],
          message: "Duplicate version file name",
        });
      }
      names.add(file.fileName);
    }
    for (const role of ["primary", "preview"] as const) {
      if (files.filter((file) => file.role === role).length > 1) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: `At most one ${role} file is allowed`,
        });
      }
    }
  });

export type ArtifactVersionFile = z.infer<typeof artifactVersionFileSchema>;
export type ArtifactVersionFiles = z.infer<typeof artifactVersionFilesSchema>;

/** Absence means an older version has no recoverable file snapshot. */
export function parseArtifactVersionFiles(
  value: unknown,
): ArtifactVersionFiles | null {
  if (value === null || value === undefined) return null;
  return artifactVersionFilesSchema.parse(value);
}
