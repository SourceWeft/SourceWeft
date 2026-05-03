import { Queue, QueueEvents } from "bullmq";
import { config } from "./config";
import { connectionOptions } from "./redis-connection";

export type QueueJobPayload = Record<string, unknown>;

export const jobsQueue = new Queue<QueueJobPayload, unknown, string>(
  config.queueName,
  {
    connection: connectionOptions,
  },
);

let jobsQueueEvents: QueueEvents | null = null;

export function getJobsQueueEvents() {
  jobsQueueEvents ??= new QueueEvents(config.queueName, {
    connection: connectionOptions,
  });
  return jobsQueueEvents;
}

export async function closeQueue() {
  await Promise.all([
    jobsQueue.close(),
    jobsQueueEvents?.close() ?? Promise.resolve(),
  ]);
  jobsQueueEvents = null;
}
