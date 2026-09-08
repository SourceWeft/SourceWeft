import {
  isAnydocMimeType,
  parseWithAnydoc,
} from "@sourceweft/builtin-document-parsers";
import type { DocumentParseProvider } from "./types";

export const anydocProvider: DocumentParseProvider = {
  id: "anydoc",
  supports: isAnydocMimeType,
  async start(input) {
    const document = await parseWithAnydoc(input);
    return { kind: "completed", document };
  },
};
