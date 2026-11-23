"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  useAssistant,
  useAssistantFeed,
  useAssistantMembers,
  useAssistantTickets,
  viewerStanding,
} from "../../../../lib/assistant";
import { authClient } from "../../../../lib/auth-client";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { AssistantMenu } from "./assistant-menu";
import { EnableCard } from "./enable-card";
import { FeedComposer } from "./feed-composer";
import { FeedList } from "./feed-list";
import { memberName } from "./member-name";
import { TicketList } from "./ticket-list";

export function AssistantPage() {
  const t = useTranslations("dashboardAssistant");
  const params = useSearchParams();
  const { workspaceId, hasWorkspaceHydrated } = useDashboardChatState();
  const { data: session } = authClient.useSession();
  const viewerId = session?.user?.id ?? null;
  const assistantQuery = useAssistant(workspaceId);
  const assistant = assistantQuery.data ?? null;
  const membersQuery = useAssistantMembers(workspaceId);
  const members = membersQuery.data ?? [];
  const { isAdmin, canWrite } = viewerStanding(members, viewerId);
  const feed = useAssistantFeed(workspaceId, Boolean(assistant));
  const tickets = useAssistantTickets(workspaceId, Boolean(assistant));

  // Loading until the first answers: `isPending`, so a query paused for the
  // network does not read as "not enabled". With no workspace the queries
  // never run, so that case is not loading. The members decide whether the
  // viewer is an admin and who the steward is, so the page waits for them
  // too rather than show "ask an admin" or "a former member" in the meantime.
  const loading =
    !hasWorkspaceHydrated ||
    (Boolean(workspaceId) &&
      (assistantQuery.isPending || membersQuery.isPending));

  const steward =
    !loading && assistant
      ? (memberName(members, assistant.stewardUserId) ?? t("feed.formerMember"))
      : null;
  const disabledReason = !assistant
    ? null
    : assistant.status === "paused"
      ? t("composer.paused")
      : !canWrite && members.length > 0
        ? t("composer.readOnly")
        : null;
  const feedItems = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{t("page.title")}</h1>
            {assistant ? (
              <Badge
                variant={
                  assistant.status === "active" ? "default" : "secondary"
                }
              >
                {t(`status.${assistant.status}`)}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{t("page.subtitle")}</p>
          {steward ? (
            <p className="text-xs text-muted-foreground">
              {t("page.steward", { name: steward })}
            </p>
          ) : null}
          {assistant?.statusReason ? (
            <p className="text-xs text-destructive" role="status">
              {t(`statusReason.${assistant.statusReason}`)}
            </p>
          ) : null}
        </div>
        {assistant && !loading ? (
          <AssistantMenu
            assistant={assistant}
            workspaceId={workspaceId}
            isAdmin={isAdmin}
            canWrite={canWrite}
            members={members}
          />
        ) : null}
      </header>

      {loading ? (
        <p
          className="text-sm text-muted-foreground"
          role="status"
          aria-busy="true"
        >
          {t("page.loading")}
        </p>
      ) : assistantQuery.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("page.loadError")}
        </p>
      ) : !assistant ? (
        <EnableCard workspaceId={workspaceId} isAdmin={isAdmin} />
      ) : (
        <div className="grid min-h-0 gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
          <section className="flex min-w-0 flex-col gap-3">
            <h2 className="text-sm font-medium">{t("page.feedHeading")}</h2>
            {feed.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {t("feed.loadError")}
              </p>
            ) : feed.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t("page.loading")}
              </p>
            ) : (
              <FeedList
                items={feedItems}
                tickets={tickets.data ?? []}
                members={members}
                viewerId={viewerId}
                hasOlder={Boolean(feed.hasNextPage)}
                loadingOlder={Boolean(feed.isFetchingNextPage)}
                onLoadOlder={() => void feed.fetchNextPage()}
              />
            )}
            <FeedComposer
              workspaceId={workspaceId}
              disabledReason={disabledReason}
            />
          </section>
          <aside className="flex min-w-0 flex-col gap-3">
            <h2 className="text-sm font-medium">{t("page.ticketsHeading")}</h2>
            {tickets.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {t("tickets.loadError")}
              </p>
            ) : tickets.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t("page.loading")}
              </p>
            ) : (
              <TicketList
                workspaceId={workspaceId}
                tickets={tickets.data ?? []}
                members={members}
                canWrite={canWrite}
                viewerId={viewerId}
                highlightTicketId={params.get("ticket")}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
