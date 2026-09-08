import {
  JSONLinesLoader,
  JSONLoader,
} from "@langchain/classic/document_loaders/fs/json";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";

export function createJsonLoader(file: string | Blob, mimeType?: string) {
  if (mimeType === "application/x-ndjson" || mimeType === "application/jsonl") {
    return new JSONLinesLoader(file, "/");
  }
  return new JSONLoader(file);
}

export function createTextLoader(file: string | Blob) {
  return new TextLoader(file);
}
