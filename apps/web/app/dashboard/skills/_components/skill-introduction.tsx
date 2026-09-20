"use client";

import { useTranslations } from "next-intl";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import {
  resolveSkillIntroduction,
  type SkillIntroductionInput,
} from "../../../../lib/skill-introduction";

export function SkillIntroduction(props: SkillIntroductionInput) {
  const t = useTranslations("dashboardSkills");
  const introduction = resolveSkillIntroduction(props);
  return (
    <div className="min-w-0 space-y-4">
      {introduction.source ? (
        <p className="text-xs text-muted-foreground">
          {t("introduction.from", { source: introduction.source })}
        </p>
      ) : null}
      {introduction.content ? (
        <MessageResponse
          mode="static"
          className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left"
        >
          {introduction.content}
        </MessageResponse>
      ) : (
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">{props.displayName}</h3>
          <p>{props.description}</p>
          <p className="text-muted-foreground">
            {t("introduction.noDescription")}
          </p>
        </div>
      )}
    </div>
  );
}
