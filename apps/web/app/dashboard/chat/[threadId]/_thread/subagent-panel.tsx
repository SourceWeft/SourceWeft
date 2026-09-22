"use client";

import { Bot, ChevronDown, ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { buildEmbedThreadPath } from "../../../../../lib/thread-embed-params";
import type { ChatHubSubagentPanel } from "../../_components/chat-hub-context";

/**
 * A sub-agent conversation shown beside its parent. The child is a thread of
 * its own, so the panel simply frames that thread's route in embed mode: the
 * composer, streaming, and approvals inside are the real thread page, and the
 * parent page keeps its own active thread untouched.
 */
export function SubagentPanel({
  className,
  panel,
}: {
  className?: string;
  panel: ChatHubSubagentPanel;
}) {
  const t = useTranslations("dashboardChat.subagent");
  const current =
    panel.siblings.find((sibling) => sibling.id === panel.threadId) ?? null;
  const title = current?.title ?? panel.title;
  const canSwitch = panel.siblings.length > 1;

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden bg-background",
        className,
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
        {canSwitch ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="h-8 min-w-0 max-w-[60%] justify-start gap-1.5 px-2"
                size="sm"
                title={t("switchTitle")}
                type="button"
                variant="ghost"
              >
                <Bot className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{title}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {panel.siblings.map((sibling) => (
                <DropdownMenuItem
                  key={sibling.id}
                  className={cn(
                    sibling.id === panel.threadId && "bg-accent/60",
                  )}
                  onSelect={() => panel.onSelect(sibling.id)}
                >
                  <Bot className="size-4" />
                  <span className="truncate">{sibling.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 px-2">
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{title}</span>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            className="size-8 text-muted-foreground"
            onClick={() => panel.onOpenInNewWindow(panel.threadId)}
            size="icon-sm"
            title={t("openInNewWindow")}
            type="button"
            variant="ghost"
          >
            <ExternalLink className="size-4" />
            <span className="sr-only">{t("openInNewWindow")}</span>
          </Button>
          <Button
            className="size-8 text-muted-foreground"
            onClick={panel.onClose}
            size="icon-sm"
            title={t("closeSubagent")}
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
            <span className="sr-only">{t("closeSubagent")}</span>
          </Button>
        </div>
      </div>
      {/* Keyed by thread so switching sub-agents loads a fresh document. */}
      <iframe
        key={panel.threadId}
        className="min-h-0 w-full flex-1 border-0 bg-background"
        src={buildEmbedThreadPath(panel.threadId)}
        title={t("iframeTitle", { title })}
      />
    </aside>
  );
}
