import {
  ParserContentError,
  textSourceParser as packageTextSourceParser,
} from "@sourceweft/builtin-document-parsers";
import { ContentError } from "../../content/errors";
import type { ParseInput, SourceParser } from "./types";

export const textSourceParser: SourceParser = {
  ...packageTextSourceParser,
  async parse(input: ParseInput) {
    try {
      return await packageTextSourceParser.parse(input);
    } catch (error) {
      if (error instanceof ParserContentError) {
        throw new ContentError(error.statusCode, error.code, error.message);
      }
      throw error;
    }
  },
};
