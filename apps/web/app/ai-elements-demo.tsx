"use client";

import { useChat } from "@ai-sdk/react";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@polyer/ui-web/components/ai-elements/message";

export function AiElementsDemo() {
  const { messages } = useChat({});

  return (
    <section className="flex w-full max-w-xl flex-col gap-4 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
      <h2 className="text-lg font-semibold">
        AI Elements (packages/ui, package: @polyer/ui-web)
      </h2>
      <p className="text-sm text-muted-foreground">
        Static preview.{" "}
        <code className="rounded bg-muted px-1 py-0.5">useChat</code> from{" "}
        <code className="rounded bg-muted px-1 py-0.5">@ai-sdk/react</code> is
        wired in this client component ({messages.length} messages until you add
        an API route).
      </p>
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            Hello from `@polyer/ui-web` ai-elements.
          </MessageResponse>
        </MessageContent>
      </Message>
    </section>
  );
}
