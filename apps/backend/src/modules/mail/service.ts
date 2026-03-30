import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { PlunkApiProvider } from "./providers/plunk-provider";
import type { MailProvider, MailSendInput, MailSendResult } from "./types";

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

  async send(input: MailSendInput): Promise<MailSendResult> {
    const result = await this.provider.send(input);
    logger.info("Mail sent", {
      provider: result.provider,
      messageType: input.messageType,
      requestId: result.requestId,
      messageCount: result.messageIds.length,
    });
    return result;
  }
}

export const mailService = new MailService();
