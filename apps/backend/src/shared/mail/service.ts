import { config } from "../config";
import { logger } from "../logger";
import { PlunkApiProvider } from "./providers/plunk-provider";
import type { MailProvider, MailRecipient, MailSendInput, MailSendResult } from "./types";

function createProvider(): MailProvider {
  const provider = config.mail.provider.toLowerCase();
  if (provider === "plunk") {
    return new PlunkApiProvider();
  }

  throw new Error(`Unsupported mail provider: ${config.mail.provider}`);
}

export class MailService {
  private readonly provider: MailProvider;

  constructor(provider: MailProvider = createProvider()) {
    this.provider = provider;
  }

  private extractRecipients(recipient: MailRecipient | MailRecipient[]): string[] {
    if (Array.isArray(recipient)) {
      return recipient.map((r) => (typeof r === "string" ? r : r.email));
    }
    return typeof recipient === "string" ? [recipient] : [recipient.email];
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    const startTime = Date.now();
    const to = this.extractRecipients(input.to);
    try {
      const result = await this.provider.send(input);
      const duration = Date.now() - startTime;
      logger.info("Mail sent", {
        provider: result.provider,
        messageType: input.messageType,
        requestId: result.requestId,
        messageCount: result.messageIds.length,
        duration,
        to,
      });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error("Mail send failed", {
        provider: config.mail.provider,
        messageType: input.messageType,
        duration,
        error: error instanceof Error ? error.message : String(error),
        to,
      });
      throw error;
    }
  }
}

export const mailService = new MailService();
