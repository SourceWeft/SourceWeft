/** Upload file-type vocabulary and helpers for the Add Source dialog. */

export const SOURCE_FILE_EXTENSIONS = [
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "adoc",
  "asciidoc",
  "org",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
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
  "java",
  "kt",
  "scala",
  "c",
  "h",
  "cpp",
  "cxx",
  "cc",
  "hpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "lua",
  "swift",
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
  "dockerfile",
  "makefile",
  "cmake",
  "tsv",
  "csv",
  "srt",
  "pdf",
  "doc",
  "docx",
  "pptx",
  "epub",
  "avif",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "gif",
  "flac",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "ogg",
  "wav",
  "webm",
] as const;

export const SOURCE_FILE_ACCEPT = SOURCE_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(
  ",",
);

export const SOURCE_FILE_EXTENSION_SET = new Set<string>(SOURCE_FILE_EXTENSIONS);

export function getUploadFileExtension(fileName: string) {
  const baseName = fileName.split(/[\\/]/).at(-1)?.trim().toLowerCase() ?? "";
  if (!baseName) return null;
  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (baseName === "makefile" || baseName.startsWith("makefile.")) {
    return "makefile";
  }
  if (baseName.startsWith(".env")) return "env";
  if (
    baseName.startsWith(".") &&
    SOURCE_FILE_EXTENSION_SET.has(baseName.slice(1))
  ) {
    return baseName.slice(1);
  }
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === baseName.length - 1) return null;
  return baseName.slice(dotIndex + 1);
}

export function getUploadFileLabel(file: File) {
  const extension = getUploadFileExtension(file.name);
  if (!extension) return "FILE";
  if (["pdf"].includes(extension)) return "PDF";
  if (["doc", "docx"].includes(extension)) return "DOC";
  if (["pptx"].includes(extension)) return "PPT";
  if (["epub"].includes(extension)) return "EPUB";
  if (["csv", "tsv"].includes(extension)) return "CSV";
  if (extension === "json") return "JSON";
  if (extension === "srt") return "SRT";
  if (
    [
      "avif",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "tif",
      "tiff",
      "bmp",
      "gif",
    ].includes(extension)
  ) {
    return "IMG";
  }
  if (
    [
      "flac",
      "mp3",
      "mp4",
      "mpeg",
      "mpga",
      "m4a",
      "ogg",
      "wav",
      "webm",
    ].includes(extension)
  ) {
    return "AUDIO";
  }
  return "TEXT";
}

export function isSupportedUploadFile(file: File) {
  const extension = getUploadFileExtension(file.name);
  if (extension && SOURCE_FILE_EXTENSION_SET.has(extension)) {
    return true;
  }
  return file.type.startsWith("text/");
}
