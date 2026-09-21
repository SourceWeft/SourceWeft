import { config } from "../../shared/config";

/** Providers that accept a message and deliver it to nobody. */
const NON_DELIVERING_MAIL_PROVIDERS = new Set(["console", "noop"]);

/**
 * Whether this deployment can actually put a message in someone's inbox.
 *
 * The default provider only logs that a message was skipped, which is what a
 * self-hosted install runs until its operator configures real mail. Anything
 * that waits for the user to act on an email — verifying an address before the
 * first sign-in, above all — must not be demanded there: the mail never
 * arrives, and the person is locked out of their own installation.
 */
export function mailDeliveryConfigured(
  provider: string = config.mail.provider,
): boolean {
  return !NON_DELIVERING_MAIL_PROVIDERS.has(provider.trim().toLowerCase());
}
