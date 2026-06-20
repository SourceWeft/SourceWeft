export type WorkfileCodeLanguage =
  | "bash"
  | "css"
  | "diff"
  | "html"
  | "javascript"
  | "json"
  | "jsx"
  | "log"
  | "markdown"
  | "python"
  | "shellscript"
  | "sql"
  | "toml"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml"
  | "yml";

export type WorkfileContentPreviewKind = "code" | "markdown" | "text";

export type WorkfileContentPreview = {
  contentText: string;
  fileName: string;
  kind: WorkfileContentPreviewKind;
  language: WorkfileCodeLanguage;
  lineCount: number;
  path: string;
};

const EXTENSION_LANGUAGE_MAP: Record<string, WorkfileCodeLanguage> = {
  bash: "bash",
  cjs: "javascript",
  css: "css",
  diff: "diff",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  log: "log",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  py: "python",
  sh: "shellscript",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yml",
  zsh: "shellscript",
};

const MIME_LANGUAGE_MAP: Record<string, WorkfileCodeLanguage> = {
  "application/javascript": "javascript",
  "application/json": "json",
  "application/toml": "toml",
  "application/typescript": "typescript",
  "application/x-javascript": "javascript",
  "application/x-sh": "shellscript",
  "application/x-yaml": "yaml",
  "application/xml": "xml",
  "text/css": "css",
  "text/html": "html",
  "text/javascript": "javascript",
  "text/markdown": "markdown",
  "text/plain": "log",
  "text/x-markdown": "markdown",
  "text/xml": "xml",
  "text/yaml": "yaml",
};

export function basename(path: string) {
  const cleaned = path.replace(/\/+$/, "");
  return cleaned.split("/").pop() || cleaned || path;
}

function extensionFromPath(path: string) {
  const fileName = basename(path).toLowerCase();
  if (fileName === "dockerfile") {
    return null;
  }
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension : null;
}

function normalizeMimeType(mimeType: string | null | undefined) {
  return mimeType?.split(";")[0]?.trim().toLowerCase() || null;
}

function lineCount(value: string) {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\r\n|\r|\n/).length;
}

export function resolveWorkfileCodeLanguage(input: {
  mimeType?: string | null;
  path: string;
}): WorkfileCodeLanguage {
  const extension = extensionFromPath(input.path);
  if (extension && EXTENSION_LANGUAGE_MAP[extension]) {
    return EXTENSION_LANGUAGE_MAP[extension];
  }

  const mimeType = normalizeMimeType(input.mimeType);
  if (mimeType && MIME_LANGUAGE_MAP[mimeType]) {
    return MIME_LANGUAGE_MAP[mimeType];
  }

  return "log";
}

export function resolveWorkfileContentPreview(input: {
  contentText: string;
  mimeType?: string | null;
  path: string;
}): WorkfileContentPreview {
  const language = resolveWorkfileCodeLanguage({
    mimeType: input.mimeType,
    path: input.path,
  });
  const kind: WorkfileContentPreviewKind =
    language === "markdown" ? "markdown" : language === "log" ? "text" : "code";

  return {
    contentText: input.contentText,
    fileName: basename(input.path),
    kind,
    language,
    lineCount: lineCount(input.contentText),
    path: input.path,
  };
}
