import { jsonSourceParser as packageJsonSourceParser } from "@sourceweft/builtin-document-parsers";
import { toBackendSourceParser } from "./types";

export const jsonSourceParser = toBackendSourceParser(packageJsonSourceParser);
