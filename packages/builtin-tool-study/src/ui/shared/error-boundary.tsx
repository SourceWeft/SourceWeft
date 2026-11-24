"use client";

import { Component, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { useStudyHost } from "../study-host";

/** The "cannot display this artifact" panel, shared by the boundary and invalid payloads. */
export function StudyCannotDisplay() {
  const t = useStudyHost().useTranslate();
  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
      role="alert"
    >
      <CircleAlert aria-hidden className="size-5" />
      <p>{t("study.error.cannotDisplay")}</p>
    </div>
  );
}

/** Keeps one broken item from blanking the panel: anything that throws while rendering shows the message instead. */
export class StudyErrorBoundary extends Component<
  { children?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <StudyCannotDisplay /> : this.props.children;
  }
}
