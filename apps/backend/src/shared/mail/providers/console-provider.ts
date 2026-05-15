import { logger } from "../../logger";
import type { MailProvider, MailSendInput, MailSendResult } from "../types";

export class ConsoleMailProvider implements MailProvider {
  async send(input: MailSendInput): Promise<MailSendResult> {
    const recipients = Array.isArray(input.to) ? input.to : [input.to];
    logger.info("Mail provider is console; skipping external send", {
      messageType: input.messageType,
      subject: input.subject,
      to: recipients.map((recipient) =>
        typeof recipient === "string" ? recipient : recipient.email,
      ),
    });

    return {
      accepted: true,
      provider: "console",
      messageIds: [],
    };
  }
}
