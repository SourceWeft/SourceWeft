import { docxSourceParser as packageDocxSourceParser } from "@sourceweft/builtin-document-parsers";
import { toBackendSourceParser } from "./types";

export const docxSourceParser = toBackendSourceParser(packageDocxSourceParser);
