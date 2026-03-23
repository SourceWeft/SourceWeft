"use client";

import { useChat } from "@ai-sdk/react";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@polyer/ui/components/ai-elements/message";

/** AI Elements live in `packages/ui`; `useChat` from `@ai-sdk/react` runs in the app. */
export function AiElementsDemo() {
  const { messages } = useChat();

  return (
    <section className="w-full max-w-xl rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
      <h2 className="mb-2 text-lg font-semibold">AI Elements (@polyer/ui)</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Chat hook (app): {messages.length} message{messages.length === 1 ? "" : "s"}{" "}
        — wire <code className="rounded bg-muted px-1">sendMessage</code> to your API route.
      </p>
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            Static assistant copy from the shared UI package — add streaming when your route is
            ready.
          </MessageResponse>
        </MessageContent>
      </Message>
    </section>
  );
}
