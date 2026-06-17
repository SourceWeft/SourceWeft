import { epubSourceParser as packageEpubSourceParser } from "@sourceweft/builtin-document-parsers";
import { toBackendSourceParser } from "./types";

export const epubSourceParser = toBackendSourceParser(packageEpubSourceParser);
