"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type {
  Assistant,
  AssistantFeedItem,
  AssistantTicket,
} from "@sourceweft/contracts/assistants";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
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
import { AssistantSummary } from "./assistant-summary";
import { DecisionList } from "./decision-list";
import { FeedComposer } from "./feed-composer";
import { FeedList } from "./feed-list";
import { AssistantWelcome } from "./assistant-welcome";
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
    <AssistantView
      assistant={assistant}
      loading={loading}
      loadError={assistantQuery.isError}
      steward={steward}
      workspaceId={workspaceId}
      isAdmin={isAdmin}
      canWrite={canWrite}
      members={members}
      viewerId={viewerId}
      disabledReason={disabledReason}
      highlightTicketId={params.get("ticket")}
      feed={{
        items: feedItems,
        isError: feed.isError,
        isPending: feed.isPending,
        hasOlder: Boolean(feed.hasNextPage),
        loadingOlder: Boolean(feed.isFetchingNextPage),
        onLoadOlder: () => void feed.fetchNextPage(),
      }}
      tickets={{
        items: tickets.data ?? [],
        isError: tickets.isError,
        isPending: tickets.isPending,
      }}
    />
  );
}

export type AssistantViewProps = {
  assistant: Assistant | null;
  loading: boolean;
  loadError: boolean;
  steward: string | null;
  workspaceId: string | null;
  isAdmin: boolean;
  canWrite: boolean;
  members: readonly WorkspaceMember[];
  viewerId: string | null;
  disabledReason: string | null;
  highlightTicketId: string | null;
  feed: {
    items: readonly AssistantFeedItem[];
    isError: boolean;
    isPending: boolean;
    hasOlder: boolean;
    loadingOlder: boolean;
    onLoadOlder: () => void;
  };
  tickets: {
    items: readonly AssistantTicket[];
    isError: boolean;
    isPending: boolean;
  };
};

