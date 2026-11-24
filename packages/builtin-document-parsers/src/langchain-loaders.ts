import { TextLoader } from "@langchain/classic/document_loaders/fs/text";

export function createTextLoader(file: string | Blob) {
  return new TextLoader(file);
}
