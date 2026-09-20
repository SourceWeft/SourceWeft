export type MailMessageType =
  | "auth.welcome"
  | "auth.verify-email"
  | "auth.email-otp"
  | "auth.two-factor-otp"
  | "auth.reset-password"
  | "auth.magic-link"
  | "auth.change-email"
  | "auth.delete-account"
  | "org.invitation"
  | "workspace.guest-invitation"
  | "ops.alert"
  | "biz.notification";

export type MailRecipient =
  | string
  | {
      name?: string;
      email: string;
    };

export type MailSendInput = {
  to: MailRecipient | MailRecipient[];
  subject: string;
  html: string;
  text?: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  messageType: MailMessageType;
};

export type MailSendResult = {
  accepted: boolean;
  provider: string;
  requestId?: string;
  messageIds: string[];
};

export type TemplateMailSendInput = {
  to: MailRecipient | MailRecipient[];
  templateId: string;
  variables?: Record<string, unknown>;
  messageType: MailMessageType;
  /**
   * Locale used to pick a `<id>.<locale>.html` template variant (design §16.7).
   * Falls back to the English `<id>.html` when omitted or when no variant
   * exists, so English stays the default.
   */
  locale?: string;
};

export interface MailProvider {
  send(input: MailSendInput): Promise<MailSendResult>;
}
