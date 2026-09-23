"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { reportClientError } from "@/lib/client-error-diagnostics";

export function ChatErrorRecovery({
  retry,
  children,
}: {
  retry: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations("chatRecovery");
  return (
    <section
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{t("body")}</p>
      {children}
      <button
        type="button"
        className="rounded-md border px-4 py-2 text-sm focus-visible:outline-2"
        onClick={retry}
      >
        {t("retry")}
      </button>
    </section>
  );
}

/** Key this boundary by conversation so a broken chat cannot poison the next. */
export class MessageRenderBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(error, "messages", info.componentStack);
  }

  render() {
    return this.state.failed ? (
      <ChatErrorRecovery retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
