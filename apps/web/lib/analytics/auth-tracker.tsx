"use client";

import { useEffect, useRef } from "react";

import { authClient } from "../auth-client";
import { classifyAuthEvent, consumeAuthIntent } from "./auth-intent";
import { trackLogin, trackSignUp } from "./events";

/** Reports sign_up or login when a session appears after a recorded intent. */
export function AuthAnalyticsTracker() {
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const userId = user?.id ?? null;
  const createdAt = user?.createdAt;
  const handledUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || handledUserId.current === userId) {
      return;
    }
    handledUserId.current = userId;
    const intent = consumeAuthIntent();
    if (!intent) {
      return;
    }
    if (classifyAuthEvent(createdAt) === "sign_up") {
      trackSignUp(intent.method);
    } else {
      trackLogin(intent.method);
    }
  }, [createdAt, userId]);

  return null;
}
