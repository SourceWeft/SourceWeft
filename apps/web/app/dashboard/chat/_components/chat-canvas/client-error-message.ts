/**
 * Turn a raw error string into something worth showing a person.
 *
 * Tool-call failures arrive carrying the model's malformed arguments and the
 * schema that rejected them — `kwargs` dumps, "Received tool input did not
 * match expected schema", zod's "Invalid input: expected … received …". None of
 * that helps the reader, and it leaks the prompt surface, so it collapses to a
 * retry hint naming the tool when the tool name can be recovered.
 *
 * Everything else passes through, trimmed and capped at 600 characters.
 *
 * This lives in `chat-canvas` rather than beside its busiest caller because
 * `_thread/message-normalizers` already imports from `chat-canvas`; putting it
 * there and importing back would close an import cycle.
 *
 * The backend keeps its own copy (`content/model-gateway-error.ts`) on purpose:
 * front end and backend share runtime code only through `@sourceweft/contracts`,
 * and that copy takes a non-nullable `string` rather than returning `null` for
 * empty input.
 */
import type { useTranslations } from "next-intl";

type Translate = ReturnType<typeof useTranslations>;

export function sanitizeClientErrorMessage(
  value: string | null | undefined,
  t?: Translate,
) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (t) {
    const localMessages: Record<string, string> = {
      "Failed to send message.": "errors.sendFailed",
      "Tool execution failed.": "errors.toolExecutionFailed",
      "The generated tool arguments were invalid. Please retry.":
        "errors.toolArgsInvalid",
    };
    const key = Object.hasOwn(localMessages, text) ? localMessages[text] : undefined;
    if (key) return t(key);
    // Data normalizers have already removed unsafe argument dumps. Translate
    // their stable retry hint at display time, including historical messages.
    const named = text.match(
      /^(.+) failed because the generated tool arguments were invalid\. Please retry\.$/,
    );
    if (named) return t("errors.toolArgsInvalidNamed", { tool: named[1]! });
  }
  if (
    /Error invoking tool/i.test(text) ||
    /Received tool input did not match expected schema/i.test(text) ||
    /\bkwargs\b/i.test(text) ||
    /Invalid input: expected .*received/i.test(text)
  ) {
    const toolName =
      text.match(/tool ['"]([^'"]+)['"]/i)?.[1] ??
      text.match(/\btool[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
    // `t` is optional so the pure data-normalizer callers (message-groups,
    // message-normalizers, streaming-event-handlers) — which have no translator
    // in reach — keep producing the original English. The UI re-sanitizes at
    // render time (message-list) with a real translator, so displayed copy is
    // still localized. The English fallbacks below are byte-identical to the
    // en.json `errors.toolArgsInvalid*` values.
    if (toolName) {
      return t
        ? t("errors.toolArgsInvalidNamed", { tool: toolName })
        : `${toolName} failed because the generated tool arguments were invalid. Please retry.`;
    }
    return t
      ? t("errors.toolArgsInvalid")
      : "The generated tool arguments were invalid. Please retry.";
  }
  return text.length > 600 ? `${text.slice(0, 597).trimEnd()}...` : text;
}
