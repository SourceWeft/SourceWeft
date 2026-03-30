import { Queue } from "bullmq";
import { config } from "./config";
import { connectionOptions } from "./redis-connection";

export type QueueJobPayload = Record<string, unknown>;

export const jobsQueue = new Queue<QueueJobPayload, unknown, string>(
  config.queueName,
  {
    connection: connectionOptions,
  },
);

export async function closeQueue() {
  await jobsQueue.close();
}
