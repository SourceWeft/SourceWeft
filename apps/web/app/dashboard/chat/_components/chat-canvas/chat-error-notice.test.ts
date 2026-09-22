import assert from "node:assert/strict";
import { test } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import { formatChatErrorMessage } from "./chat-error-notice";
import messages from "../../../../../messages/en.json";

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardChatCanvas",
}) as unknown as ReturnType<typeof useTranslations>;

test("structured-output diagnostics are reduced to user-facing copy", () => {
  assert.equal(
    formatChatErrorMessage(
      "MODEL_STRUCTURED_OUTPUT_INVALID: Provider returned invalid structured output (length=0, sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)",
      "MODEL_STRUCTURED_OUTPUT_INVALID",
      t,
    ),
    "The model did not return valid structured content",
  );
});

for (const locale of ["zh-CN", "zh-TW"] as const) {
  test(`${locale} translates normalized local errors and preserves unrelated backend errors`, async () => {
    const catalog = (await import(`../../../../../messages/${locale}.json`))
      .default;
    const translate = createTranslator({
      locale,
      messages: catalog,
      namespace: "dashboardChatCanvas",
    }) as unknown as ReturnType<typeof useTranslations>;
    assert.equal(
      formatChatErrorMessage("Failed to send message.", null, translate),
      catalog.dashboardChatCanvas.errors.sendFailed,
    );
    assert.equal(
      formatChatErrorMessage("Tool execution failed.", null, translate),
      catalog.dashboardChatCanvas.errors.toolExecutionFailed,
    );
    assert.equal(
      formatChatErrorMessage(
        "The generated tool arguments were invalid. Please retry.",
        null,
        translate,
      ),
      catalog.dashboardChatCanvas.errors.toolArgsInvalid,
    );
    assert.equal(
      formatChatErrorMessage(
        "fetch failed because the generated tool arguments were invalid. Please retry.",
        null,
        translate,
      ),
      translate("errors.toolArgsInvalidNamed", { tool: "fetch" }),
    );
    assert.equal(formatChatErrorMessage("__proto__", null, translate), "__proto__");
    assert.equal(
      formatChatErrorMessage("Upstream quota exceeded", null, translate),
      "Upstream quota exceeded",
    );
  });
}
