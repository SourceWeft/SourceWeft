import { useTranslations } from "next-intl";

import { LocaleLink } from "../../_components/locale-link";
import { methodSectionPath } from "./method-path";

/**
 * The line under an AI overview, a score or scan notes that leads to the part
 * of the method page explaining it. Synchronous, so it renders from server
 * and client parents alike.
 */
export function MethodLink({
  className = "",
  topic,
}: {
  className?: string;
  topic: "overview" | "score" | "scan";
}) {
  const t = useTranslations("method.links");
  const section = topic === "overview" ? "overviews" : topic;
  return (
    <p className={`text-xs ${className}`}>
      <LocaleLink
        className="underline underline-offset-4 opacity-80 transition-opacity hover:opacity-100"
        href={methodSectionPath(section)}
      >
        {t(topic)}
      </LocaleLink>
    </p>
  );
}
