import { ContentError } from "../content/errors";

export type SourceFileKind =
  | "text"
  | "table"
  | "json"
  | "transcript"
  | "document"
  | "image"
  | "audio";

export type SourceFileClassification = {
  supported: true;
  kind: SourceFileKind;
  extension: string | null;
  mimeType: string;
  originalMimeType: string | null;
  label: string;
};

export type UnsupportedSourceFileClassification = {
  supported: false;
  extension: string | null;
  mimeType: string | null;
  reason: string;
};

type SourceFileRule = {
  kind: SourceFileKind;
  mimeType: string;
  label: string;
};

const genericMimeTypes = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

const textExtensions = [
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "adoc",
  "asciidoc",
  "org",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "jsonc",
  "xml",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "svg",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "pyw",
  "pyi",
  "pyx",
  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "c",
  "h",
  "cpp",
  "cxx",
  "cc",
  "hpp",
  "hxx",
  "cs",
  "fs",
  "fsx",
  "go",
  "rs",
  "rb",
  "php",
  "pl",
  "pm",
  "lua",
  "swift",
  "m",
  "mm",
  "r",
  "jl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "cmd",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "tex",
  "bib",
  "log",
  "vue",
  "svelte",
  "astro",
  "tf",
  "hcl",
  "proto",
  "env",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "npmrc",
  "gitattributes",
  "prettierrc",
  "eslintrc",
  "babelrc",
  "dockerfile",
  "makefile",
  "cmake",
  "tsv",
] as const;

const textMimeByExtension: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  xml: "application/xml",
  svg: "image/svg+xml",
  css: "text/css",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "application/typescript",
  tsx: "application/typescript",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  jsonl: "text/plain",
  ndjson: "text/plain",
  tsv: "text/tab-separated-values",
};

const extensionRules: Partial<Record<string, SourceFileRule>> = {
  ...Object.fromEntries(
    textExtensions.map((extension) => [
      extension,
      {
        kind: "text",
        mimeType:
          textMimeByExtension[
            extension as keyof typeof textMimeByExtension
          ] ?? "text/plain",
        label: "Text",
      } satisfies SourceFileRule,
    ]),
  ),
  csv: { kind: "table", mimeType: "text/csv", label: "CSV" },
  json: { kind: "json", mimeType: "application/json", label: "JSON" },
  srt: { kind: "transcript", mimeType: "text/srt", label: "Subtitle" },
  pdf: { kind: "document", mimeType: "application/pdf", label: "PDF" },
  doc: { kind: "document", mimeType: "application/msword", label: "Word" },
  docx: {
    kind: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
  },
  pptx: {
    kind: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "Slides",
  },
  epub: { kind: "document", mimeType: "application/epub+zip", label: "EPUB" },
  avif: { kind: "image", mimeType: "image/avif", label: "Image" },
  png: { kind: "image", mimeType: "image/png", label: "Image" },
  jpg: { kind: "image", mimeType: "image/jpeg", label: "Image" },
  jpeg: { kind: "image", mimeType: "image/jpeg", label: "Image" },
  webp: { kind: "image", mimeType: "image/webp", label: "Image" },
  tif: { kind: "image", mimeType: "image/tiff", label: "Image" },
  tiff: { kind: "image", mimeType: "image/tiff", label: "Image" },
  bmp: { kind: "image", mimeType: "image/bmp", label: "Image" },
  gif: { kind: "image", mimeType: "image/gif", label: "Image" },
  flac: { kind: "audio", mimeType: "audio/flac", label: "Audio" },
  mp3: { kind: "audio", mimeType: "audio/mpeg", label: "Audio" },
  mp4: { kind: "audio", mimeType: "audio/mp4", label: "Audio" },
  mpeg: { kind: "audio", mimeType: "audio/mpeg", label: "Audio" },
  mpga: { kind: "audio", mimeType: "audio/mpeg", label: "Audio" },
  m4a: { kind: "audio", mimeType: "audio/mp4", label: "Audio" },
  ogg: { kind: "audio", mimeType: "audio/ogg", label: "Audio" },
  wav: { kind: "audio", mimeType: "audio/wav", label: "Audio" },
  webm: { kind: "audio", mimeType: "audio/webm", label: "Audio" },
};

