"use client";

import * as React from "react";
import { FileText, Loader2, RotateCw, Trash2 } from "lucide-react";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient } from "../../../../lib/sdk";
import { SkillIcon } from "../../_components/dashboard-icons";

type SkillCatalogItem = Awaited<
  ReturnType<typeof contentClient.listSkillsCatalog>
>["items"][number];

type SkillCatalogDetail = Awaited<
  ReturnType<typeof contentClient.getSkillCatalogDetail>
>;

function publisherLabel(sourceType: SkillCatalogItem["sourceType"]) {
  if (sourceType === "builtin") return "Official";
  if (sourceType === "team_custom") return "Team";
  return "Workspace";
}

function visibilityLabel(visibility: SkillCatalogItem["visibility"]) {
  return visibility.charAt(0).toUpperCase() + visibility.slice(1);
}

function readmeFallback(item: SkillCatalogItem) {
  return [`# ${item.displayName}`, "", item.description].join("\n");
}

function SkillAvatar({ item }: { item: SkillCatalogItem }) {
  const palette =
    item.sourceType === "builtin"
      ? "from-sky-500/90 via-cyan-500/80 to-emerald-500/85"
      : "from-violet-500/90 via-fuchsia-500/80 to-rose-500/80";

  return (
    <span
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-linear-to-br text-white shadow-sm",
        palette,
      )}
    >
      <span className="absolute inset-0 bg-black/10" />
      <SkillIcon className="relative size-4.5 drop-shadow" />
    </span>
  );
}

export function SkillDetailDialog({
  item,
  onInstall,
  onOpenChange,
  onUninstall,
  pending,
  workspaceId,
}: {
  item: SkillCatalogItem | null;
  onInstall: (item: SkillCatalogItem) => void;
  onOpenChange: (open: boolean) => void;
  onUninstall: (item: SkillCatalogItem) => void;
  pending: boolean;
  workspaceId: string | null;
}) {
  const [detail, setDetail] = React.useState<SkillCatalogDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const generationRef = React.useRef(0);

  React.useEffect(() => {
    const generation = ++generationRef.current;
    if (!item || !workspaceId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    setDetail(null);
    setError(null);
    setLoading(true);
    void contentClient
      .getSkillCatalogDetail(workspaceId, item.catalogId)
      .then((result) => {
        if (generationRef.current !== generation) return;
        setDetail(result);
      })
      .catch((loadError) => {
        if (generationRef.current !== generation) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load skill details.",
        );
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
  }, [item, reloadKey, workspaceId]);

  const activeItem = detail?.skill ?? item;
  const canManageInstall = activeItem?.installable !== false;
  const readmeContent = activeItem
    ? (detail?.readmeContent ?? readmeFallback(activeItem))
    : "";

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[calc(100svh-2rem)] w-[min(1080px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b border-border px-5 py-4 pr-16 text-left">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {activeItem ? <SkillAvatar item={activeItem} /> : null}
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {activeItem?.displayName ?? "Skill details"}
                </DialogTitle>
                <DialogDescription className="mt-1 line-clamp-2 text-xs">
                  {activeItem?.description ?? "Loading skill details."}
                </DialogDescription>
              </div>
            </div>
            {activeItem && canManageInstall ? (
              <Button
                className="mr-3 h-8 shrink-0 px-3 text-xs"
                disabled={pending}
                onClick={() =>
                  activeItem.enabled
                    ? onUninstall(activeItem)
                    : onInstall(activeItem)
                }
                size="sm"
                type="button"
                variant={activeItem.enabled ? "secondary" : "default"}
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : activeItem.enabled ? (
                  <Trash2 className="size-4" />
                ) : (
                  <SkillIcon className="size-4" />
                )}
                {activeItem.enabled ? "Uninstall" : "Install"}
              </Button>
            ) : null}
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading skill...
            </div>
          ) : error ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-5 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                onClick={() => setReloadKey((current) => current + 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RotateCw className="size-4" />
                Retry
              </Button>
            </div>
          ) : activeItem ? (
            <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
              <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
                <Tabs className="gap-0" defaultValue="readme">
                  <div className="border-b border-border px-5 py-3">
                    <TabsList className="h-8" variant="line">
                      <TabsTrigger className="px-2.5 text-xs" value="readme">
                        README
                      </TabsTrigger>
                      <TabsTrigger className="px-2.5 text-xs" value="skill">
                        SKILL.md
                      </TabsTrigger>
                    </TabsList>
                  </div>
                  <TabsContent className="m-0 px-5 py-5" value="readme">
                    <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                      {readmeContent}
                    </MessageResponse>
                  </TabsContent>
                  <TabsContent className="m-0 px-5 py-5" value="skill">
                    {detail?.skillContent ? (
                      <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                        {detail.skillContent}
                      </MessageResponse>
                    ) : (
                      <div className="py-10 text-sm text-muted-foreground">
                        This skill does not include SKILL.md content.
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </article>

              <aside className="h-fit rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">
                    Details
                  </h2>
                </div>
                <dl className="mt-3 space-y-3 text-xs">
                  {[
                    ["Name", activeItem.name],
                    ["Publisher", publisherLabel(activeItem.sourceType)],
                    ["Version", activeItem.version],
                    ["Visibility", visibilityLabel(activeItem.visibility)],
                    [
                      "README",
                      activeItem.hasReadme ? "Included" : "Not included",
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-words font-medium text-foreground">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
                  <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                    {publisherLabel(activeItem.sourceType)}
                  </Badge>
                  {activeItem.enabled && canManageInstall ? (
                    <Badge
                      className="h-5 px-1.5 text-[10px]"
                      variant="secondary"
                    >
                      Installed
                    </Badge>
                  ) : null}
                  {!canManageInstall ? (
                    <Badge
                      className="h-5 px-1.5 text-[10px]"
                      variant="secondary"
                    >
                      Built-in
                    </Badge>
                  ) : null}
                </div>
              </aside>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
