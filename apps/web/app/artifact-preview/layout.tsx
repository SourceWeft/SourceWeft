import type * as React from "react";

import { ClientMessagesProvider } from "../_components/client-messages-provider";

export default function ArtifactPreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClientMessagesProvider area="artifactPreview">
      {children}
    </ClientMessagesProvider>
  );
}
