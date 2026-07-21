import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";

export const builtinDocumentParsersCapabilityManifest: CapabilityManifestInput = {
  schemaVersion: 1,
  id: "sourceweft/document-parsers",
  kind: "document_parser",
  name: "SourceWeft Document Parsers",
  version: "0.1.0",
  entry: "./src/index.ts",
  documentParsers: [
      {
        id: "workspace-documents",
        title: "Workspace Document Parsers",
      },
  ],
};
