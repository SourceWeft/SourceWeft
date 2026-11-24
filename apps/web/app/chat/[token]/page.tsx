import type { Metadata } from "next";
import { headers } from "next/headers";
import type { PublicSharedChatResponse } from "@sourceweft/contracts";
import { SharedChatUnavailable, SharedChatView } from "./shared-chat-view";

export const dynamic = "force-dynamic";

import { internalApiBaseUrl } from "../../../lib/internal-api-base-url";

/**
 * The visitor's client-IP headers, the only request headers forwarded to
 * the API. This server-side fetch is the request the API counts as a view,
 * and its throttle keys on these headers; without them every visitor
 * collapses into one "unknown" client. A spoofed value can only skew a
 * view count.
 */
const FORWARDED_CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

async function forwardedClientIpHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_CLIENT_IP_HEADERS) {
    const value = incoming.get(name);
    if (value) forwarded[name] = value;
  }
  return forwarded;
}

async function fetchShare(
  token: string,
): Promise<PublicSharedChatResponse["chat"] | null> {
  try {
    const res = await fetch(
      `${internalApiBaseUrl()}/v1/public/shares/${encodeURIComponent(token)}/chat`,
      { cache: "no-store", headers: await forwardedClientIpHeaders() },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as PublicSharedChatResponse;
    return body.chat ?? null;
  } catch {
    return null;
  }
}

/** First user message's text, whitespace-collapsed, for the SEO description. */
function firstUserMessageSummary(
  chat: NonNullable<PublicSharedChatResponse["chat"]>,
): string | undefined {
  const first = chat.messages.find((message) => message.role === "user");
  if (!first) return undefined;
  const collapsed = first.content.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, 160) : undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const chat = await fetchShare(token);

  if (!chat) {
    return { title: "Shared chat", robots: { index: false } };
  }

  return {
    title: chat.title,
    description: firstUserMessageSummary(chat),
    // The share token lives in this page's URL; keep it out of the Referer
    // header on any outbound navigation/subresource so it can't leak to
    // third parties, exactly like the artifact share page.
    referrer: "no-referrer",
    robots: { index: !chat.noindex, follow: !chat.noindex },
  };
}

export default async function SharedChatPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const chat = await fetchShare(token);

  if (!chat) {
    // A revoked, expired, or never-shared token shows an in-page notice, not
    // a 404: stopping a share is a deliberate, reversible action, and
    // re-sharing keeps the same token (Task 7's browser check relies on
    // this), so the link should keep resolving to a 200.
    return <SharedChatUnavailable />;
  }

  return <SharedChatView chat={chat} />;
}
