import { Queue, QueueEvents } from "bullmq";
import { config } from "./config";
import { buildAuditInputFromJob, recordJobAudit } from "./jobs-audit";
import { connectionOptions } from "./redis-connection";

export type QueueJobPayload = Record<string, unknown>;

let jobsQueueInstance: Queue<QueueJobPayload, unknown, string> | null = null;
let deliverablesQueueInstance: Queue<QueueJobPayload, unknown, string> | null =
  null;

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

export function getDeliverablesQueue() {
  deliverablesQueueInstance ??= new Queue<QueueJobPayload, unknown, string>(
    config.deliverablesQueueName,
    {
      connection: connectionOptions,
    },
  );
  return deliverablesQueueInstance;
}

export const deliverablesQueue = new Proxy(
  {} as Queue<QueueJobPayload, unknown, string>,
  {
    get(_target, property) {
      const queue = getDeliverablesQueue();
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

export async function enqueueWithAudit(
  type: string,
  payload: Record<string, unknown>,
  opts?: Parameters<Queue<QueueJobPayload>["add"]>[2],
  target: {
    queue?: Queue<QueueJobPayload, unknown, string>;
    queueName?: string;
  } = {},
) {
  const queue = target.queue ?? jobsQueue;
  const job = await queue.add(type, payload, opts);

  void recordJobAudit(
    buildAuditInputFromJob({
      jobId: String(job.id),
      jobType: type,
      data: payload,
      queueName: target.queueName ?? config.queueName,
      status: "queued",
    }),
  );

  return job;
}

export async function closeQueue() {
  await Promise.all([
    jobsQueueInstance?.close() ?? Promise.resolve(),
    deliverablesQueueInstance?.close() ?? Promise.resolve(),
    jobsQueueEvents?.close() ?? Promise.resolve(),
  ]);
  jobsQueueInstance = null;
  deliverablesQueueInstance = null;
  jobsQueueEvents = null;
}
