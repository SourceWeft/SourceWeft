"use client";

import type { ReactNode } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
} from "@sourceweft/ui-web/components/ai-elements/code-block";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import {
  Snippet,
  SnippetCopyButton,
  SnippetInput,
} from "@sourceweft/ui-web/components/ai-elements/snippet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  type WorkfileCodeLanguage,
  resolveWorkfileContentPreview,
} from "./workfile-content-preview";

export type WorkfileContentViewerProps = {
  className?: string;
  contentText: string;
  defaultMode?: "preview" | "source";
  mimeType?: string | null;
  path: string;
};

export function WorkfilePathSnippet({
  action,
  className,
  path,
}: {
  action?: ReactNode;
  className?: string;
  path: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 sm:flex-row sm:items-center",
        className,
      )}
    >
      <Snippet className="min-w-0 flex-1" code={path}>
        <SnippetInput aria-label="Workfile path" className="min-w-0 text-xs" />
        <SnippetCopyButton />
      </Snippet>
      {action}
    </div>
  );
}

export function WorkfileCodeBlock({
  className,
  code,
  fileName,
  language,
  showLineNumbers = true,
}: {
  className?: string;
  code: string;
  fileName: string;
  language: WorkfileCodeLanguage;
  showLineNumbers?: boolean;
}) {
  return (
    <CodeBlock
      className={cn("overflow-hidden text-xs", className)}
      code={code}
      language={language}
      showLineNumbers={showLineNumbers}
    >
      <CodeBlockHeader>
        <CodeBlockFilename>{fileName}</CodeBlockFilename>
        <CodeBlockActions>
          <CodeBlockCopyButton
            aria-label="Copy preview"
            className="size-7"
            size="icon"
          />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

function WorkfileMarkdownPreview({
  className,
  contentText,
}: {
  className?: string;
  contentText: string;
}) {
  return (
    <MessageResponse
      className={cn(
        "text-sm leading-7 text-foreground",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse",
        "[&_td]:border [&_td]:px-3 [&_td]:py-2",
        "[&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left",
        className,
      )}
    >
      {contentText}
    </MessageResponse>
  );
}

export function WorkfileContentViewer({
  className,
  contentText,
  defaultMode,
  mimeType,
  path,
}: WorkfileContentViewerProps) {
  const preview = resolveWorkfileContentPreview({
    contentText,
    mimeType,
    path,
  });
  const sourceBlock = (
    <WorkfileCodeBlock
      className="h-full max-h-full"
      code={preview.contentText}
      fileName={preview.fileName}
      language={preview.language}
    />
  );

  if (preview.kind !== "markdown") {
    return <div className={cn("h-full", className)}>{sourceBlock}</div>;
  }

  return (
    <Tabs
      className={cn("flex h-full min-h-0 flex-col", className)}
      defaultValue={defaultMode ?? "preview"}
    >
      <TabsList className="mb-3 grid w-fit grid-cols-2">
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="source">Source</TabsTrigger>
      </TabsList>
      <TabsContent
        className="min-h-0 flex-1 overflow-auto rounded-md border bg-background px-4 py-3"
        value="preview"
      >
        <WorkfileMarkdownPreview contentText={preview.contentText} />
      </TabsContent>
      <TabsContent className="min-h-0 flex-1 overflow-hidden" value="source">
        {sourceBlock}
      </TabsContent>
    </Tabs>
  );
}