const mimeRules: Partial<Record<string, SourceFileRule>> = {
  "text/plain": { kind: "text", mimeType: "text/plain", label: "Text" },
  "text/markdown": {
    kind: "text",
    mimeType: "text/markdown",
    label: "Text",
  },
  "text/x-markdown": {
    kind: "text",
    mimeType: "text/x-markdown",
    label: "Text",
  },
  "text/html": { kind: "text", mimeType: "text/html", label: "Text" },
  "application/xhtml+xml": {
    kind: "text",
    mimeType: "application/xhtml+xml",
    label: "Text",
  },
  "application/xml": {
    kind: "text",
    mimeType: "application/xml",
    label: "Text",
  },
  "text/xml": { kind: "text", mimeType: "text/xml", label: "Text" },
  "image/svg+xml": {
    kind: "text",
    mimeType: "image/svg+xml",
    label: "Text",
  },
  "text/css": { kind: "text", mimeType: "text/css", label: "Text" },
  "text/javascript": {
    kind: "text",
    mimeType: "text/javascript",
    label: "Text",
  },
  "application/javascript": {
    kind: "text",
    mimeType: "application/javascript",
    label: "Text",
  },
  "application/typescript": {
    kind: "text",
    mimeType: "application/typescript",
    label: "Text",
  },
  "application/x-typescript": {
    kind: "text",
    mimeType: "application/x-typescript",
    label: "Text",
  },
  "application/yaml": {
    kind: "text",
    mimeType: "application/yaml",
    label: "Text",
  },
  "application/x-yaml": {
    kind: "text",
    mimeType: "application/x-yaml",
    label: "Text",
  },
  "application/jsonl": {
    kind: "text",
    mimeType: "text/plain",
    label: "Text",
  },
  "application/x-ndjson": {
    kind: "text",
    mimeType: "text/plain",
    label: "Text",
  },
  "text/yaml": { kind: "text", mimeType: "text/yaml", label: "Text" },
  "application/toml": {
    kind: "text",
    mimeType: "application/toml",
    label: "Text",
  },
  "text/tab-separated-values": {
    kind: "text",
    mimeType: "text/tab-separated-values",
    label: "Text",
  },
  "text/csv": { kind: "table", mimeType: "text/csv", label: "CSV" },
  "application/csv": {
    kind: "table",
    mimeType: "application/csv",
    label: "CSV",
  },
  "application/json": {
    kind: "json",
    mimeType: "application/json",
    label: "JSON",
  },
  "application/x-subrip": {
    kind: "transcript",
    mimeType: "application/x-subrip",
    label: "Subtitle",
  },
  "text/srt": { kind: "transcript", mimeType: "text/srt", label: "Subtitle" },
  "application/srt": {
    kind: "transcript",
    mimeType: "application/srt",
    label: "Subtitle",
  },
  "application/pdf": {
    kind: "document",
    mimeType: "application/pdf",
    label: "PDF",
  },
  "application/x-pdf": {
    kind: "document",
    mimeType: "application/pdf",
    label: "PDF",
  },
  "application/acrobat": {
    kind: "document",
    mimeType: "application/pdf",
    label: "PDF",
  },
  "applications/vnd.pdf": {
    kind: "document",
    mimeType: "application/pdf",
    label: "PDF",
  },
  "application/msword": {
    kind: "document",
    mimeType: "application/msword",
    label: "Word",
  },
  "application/vnd.ms-word": {
    kind: "document",
    mimeType: "application/msword",
    label: "Word",
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    kind: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "Slides",
  },
  "application/epub+zip": {
    kind: "document",
    mimeType: "application/epub+zip",
    label: "EPUB",
  },
  "image/avif": { kind: "image", mimeType: "image/avif", label: "Image" },
  "image/png": { kind: "image", mimeType: "image/png", label: "Image" },
  "image/x-png": { kind: "image", mimeType: "image/png", label: "Image" },
  "image/jpeg": { kind: "image", mimeType: "image/jpeg", label: "Image" },
  "image/jpg": { kind: "image", mimeType: "image/jpeg", label: "Image" },
  "image/webp": { kind: "image", mimeType: "image/webp", label: "Image" },
  "image/tiff": { kind: "image", mimeType: "image/tiff", label: "Image" },
  "image/bmp": { kind: "image", mimeType: "image/bmp", label: "Image" },
  "image/x-ms-bmp": { kind: "image", mimeType: "image/bmp", label: "Image" },
  "image/gif": { kind: "image", mimeType: "image/gif", label: "Image" },
  "audio/flac": { kind: "audio", mimeType: "audio/flac", label: "Audio" },
  "audio/mpeg": { kind: "audio", mimeType: "audio/mpeg", label: "Audio" },
  "audio/mp3": { kind: "audio", mimeType: "audio/mpeg", label: "Audio" },
  "audio/mp4": { kind: "audio", mimeType: "audio/mp4", label: "Audio" },
  "audio/m4a": { kind: "audio", mimeType: "audio/mp4", label: "Audio" },
  "audio/x-m4a": { kind: "audio", mimeType: "audio/mp4", label: "Audio" },
  "audio/ogg": { kind: "audio", mimeType: "audio/ogg", label: "Audio" },
  "audio/wav": { kind: "audio", mimeType: "audio/wav", label: "Audio" },
  "audio/wave": { kind: "audio", mimeType: "audio/wav", label: "Audio" },
  "audio/x-wav": { kind: "audio", mimeType: "audio/wav", label: "Audio" },
  "audio/webm": { kind: "audio", mimeType: "audio/webm", label: "Audio" },
  "video/mp4": { kind: "audio", mimeType: "video/mp4", label: "Audio" },
  "video/webm": { kind: "audio", mimeType: "video/webm", label: "Audio" },
};