/** What the page shows for a given state; it fetches nothing itself. */
export function AssistantView({
  assistant,
  loading,
  loadError,
  steward,
  workspaceId,
  isAdmin,
  canWrite,
  members,
  viewerId,
  disabledReason,
  highlightTicketId,
  feed,
  tickets,
}: AssistantViewProps) {
  const t = useTranslations("dashboardAssistant");
  // On a phone the two columns become two tabs; a notification that points at
  // a ticket opens on the tickets.
  const [view, setView] = React.useState<"activity" | "tickets">(() =>
    highlightTicketId ? "tickets" : "activity",
  );
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [section, setSection] = React.useState<"chat" | "decisions">("chat");
  const [seed, setSeed] = React.useState<{ id: number; text: string } | null>(
    null,
  );
  // A workspace that has never used the assistant: nothing to list, so the
  // page greets instead of showing two empty columns.
  const fresh =
    !feed.isPending &&
    !feed.isError &&
    !tickets.isPending &&
    !tickets.isError &&
    feed.items.length === 0 &&
    tickets.items.length === 0;
  const openTickets = tickets.items.filter(
    (ticket) => ticket.stage !== "ended",
  );
  const needsPerson = openTickets.filter(
    (ticket) => ticket.stage === "waiting_person",
  ).length;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 pt-4 md:px-6 md:pt-6">
      <header className="flex items-start justify-between gap-3 pb-3 md:pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-lg font-semibold tracking-tight md:text-xl">
              {t("page.title")}
            </h1>
            {assistant ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    assistant.status === "active"
                      ? "bg-emerald-500"
                      : "bg-amber-500",
                  )}
                  aria-hidden
                />
                {t(`status.${assistant.status}`)}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground max-md:hidden">
            {t("page.subtitle")}
          </p>
          {steward ? (
            <p className="text-xs text-muted-foreground md:mt-0.5">
              {t("page.steward", { name: steward })}
            </p>
          ) : null}
          {assistant?.statusReason ? (
            <p className="mt-1 text-xs text-destructive" role="status">
              {t(`statusReason.${assistant.statusReason}`)}
            </p>
          ) : null}
        </div>
        {assistant && !loading ? (
          <div className="flex items-center gap-1">
            {fresh ? null : (
              <button
                type="button"
                aria-pressed={panelOpen}
                aria-label={t("page.toggleTickets")}
                title={t("page.toggleTickets")}
                className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground max-md:hidden"
                onClick={() => setPanelOpen((open) => !open)}
              >
                {panelOpen ? (
                  <PanelRightClose className="size-4" aria-hidden />
                ) : (
                  <PanelRightOpen className="size-4" aria-hidden />
                )}
              </button>
            )}
            <AssistantMenu
              assistant={assistant}
              workspaceId={workspaceId}
              isAdmin={isAdmin}
              canWrite={canWrite}
              members={members}
            />
          </div>
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
      ) : loadError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("page.loadError")}
        </p>
      ) : !assistant ? (
        <EnableCard workspaceId={workspaceId} isAdmin={isAdmin} />
      ) : (
        <>
          {fresh ? null : (
            <>
              <div
                role="tablist"
                aria-label={t("sections.label")}
                className="mb-3 flex gap-4 border-b border-border/60"
              >
                {(["chat", "decisions"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    data-section={key}
                    aria-selected={section === key}
                    className={cn(
                      "-mb-px border-b-2 px-0.5 pb-2 text-sm font-medium transition-colors",
                      section === key
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setSection(key)}
                  >
                    {t(`sections.${key}`)}
                  </button>
                ))}
              </div>
              <AssistantSummary
                assistant={assistant}
                workspaceId={workspaceId}
                canWrite={canWrite}
                tickets={tickets.items}
                onShowTickets={() => {
                  setSection("chat");
                  setPanelOpen(true);
                  setView("tickets");
                }}
              />
            </>
          )}
          {section === "decisions" && !fresh ? (
            <DecisionList workspaceId={workspaceId} members={members} />
          ) : null}
          {fresh || section !== "chat" ? null : (
            <div
              role="tablist"
              className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1 md:hidden"
            >
              {(["activity", "tickets"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  data-view-tab={key}
                  aria-selected={view === key}
                  className={cn(
                    "flex h-9 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors",
                    view === key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setView(key)}
                >
                  {key === "activity"
                    ? t("page.feedHeading")
                    : t("page.ticketsHeading")}
                  {key === "tickets" && openTickets.length > 0 ? (
                    <span
                      className={cn(
                        "min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums",
                        needsPerson > 0
                          ? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                          : "bg-foreground/10 text-muted-foreground",
                      )}
                    >
                      {needsPerson > 0 ? needsPerson : openTickets.length}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
          {section === "chat" ? (
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                !fresh &&
                  panelOpen &&
                  "md:grid md:grid-cols-[minmax(0,1fr)_19rem] md:gap-4",
              )}
            >
              <section
                className={cn(
                  "flex min-h-0 min-w-0 flex-1 flex-col",
                  view === "tickets" && "max-md:hidden",
                )}
              >
                <h2
                  className={cn(
                    "pb-1 text-xs font-medium text-muted-foreground max-md:hidden",
                    fresh && "md:hidden",
                  )}
                >
                  {t("page.feedHeading")}
                </h2>
                {feed.isError ? (
                  <p className="text-sm text-destructive" role="alert">
                    {t("feed.loadError")}
                  </p>
                ) : feed.isPending ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    {t("page.loading")}
                  </p>
                ) : fresh ? (
                  <AssistantWelcome
                    disabled={Boolean(disabledReason)}
                    onPick={(text) =>
                      setSeed((current) => ({
                        id: (current?.id ?? 0) + 1,
                        text,
                      }))
                    }
                  />
                ) : (
                  <FeedList
                    items={feed.items}
                    tickets={tickets.items}
                    members={members}
                    viewerId={viewerId}
                    hasOlder={feed.hasOlder}
                    loadingOlder={feed.loadingOlder}
                    onLoadOlder={feed.onLoadOlder}
                  />
                )}
                <FeedComposer
                  workspaceId={workspaceId}
                  disabledReason={disabledReason}
                  seed={seed}
                />
              </section>
              {fresh ? null : (
                <aside
                  className={cn(
                    "flex min-h-0 min-w-0 flex-col overflow-y-auto pb-4 md:mb-4 md:rounded-2xl md:border md:border-border md:bg-card md:p-3",
                    view === "activity" && "max-md:hidden",
                    !panelOpen && "md:hidden",
                  )}
                >
                  <h2 className="flex items-center gap-2 px-2 pb-2 text-sm font-medium max-md:hidden">
                    {t("page.ticketsHeading")}
                    {openTickets.length > 0 ? (
                      <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                        {openTickets.length}
                      </span>
                    ) : null}
                  </h2>
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
                      tickets={tickets.items}
                      members={members}
                      canWrite={canWrite}
                      viewerId={viewerId}
                      highlightTicketId={highlightTicketId}
                    />
                  )}
                </aside>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
