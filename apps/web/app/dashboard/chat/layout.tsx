import type * as React from "react";

import ChatWorkspaceShell from "./_components/chat-workspace-shell";

export default function DashboardChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ChatWorkspaceShell>{children}</ChatWorkspaceShell>;
}