const compatibleExtensionsByMimeType: Partial<Record<string, readonly string[]>> = {
  "application/pdf": ["pdf"],
  "application/x-pdf": ["pdf"],
  "application/acrobat": ["pdf"],
  "applications/vnd.pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.ms-word": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "pptx",
  ],
  "application/epub+zip": ["epub"],
  "image/avif": ["avif"],
  "image/png": ["png"],
  "image/x-png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/jpg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/tiff": ["tif", "tiff"],
  "image/bmp": ["bmp"],
  "image/x-ms-bmp": ["bmp"],
  "image/gif": ["gif"],
  "audio/flac": ["flac"],
  "audio/mpeg": ["mp3", "mpeg", "mpga"],
  "audio/mp3": ["mp3"],
  "audio/mp4": ["mp4", "m4a"],
  "audio/m4a": ["m4a"],
  "audio/x-m4a": ["m4a"],
  "audio/ogg": ["ogg"],
  "audio/wav": ["wav"],
  "audio/wave": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/webm": ["webm"],
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
};

function normalizeMimeType(value: string | null | undefined) {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (genericMimeTypes.has(mimeType)) {
    return null;
  }
  return mimeType;
}

function getBaseName(fileName: string) {
  return fileName.split(/[\\/]/).at(-1)?.trim() || fileName.trim();
}

export function getSourceFileExtension(fileName: string) {
  const baseName = getBaseName(fileName).toLowerCase();
  if (!baseName) {
    return null;
  }
  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (baseName === "makefile" || baseName.startsWith("makefile.")) {
    return "makefile";
  }
  if (baseName.startsWith(".env")) {
    return "env";
  }
  if (baseName.startsWith(".") && extensionRules[baseName.slice(1)]) {
    return baseName.slice(1);
  }
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === baseName.length - 1) {
    return null;
  }
  return baseName.slice(dotIndex + 1);
}

function buildSupportedClassification(input: {
  rule: SourceFileRule;
  extension: string | null;
  mimeType: string;
  originalMimeType: string | null;
}): SourceFileClassification {
  return {
    supported: true,
    kind: input.rule.kind,
    extension: input.extension,
    mimeType: input.mimeType,
    originalMimeType: input.originalMimeType,
    label: input.rule.label,
  };
}

function resolveMimeTypeForExtensionRule(input: {
  extensionRule: SourceFileRule;
  mimeRule: SourceFileRule;
  normalizedMimeType: string;
}) {
  if (input.extensionRule.kind === "text") {
    return input.extensionRule.mimeType !== "text/plain"
      ? input.extensionRule.mimeType
      : input.mimeRule.mimeType;
  }

  if (
    input.extensionRule.kind === "audio" &&
    input.normalizedMimeType.startsWith("video/")
  ) {
    return input.mimeRule.mimeType;
  }

  return input.extensionRule.mimeType;
}

function isGenericTextMime(mimeType: string | null) {
  return mimeType === "text/plain" || Boolean(mimeType?.startsWith("text/"));
}

function isCompatibleMimeForExtension(input: {
  extension: string;
  extensionRule: SourceFileRule;
  mimeType: string;
  mimeRule: SourceFileRule;
}) {
  if (input.extensionRule.kind === input.mimeRule.kind) {
    const compatibleExtensions = compatibleExtensionsByMimeType[input.mimeType];
    if (
      ["audio", "document", "image"].includes(input.extensionRule.kind) &&
      compatibleExtensions
    ) {
      return compatibleExtensions.includes(input.extension);
    }
    return true;
  }

  return (
    ["text", "table", "json", "transcript"].includes(input.extensionRule.kind) &&
    input.mimeRule.kind === "text" &&
    isGenericTextMime(input.mimeType)
  );
}

