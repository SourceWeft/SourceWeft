import { sendWelcomeEmail } from "../../modules/onboarding/welcome-email";

/** Thin wrapper: the worker queue hands this a job, the module does the work. */
export async function processWelcomeEmailJob(job: {
  data: Record<string, unknown>;
}): Promise<{ result: "sent" | "skipped" }> {
  const result = await sendWelcomeEmail(job.data);
  return { result };
}
