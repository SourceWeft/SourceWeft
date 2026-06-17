import { csvSourceParser as packageCsvSourceParser } from "@sourceweft/builtin-document-parsers";
import { toBackendSourceParser } from "./types";

export const csvSourceParser = toBackendSourceParser(packageCsvSourceParser);
