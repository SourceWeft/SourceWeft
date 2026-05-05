import { Queue, QueueEvents } from "bullmq";
import { config } from "./config";
import { connectionOptions } from "./redis-connection";

export type QueueJobPayload = Record<string, unknown>;

let jobsQueueInstance: Queue<QueueJobPayload, unknown, string> | null = null;

let jobsQueueEvents: QueueEvents | null = null;

export function getJobsQueue() {
  jobsQueueInstance ??= new Queue<QueueJobPayload, unknown, string>(
    config.queueName,
    {
      connection: connectionOptions,
    },
  );
  return jobsQueueInstance;
}

export const jobsQueue = new Proxy(
  {} as Queue<QueueJobPayload, unknown, string>,
  {
    get(_target, property) {
      const queue = getJobsQueue();
      const value =
        queue[property as keyof Queue<QueueJobPayload, unknown, string>];
      return typeof value === "function" ? value.bind(queue) : value;
    },
  },
);

export function getJobsQueueEvents() {
  jobsQueueEvents ??= new QueueEvents(config.queueName, {
    connection: connectionOptions,
  });
  return jobsQueueEvents;
}

export async function closeQueue() {
  await Promise.all([
    jobsQueueInstance?.close() ?? Promise.resolve(),
    jobsQueueEvents?.close() ?? Promise.resolve(),
  ]);
  jobsQueueInstance = null;
  jobsQueueEvents = null;
}
