import type * as React from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";

import {
  CLIENT_NAMESPACES,
  pickMessages,
  type ClientMessageArea,
} from "../../i18n/client-messages";

/**
 * Replaces the root provider's messages with the namespaces this route area's
 * client components read (see `i18n/client-messages.ts`). Locale, time zone and
 * formats are inherited from the request config.
 */
export async function ClientMessagesProvider({
  area,
  children,
}: {
  area: ClientMessageArea;
  children: React.ReactNode;
}) {
  return (
    <NextIntlClientProvider
      messages={pickMessages(await getMessages(), CLIENT_NAMESPACES[area])}
    >
      {children}
    </NextIntlClientProvider>
  );
}
