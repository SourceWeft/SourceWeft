import { srtSourceParser as packageSrtSourceParser } from "@sourceweft/builtin-document-parsers";
import { toBackendSourceParser } from "./types";

export const srtSourceParser = toBackendSourceParser(packageSrtSourceParser);
