import { pptxSourceParser as packagePptxSourceParser } from "@sourceweft/builtin-document-parsers";
import { toBackendSourceParser } from "./types";

export const pptxSourceParser = toBackendSourceParser(packagePptxSourceParser);
