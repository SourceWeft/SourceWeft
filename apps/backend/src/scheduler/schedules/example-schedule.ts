import { logger } from "../../shared/logger";
import { jobsQueue } from "../../shared/queue";

export async function scheduleExampleJob() {
  const job = await jobsQueue.add("example", {
    scheduledBy: "example-schedule",
    createdAt: new Date().toISOString(),
  });

  logger.info("Scheduled job created", {
    jobId: String(job.id),
    type: job.name,
  });

  return job;
}