function unsupported(input: {
  extension: string | null;
  mimeType: string | null;
  reason: string;
}): UnsupportedSourceFileClassification {
  return {
    supported: false,
    extension: input.extension,
    mimeType: input.mimeType,
    reason: input.reason,
  };
}

export function classifySourceFile(input: {
  fileName: string;
  mimeType?: string | null;
}): SourceFileClassification | UnsupportedSourceFileClassification {
  const extension = getSourceFileExtension(input.fileName);
  const extensionRule = extension ? extensionRules[extension] : undefined;
  const normalizedMimeType = normalizeMimeType(input.mimeType);
  const mimeRule = normalizedMimeType ? mimeRules[normalizedMimeType] : undefined;

  if (extensionRule) {
    if (normalizedMimeType && mimeRule) {
      if (
        !isCompatibleMimeForExtension({
          extension: extension!,
          extensionRule,
          mimeType: normalizedMimeType,
          mimeRule,
        })
      ) {
        return unsupported({
          extension,
          mimeType: normalizedMimeType,
          reason:
            `MIME type '${normalizedMimeType}' does not match file extension '.${extension}'`,
        });
      }

      return buildSupportedClassification({
        rule: extensionRule,
        extension,
        mimeType: resolveMimeTypeForExtensionRule({
          extensionRule,
          mimeRule,
          normalizedMimeType,
        }),
        originalMimeType: normalizedMimeType,
      });
    }

    if (normalizedMimeType && !mimeRule) {
      if (
        ["document", "image", "audio"].includes(extensionRule.kind) ||
        (!normalizedMimeType.startsWith("text/") &&
          normalizedMimeType !== "application/octet-stream")
      ) {
        return unsupported({
          extension,
          mimeType: normalizedMimeType,
          reason:
            `Unsupported MIME type '${normalizedMimeType}' for file extension '.${extension}'`,
        });
      }
    }

    if (
      normalizedMimeType &&
      extensionRule.kind === "audio" &&
      normalizedMimeType.startsWith("audio/")
    ) {
      return unsupported({
        extension,
        mimeType: normalizedMimeType,
        reason:
          `Unsupported audio MIME type '${normalizedMimeType}' for file extension '.${extension}'`,
      });
    }

    return buildSupportedClassification({
      rule: extensionRule,
      extension,
      mimeType: extensionRule.mimeType,
      originalMimeType: normalizedMimeType,
    });
  }

  if (mimeRule) {
    return buildSupportedClassification({
      rule: mimeRule,
      extension: null,
      mimeType: mimeRule.mimeType,
      originalMimeType: normalizedMimeType,
    });
  }

  if (normalizedMimeType?.startsWith("text/")) {
    return buildSupportedClassification({
      rule: {
        kind: "text",
        mimeType: "text/plain",
        label: "Text",
      },
      extension: null,
      mimeType: "text/plain",
      originalMimeType: normalizedMimeType,
    });
  }

  return unsupported({
    extension,
    mimeType: normalizedMimeType,
    reason: extension
      ? `Unsupported file extension '.${extension}'`
      : "Unsupported file type",
  });
}

export function requireSupportedSourceFile(input: {
  fileName: string;
  mimeType?: string | null;
}) {
  const classification = classifySourceFile(input);
  if (classification.supported) {
    return classification;
  }

  throw new ContentError(
    400,
    "UNSUPPORTED_SOURCE_TYPE",
    `${classification.reason}. Supported formats include PDF, DOC/DOCX, PPTX, EPUB, common text/code files, CSV, JSON, SRT, images, and DeepInfra ASR audio formats (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm).`,
  );
}

export function assertTextLikeSourceContent(content: Buffer, fileName: string) {
  const sampleLength = Math.min(content.length, 8192);
  let nullBytes = 0;
  let controlBytes = 0;

  for (let index = 0; index < sampleLength; index += 1) {
    const byte = content[index] ?? 0;
    if (byte === 0) {
      nullBytes += 1;
    } else if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controlBytes += 1;
    }
  }

  if (nullBytes > 0 || (sampleLength > 0 && controlBytes / sampleLength > 0.3)) {
    throw new ContentError(
      400,
      "UNSUPPORTED_SOURCE_TYPE",
      `File '${fileName}' appears to be binary and cannot be parsed as text`,
    );
  }
}

export function assertSourceContentCanBeParsed(input: {
  classification: SourceFileClassification;
  content: Buffer;
  fileName: string;
}) {
  if (
    ["text", "table", "json", "transcript"].includes(input.classification.kind)
  ) {
    assertTextLikeSourceContent(input.content, input.fileName);
  }
}

export function listSupportedSourceFileExtensions() {
  return Object.keys(extensionRules).sort();
}
